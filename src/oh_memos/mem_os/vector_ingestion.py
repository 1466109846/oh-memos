"""Confirm raw memory storage, then enrich the same record asynchronously."""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time

from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any
from uuid import NAMESPACE_URL, uuid5

from oh_memos.mem_cube.utils import normalize_path
from oh_memos.mem_os.enrichment import BackgroundEnrichmentWorker, EnrichmentJob
from oh_memos.memories.textual.item import TreeNodeTextualMemoryMetadata


if TYPE_CHECKING:
    from oh_memos.mem_os.core import MOSCore


logger = logging.getLogger(__name__)
MAX_ENRICHMENT_ATTEMPTS = 3


class VectorFirstIngestion:
    def __init__(self, core: MOSCore) -> None:
        self.core = core
        self._closed = threading.Event()
        self._lifecycle_lock = threading.Lock()
        self._recovery_thread: threading.Thread | None = None
        self._excluded_cubes: set[str] = set()
        self.worker = BackgroundEnrichmentWorker(self._pending, self._enrich)

    def start(self) -> None:
        with self._lifecycle_lock:
            if self._closed.is_set():
                return
            if self._recovery_thread is None and hasattr(self.core, "user_manager"):
                self._recovery_thread = threading.Thread(
                    target=self._recover_cubes, name="memos-enrichment-recovery", daemon=True,
                )
                self._recovery_thread.start()
        self.worker.notify()

    def close(self) -> None:
        self._closed.set()
        self.worker.close()
        if self._recovery_thread is not None:
            self._recovery_thread.join(timeout=0.2)

    def exclude_cube(self, cube_id: str) -> None:
        with self._lifecycle_lock:
            self._excluded_cubes.add(cube_id)

    def include_cube(self, cube_id: str) -> None:
        with self._lifecycle_lock:
            self._excluded_cubes.discard(cube_id)

    def can_restore_cube(self, cube_id: str) -> bool:
        with self._lifecycle_lock:
            return not self._closed.is_set() and cube_id not in self._excluded_cubes

    @staticmethod
    def _local_cube_path(stored_path: str | None, cube_id: str) -> str | None:
        if stored_path and stored_path != "init":
            for candidate in (stored_path, normalize_path(stored_path)):
                if candidate and (Path(candidate) / "config.json").is_file():
                    return candidate
        # Registrations can still contain pre-migration Windows paths while
        # the API uses a Docker mount. Resolve them just as on-demand loading
        # does, but only for an existing config within the configured root.
        cubes_dir = os.getenv("MEMOS_CUBES_DIR") or os.getenv("MOS_CUBES_DIR") or os.getenv("MOS_CUBE_PATH")
        if not cubes_dir or not cube_id or "/" in cube_id or "\\" in cube_id:
            return None
        root = Path(cubes_dir)
        if not root.is_absolute():
            root = Path.cwd().parent / root
        root = root.resolve()
        candidate = (root / cube_id).resolve()
        if candidate != root and candidate.is_relative_to(root) and (candidate / "config.json").is_file():
            return str(candidate)
        return None

    def _recover_cubes(self) -> None:
        """Restore local registered projects even if startup loaded only the default."""
        manager = self.core.user_manager
        while not self._closed.is_set():
            try:
                seen: set[str] = set()
                for user in manager.list_users():
                    for record in manager.get_user_cubes(user.user_id):
                        if self._closed.is_set():
                            return
                        cube_id = record.cube_id
                        with self._lifecycle_lock:
                            excluded = cube_id in self._excluded_cubes
                        if excluded or cube_id in seen or cube_id in self.core.mem_cubes:
                            continue
                        seen.add(cube_id)
                        # Resume existing local registrations only. Do not fetch
                        # remote repositories or create missing cube directories.
                        local_path = self._local_cube_path(record.cube_path, cube_id)
                        if not local_path:
                            continue
                        try:
                            self.core.register_mem_cube(
                                local_path, mem_cube_id=cube_id, user_id=user.user_id,
                                _from_recovery=True,
                            )
                            self.worker.notify()
                        except Exception as exc:
                            logger.warning("Could not restore enrichment cube %s: %s", cube_id, type(exc).__name__)
            except Exception as exc:
                logger.warning("Could not read enrichment cube registry: %s", type(exc).__name__)
            self._closed.wait(30.0)

    def save(
        self, cube_id: str, content: str, user_id: str, session_id: str | None,
        *, explicit_session_id: str | None = None, **options: Any,
    ) -> dict:
        text_mem = self.core.mem_cubes[cube_id].text_mem
        graph = text_mem.graph_store
        typed = re.match(r"^\[([A-Z_]{3,24})\]\s", content)
        business_type = options.get("memory_type") or (typed.group(1) if typed else "fact")
        tags = list(dict.fromkeys([business_type, *(options.get("tags") or [])]))
        explicit = {
            key: options[key]
            for key in (
                "confidence", "status", "created_at", "updated_at", "source", "source_ref",
                "imported_from", "capture_stage", "dialogue_id", "turn_index",
            )
            if options.get(key) is not None
        }
        explicit.setdefault("confidence", 0.99)
        explicit.setdefault("status", "activated")
        explicit.setdefault("source", "conversation")
        # Retrying identical input must target the same raw record, including
        # after a process restart. Generated timestamps/session IDs are excluded.
        identity = {
            "cube_id": cube_id, "user_id": user_id, "content": content,
            "type": business_type, "tags": sorted(tags), **explicit,
        }
        if explicit_session_id is not None:
            identity["session_id"] = explicit_session_id
        memory_id = str(uuid5(NAMESPACE_URL, "oh-memos:raw:" + json.dumps(
            identity, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        )))
        embedding = text_mem.embedder.embed([content])[0]
        metadata = TreeNodeTextualMemoryMetadata(
            user_id=user_id, session_id=session_id,
            memory_type="LongTermMemory", type=business_type, tags=tags,
            key=content.splitlines()[0].strip()[:80], embedding=embedding,
            ingestion_mode="vector_first",
            enrichment_status="pending" if explicit["status"] == "activated" else "skipped",
            enrichment_attempts=0, enrichment_retry_after=0.0,
            **explicit,
        ).model_dump(exclude_none=True)
        confirmed_id = graph.add_node_confirmed(memory_id, content, metadata)
        if confirmed_id != memory_id:
            raise RuntimeError("Storage did not confirm the supplied memory ID")

        # Read the existing status on retries without turning a confirmed write
        # into a failure if this optional status read is temporarily unavailable.
        status = None
        try:
            stored = graph.get_node(memory_id)
            if stored:
                status = stored.get("metadata", {}).get("enrichment_status")
        except Exception as exc:
            logger.warning("Could not read enrichment status for %s: %s", memory_id, type(exc).__name__)
        result = {
            "created_ids": [memory_id], "queued": False, "backend": "tree_text",
            "vector_saved": True, "warnings": [],
        }
        if status is not None:
            result["enrichment_status"] = status
        return result

    def _pending(self):
        for cube_id, cube in list(self.core.mem_cubes.items()):
            if self._closed.is_set():
                return
            text_mem = cube.text_mem
            if not text_mem or cube.config.text_mem.backend != "tree_text":
                continue
            try:
                ids = text_mem.graph_store.get_by_metadata([
                    {"field": "status", "op": "=", "value": "activated"},
                    {"field": "memory_type", "op": "=", "value": "LongTermMemory"},
                    {"field": "enrichment_status", "op": "in", "value": ["pending", "failed"]},
                    {"field": "enrichment_attempts", "op": "<", "value": MAX_ENRICHMENT_ATTEMPTS},
                    {"field": "enrichment_retry_after", "op": "<=", "value": time.time()},
                ])
            except Exception as exc:
                # One temporarily unavailable cube must not starve the others.
                logger.warning("Could not scan enrichment for %s: %s", cube_id, type(exc).__name__)
                continue
            for memory_id in ids:
                yield cube_id, memory_id

    def _enrich(self, job: EnrichmentJob) -> None:
        cube_id, memory_id = job
        cube = self.core.mem_cubes.get(cube_id)
        if cube is None or self._closed.is_set():
            return
        graph = cube.text_mem.graph_store
        node = graph.get_node(memory_id)
        if not node:
            return
        metadata = node["metadata"]
        attempts = metadata.get("enrichment_attempts", 0)
        if (
            metadata.get("status") != "activated"
            or metadata.get("enrichment_status") not in ("pending", "failed")
            or attempts >= MAX_ENRICHMENT_ATTEMPTS
            or metadata.get("enrichment_retry_after", 0) > time.time()
        ):
            return
        content = node["memory"]
        attempts += 1
        # Count finished attempts, not calls interrupted by process shutdown.
        # Otherwise a crash during the last attempt leaves permanent pending work.
        if not graph.update_node_if_current(memory_id, content, {
            "enrichment_status": "pending",
        }):
            return
        try:
            parsed = self.core.mem_reader.extract_metadata(content, custom_tags=metadata.get("tags"))
            if self._closed.is_set():
                return
            current = graph.get_node(memory_id)
            if not current or current["memory"] != content:
                return
            current_metadata = current["metadata"]
            tags = list(dict.fromkeys([
                *(current_metadata.get("tags") or []), *(parsed.get("tags") or []),
            ]))
            fields = {key: parsed[key] for key in ("key", "background", "enrichment_items") if key in parsed}
            fields.update(
                tags=tags, enrichment_status="completed", enrichment_attempts=attempts,
                enrichment_retry_after=0.0, enrichment_error="",
                enrichment_completed_at=datetime.now(timezone.utc).isoformat(),
            )
            applied = graph.update_node_if_current(memory_id, content, fields)
        except Exception as exc:
            if not self._closed.is_set():
                graph.update_node_if_current(memory_id, content, {
                    "enrichment_status": "failed", "enrichment_attempts": attempts,
                    "enrichment_retry_after": time.time() + 30 * (2 ** (attempts - 1)),
                    "enrichment_error": type(exc).__name__,
                })
                logger.warning("Memory enrichment failed for %s/%s: %s", cube_id, memory_id, type(exc).__name__)
            return

        if applied and cube.text_mem.is_reorganize:
            # Graph organization can run only after the metadata is available;
            # it is never on the foreground confirmation path.
            from oh_memos.memories.textual.tree_text_memory.organize.reorganizer import QueueMessage

            cube.text_mem.memory_manager.reorganizer.add_message(
                QueueMessage(op="add", after_node=[memory_id])
            )

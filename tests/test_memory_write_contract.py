"""Contract tests for metadata-aware memory writes.

These tests intentionally exercise the boundary models and typed item builder,
not a live Qdrant/Neo4j stack.
"""

import pytest
from threading import Lock

from pydantic import ValidationError

from oh_memos.api.start_api import MemoryCreate
from oh_memos.mem_os.core import MOSCore
from oh_memos.mem_reader.simple_struct import SimpleStructMemReader


def test_memory_create_accepts_round_trip_metadata():
    request = MemoryCreate(
        mem_cube_id="dev_cube",
        memory_content="[BUGFIX] Keep metadata on wiki import",
        memory_type="BUGFIX",
        tags=["wiki", "round-trip"],
        confidence=0.9,
        status="activated",
        created_at="2026-08-16T10:20:30+00:00",
        updated_at="2026-08-16T10:21:30+00:00",
        source="file",
        session_id="session-1",
        source_ref="docs/memory-wiki/pages/BUGFIX/fix.md",
    )

    assert request.memory_type == "BUGFIX"
    assert request.tags == ["wiki", "round-trip"]
    assert request.confidence == 0.9
    assert request.source_ref.endswith("fix.md")


def test_memory_create_rejects_invalid_metadata():
    with pytest.raises(ValidationError):
        MemoryCreate(memory_content="[BUGFIX] x", confidence=1.5)
    with pytest.raises(ValidationError):
        MemoryCreate(memory_content="[BUGFIX] x", status="unknown")
    with pytest.raises(ValidationError):
        MemoryCreate(memory_content="[BUGFIX] x", source="database")
    with pytest.raises(ValidationError):
        MemoryCreate(memory_content="[BUGFIX] x", created_at="tomorrow")


def test_typed_reader_allows_status_and_metadata_overrides(monkeypatch):
    reader = object.__new__(SimpleStructMemReader)

    class FakeEmbedder:
        def embed(self, values):
            return [[0.1, 0.2] for _ in values]

    reader.embedder = FakeEmbedder()
    item = reader._make_memory_item(
        value="[BUGFIX] preserve metadata",
        info={"user_id": "u", "session_id": "s"},
        memory_type="LongTermMemory",
        tags=["BUGFIX", "wiki"],
        confidence=0.88,
        status="archived",
        source="file",
        created_at="2026-08-16T10:20:30+00:00",
    )

    assert item.metadata.status == "archived"
    assert item.metadata.source == "file"
    assert item.metadata.created_at == "2026-08-16T10:20:30+00:00"
    assert item.metadata.tags == ["BUGFIX", "wiki"]
    assert item.metadata.confidence == 0.88


def test_dialogue_fields_reach_the_tree_backend():
    """dialogue_id/turn_index must survive MOSCore.add down to text_mem.add.

    The evaluation harness relies on this trace instead of text markers,
    which the LLM extraction may rewrite.
    """
    received: list[dict] = []

    class CapturingTextMem:
        mode = "sync"

        def add(self, memories, **kwargs):
            received.append({"memories": memories, "kwargs": kwargs})
            return ["m-1"]

    class FakeReader:
        def get_memory(self, messages_list, type, info, mode):
            return [["[PROGRESS] captured turn"]]

    class BackendConfig:
        backend = "tree_text"

    class TextMemConfig:
        backend = "tree_text"

    class CubeConfig:
        text_mem = TextMemConfig()

    class Cube:
        text_mem = CapturingTextMem()
        config = CubeConfig()

    core = object.__new__(MOSCore)
    core.user_id = "dev_user"
    core.session_id = "s"
    core.mem_cubes = {"dev_cube": Cube()}
    core._validate_cube_access = lambda *_a, **_k: None
    core.mem_reader = FakeReader()
    core.config = type("C", (), {"enable_textual_memory": True, "enable_preference_memory": False})()
    core.enable_mem_scheduler = False
    # mem_scheduler's property setter takes this lock; set it first.
    core._mem_scheduler_lock = Lock()
    core.mem_scheduler = None
    core.chat_history_manager = {}

    result = MOSCore.add(
        core,
        messages=[{"role": "user", "content": "hello"}],
        mem_cube_id="dev_cube",
        user_id="dev_user",
        dialogue_id="D1",
        turn_index=3,
    )

    assert result == ["m-1"]
    assert received[0]["kwargs"] == {"dialogue_id": "D1", "turn_index": 3}

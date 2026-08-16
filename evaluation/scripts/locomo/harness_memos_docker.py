"""oh-memos adapter for LOCOMO benchmark — uses Docker Compose API + recall@10.

Runs against the containerized oh-memos stack (Neo4j + Qdrant + FastAPI), so
it measures real-world end-to-end latency including embedding, vector search,
and graph traversal — not just in-memory lookups.

Key differences from other adapters:
- Injects [D<dia_id>:<turn_idx>] markers into turn text before ingestion
- Markers survive in metadata.sources (chat-derived memories retain verbatim)
- Retrieves them post-search via regex to compute recall@10

Tested against http://127.0.0.1:18000 with eval cube `locomo_eval_cube`.
"""
import os
import re
import sys
from collections import defaultdict
from time import time
from typing import Any

import requests

# dia_id -> turn_idx -> set of retrieved [Dx:y] markers from that turn's query
_RECALL_TRACKER: dict[str, dict[int, set[str]]] = defaultdict(lambda: defaultdict(set))

API_BASE = os.getenv("MEMOS_API_BASE", "http://127.0.0.1:18000")
CUBE_ID = "locomo_eval_cube"

# LOCOMO gives us speaker_a / speaker_b but oh-memos needs user_id per request.
# Map speaker name → synthetic user_id. The cube must have these users registered.
SPEAKER_TO_USER = {
    "Donnie": "locomo_donnie",
    "Abigail": "locomo_abigail",
}


def _inject_marker(turn_text: str, dia_id: str, turn_idx: int) -> str:
    """Prepend [D<dia_id>:<turn_idx>] so we can track which turn was retrieved."""
    return f"[D{dia_id}:{turn_idx}] {turn_text}"


def _extract_markers(text: str) -> set[str]:
    """Pull all [D<dia_id>:<turn_idx>] markers from retrieved memory text.

    dia_id may contain letters, numbers, underscores (e.g., test_d1, d123).
    turn_idx is always numeric.
    """
    return set(re.findall(r"\[D[\w]+:\d+\]", text))


def add(
    client: Any,
    dia_id: str,
    turn_idx: int,
    speaker: str,
    turn_text: str,
    timestamp_iso: str,
) -> float:
    """Ingest one turn with [Dx:y] marker, return latency_ms."""
    user_id = SPEAKER_TO_USER.get(speaker)
    if not user_id:
        raise ValueError(f"Unknown speaker {speaker}; add to SPEAKER_TO_USER")

    marked = _inject_marker(turn_text, dia_id, turn_idx)
    payload = {
        "user_id": user_id,
        "mem_cube_id": CUBE_ID,
        "messages": [{"role": "user", "content": marked, "chat_time": timestamp_iso}],
    }

    start = time()
    r = requests.post(f"{API_BASE}/memories", json=payload, timeout=60)
    duration_ms = (time() - start) * 1000

    if r.status_code != 200:
        raise RuntimeError(f"add failed {r.status_code}: {r.text[:300]}")

    return duration_ms


def search(
    client: Any, dia_id: str, turn_idx: int, query: str, speaker: str, top_k: int = 10
) -> tuple[list[str], float]:
    """Query oh-memos, extract markers, track recall, return (contexts, latency_ms)."""
    user_id = SPEAKER_TO_USER.get(speaker)
    if not user_id:
        raise ValueError(f"Unknown speaker {speaker}")

    payload = {"user_id": user_id, "query": query, "top_k": top_k}

    start = time()
    r = requests.post(f"{API_BASE}/search", json=payload, timeout=60)
    duration_ms = (time() - start) * 1000

    if r.status_code != 200:
        raise RuntimeError(f"search failed {r.status_code}: {r.text[:300]}")

    data = r.json().get("data", {})
    text_mem = data.get("text_mem", [])
    if not text_mem:
        # no memories yet or query returned nothing
        return [], duration_ms

    entry = text_mem[0]
    memories = entry.get("memories", [])
    contexts = []
    retrieved_markers = set()

    for m in memories:
        mem_text = m.get("memory", "")
        contexts.append(mem_text)
        # extract [Dx:y] from memory text
        retrieved_markers.update(_extract_markers(mem_text))

        # also check metadata.sources (chat-type memories store verbatim)
        sources = m.get("metadata", {}).get("sources")
        if sources:
            # sources is a list of JSON strings like [{"type":"chat","content":"..."}]
            # or raw strings; either way pull markers
            if isinstance(sources, list):
                for s in sources:
                    retrieved_markers.update(_extract_markers(str(s)))
            else:
                retrieved_markers.update(_extract_markers(str(sources)))

    # track for recall@10 computation
    _RECALL_TRACKER[dia_id][turn_idx] = retrieved_markers

    return contexts, duration_ms


def compute_recall_at_10(dia_id: str, gold: dict[int, set[int]]) -> float:
    """Compute |gold ∩ retrieved| / |gold| across all turns in this dialogue.

    gold: {turn_idx: set of turn_idx that should have been retrieved}
    _RECALL_TRACKER[dia_id][turn_idx]: set of [Dx:y] markers actually retrieved

    We convert gold turn indices into marker strings [D<dia_id>:<gold_turn>],
    then intersect with what search() recorded.
    """
    if not gold:
        return 0.0

    total_gold = sum(len(g) for g in gold.values())
    if total_gold == 0:
        return 0.0

    hits = 0
    for query_turn, gold_set in gold.items():
        retrieved = _RECALL_TRACKER[dia_id].get(query_turn, set())
        # convert gold turn indices → marker strings
        gold_markers = {f"[D{dia_id}:{g}]" for g in gold_set}
        hits += len(gold_markers & retrieved)

    return hits / total_gold


def reset_dialogue(dia_id: str):
    """Clear recall tracker for the next dialogue."""
    _RECALL_TRACKER.pop(dia_id, None)


# ---- client factory for locomo_main.py ----
def get_client():
    """Return a dummy client object; actual requests go through module functions."""
    # The harness expects client.add / client.search, but our functions take
    # client as first arg and ignore it. Return None or a sentinel.
    return None


if __name__ == "__main__":
    # quick smoke test
    print(f"Adapter loaded. API_BASE={API_BASE} CUBE_ID={CUBE_ID}")
    r = requests.get(f"{API_BASE}/health", timeout=10)
    print(f"Health check: {r.status_code} {r.text[:100]}")

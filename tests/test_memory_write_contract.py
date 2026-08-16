"""Contract tests for metadata-aware memory writes.

These tests intentionally exercise the boundary models and typed item builder,
not a live Qdrant/Neo4j stack.
"""

import pytest
from pydantic import ValidationError

from oh_memos.api.start_api import MemoryCreate
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

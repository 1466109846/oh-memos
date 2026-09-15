"""Raw vector-first records keep their original identities during reorganization."""

from copy import deepcopy
from unittest.mock import MagicMock, call
from uuid import NAMESPACE_URL, uuid5

import pytest

from oh_memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from oh_memos.memories.textual.tree_text_memory.organize.handler import NodeHandler


def memory(label, *, raw=False, status="activated", updated_at="2026-09-16T00:00:00"):
    extras = {"ingestion_mode": "vector_first"} if raw else {}
    return TextualMemoryItem(
        id=str(uuid5(NAMESPACE_URL, f"raw-reorganization/{label}")),
        memory=f"Original content for {label}",
        metadata=TreeNodeTextualMemoryMetadata(
            memory_type="LongTermMemory",
            status=status,
            key=f"Title for {label}",
            embedding=[0.25, 0.75],
            tags=["BUGFIX"],
            updated_at=updated_at,
            **extras,
        ),
    )


def handler():
    graph = MagicMock()
    graph.get_edges.return_value = []
    llm = MagicMock()
    llm.generate.return_value = "<answer>Combined legacy content.</answer>"
    embedder = MagicMock()
    embedder.embed.return_value = [[0.5, 0.5]]
    return NodeHandler(graph, llm, embedder)


@pytest.mark.parametrize("relation, edge_type", [("contradictory", "CONFLICT"), ("redundant", "RELATE")])
@pytest.mark.parametrize("raw_side", ["a", "b", "both"])
def test_raw_records_only_create_relationships_without_fusing_or_mutating(relation, edge_type, raw_side):
    resolver = handler()
    memory_a = memory("a", raw=raw_side in {"a", "both"}, status="archived")
    memory_b = memory("b", raw=raw_side in {"b", "both"})
    before = deepcopy([memory_a.model_dump(), memory_b.model_dump()])

    resolver.resolve(memory_a, memory_b, relation)

    assert resolver.graph_store.method_calls == [call.add_edge(memory_a.id, memory_b.id, type=edge_type)]
    resolver.llm.generate.assert_not_called()
    resolver.embedder.embed.assert_not_called()
    assert [memory_a.model_dump(), memory_b.model_dump()] == before


def test_unrecognized_relation_on_a_raw_record_has_no_destructive_fallback():
    resolver = handler()

    resolver.resolve(memory("a", raw=True), memory("b"), "independent")

    assert resolver.graph_store.method_calls == []
    resolver.llm.generate.assert_not_called()
    resolver.embedder.embed.assert_not_called()


def test_legacy_records_continue_to_use_fusion_and_archive_the_originals():
    resolver = handler()
    memory_a, memory_b = memory("a"), memory("b")

    resolver.resolve(memory_a, memory_b, "redundant")

    resolver.llm.generate.assert_called_once()
    resolver.embedder.embed.assert_called_once_with(["Combined legacy content."])
    saved_id, saved_memory, saved_metadata = resolver.graph_store.add_node.call_args.args
    assert saved_id not in {memory_a.id, memory_b.id}
    assert saved_memory == "Combined legacy content."
    assert saved_metadata["embedding"] == [0.5, 0.5]
    assert resolver.graph_store.update_node.call_args_list == [
        call(memory_a.id, {"status": "archived"}),
        call(memory_b.id, {"status": "archived"}),
    ]


def test_legacy_unresolved_conflicts_still_keep_the_newer_record():
    resolver = handler()
    resolver.llm.generate.return_value = "<answer>No</answer>"
    older = memory("a", updated_at="2026-01-01T00:00:00")
    newer = memory("b", updated_at="2026-09-16T00:00:00")

    resolver.resolve(older, newer, "contradictory")

    resolver.graph_store.delete_node.assert_called_once_with(older.id)
    resolver.graph_store.add_node.assert_not_called()
    resolver.embedder.embed.assert_not_called()

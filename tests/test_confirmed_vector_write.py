"""Confirmed-write contracts using the real stores and isolated DB boundaries.

Neo4j results are supplied by a transaction double; these tests exercise error
propagation, compensation, payload handling and the Cypher isolation predicates.
They do not claim to validate the Neo4j server's Cypher execution.
"""

from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import NAMESPACE_URL, uuid5

import pytest

from oh_memos.graph_dbs.neo4j import Neo4jGraphDB
from oh_memos.graph_dbs.neo4j_community import Neo4jCommunityGraphDB
from oh_memos.vec_dbs.item import VecDBItem
from oh_memos.vec_dbs.qdrant import QdrantVecDB


MEMORY_ID = str(uuid5(NAMESPACE_URL, "cube-a/original memory"))
RAW_MEMORY = "[BUGFIX] Keep the complete original memory."


def metadata(**overrides):
    return {
        "embedding": [0.25, 0.75],
        "memory_type": "LongTermMemory",
        "status": "activated",
        "sources": [{"type": "text", "content": RAW_MEMORY}],
        "tags": ["BUGFIX"],
        "key": "Pending summary",
        "enrichment_status": "pending",
        **overrides,
    }


def node(**overrides):
    return {
        "id": MEMORY_ID,
        "memory": RAW_MEMORY,
        "user_name": "cube-a",
        "created_at": "2026-09-16T00:00:00",
        "updated_at": "2026-09-16T00:00:00",
        "vector_sync": "success",
        **metadata(),
        **overrides,
    }


class VectorStore:
    def __init__(self, item=None):
        self.item = deepcopy(item)
        self.writes = []
        self.deletes = []
        self.updates = []
        self.add_error = None
        self.update_error = None

    def get_by_id(self, memory_id):
        assert memory_id == MEMORY_ID
        return deepcopy(self.item)

    def add(self, items):
        self.writes.extend(deepcopy(items))
        if self.add_error:
            raise self.add_error
        self.item = deepcopy(items[0])

    def update(self, memory_id, item):
        self.updates.append(deepcopy(item))
        if self.update_error:
            raise self.update_error
        if self.item is not None:
            assert memory_id == self.item.id
            assert item.vector is None, "metadata updates must never replace the vector"
            self.item.payload.update(item.payload)

    def delete(self, ids):
        self.deletes.extend(ids)
        if self.item is not None and self.item.id in ids:
            self.item = None


def graph_store(cls=Neo4jCommunityGraphDB, current=None, vector=None, created=False):
    graph = object.__new__(cls)
    graph.config = SimpleNamespace(
        use_multi_db=False,
        user_name="cube-a",
        embedding_dimension=2,
        uri="bolt://isolated-test",
    )
    graph.db_name = "neo4j"
    graph.driver = MagicMock()
    transaction = MagicMock()
    graph.driver.session.return_value.__enter__.return_value.begin_transaction.return_value = (
        transaction
    )
    transaction.__enter__.return_value = transaction
    transaction.run.return_value.single.return_value = (
        {"n": deepcopy(current), "created": created} if current is not None else None
    )
    graph.vec_db = VectorStore(vector)
    return graph, transaction


def point(**overrides):
    values = node(**overrides)
    vector = values.pop("embedding")
    values.pop("id")
    return VecDBItem(id=MEMORY_ID, vector=vector, payload=values)


def queries(transaction):
    return "\n".join(call.args[0] for call in transaction.run.call_args_list)


def test_confirmed_write_returns_the_supplied_id_after_commit():
    graph, transaction = graph_store(current=node())
    supplied = metadata()
    untouched = deepcopy(supplied)

    result = graph.add_node_confirmed(MEMORY_ID, RAW_MEMORY, supplied)

    assert result == MEMORY_ID
    transaction.commit.assert_called_once()
    assert graph.vec_db.item.id == MEMORY_ID
    assert graph.vec_db.item.vector == [0.25, 0.75]
    assert graph.vec_db.item.payload["memory"] == RAW_MEMORY
    assert graph.vec_db.item.payload["user_name"] == "cube-a"
    assert graph.vec_db.item.payload["vector_sync"] == "success"
    assert supplied == untouched


def test_vector_failure_is_not_acknowledged_or_committed():
    graph, transaction = graph_store(current=node())
    graph.vec_db.add_error = RuntimeError("Qdrant unavailable")

    with pytest.raises(RuntimeError, match="Qdrant unavailable"):
        graph.add_node_confirmed(MEMORY_ID, RAW_MEMORY, metadata())

    transaction.commit.assert_not_called()


def test_vector_write_must_be_readable_before_acknowledgement():
    graph, transaction = graph_store(current=node())
    graph.vec_db.add = lambda _items: None

    with pytest.raises(RuntimeError, match="vector"):
        graph.add_node_confirmed(MEMORY_ID, RAW_MEMORY, metadata())

    transaction.commit.assert_not_called()


def test_graph_commit_failure_removes_the_new_vector():
    graph, transaction = graph_store(current=node())
    transaction.commit.side_effect = RuntimeError("Neo4j commit failed")

    with pytest.raises(RuntimeError, match="Neo4j commit failed"):
        graph.add_node_confirmed(MEMORY_ID, RAW_MEMORY, metadata())

    assert graph.vec_db.deletes == [MEMORY_ID]
    assert graph.vec_db.item is None


def test_duplicate_id_preserves_enrichment_and_existing_vector():
    enriched = node(key="Parsed summary", enrichment_status="completed", tags=["BUGFIX", "db"])
    existing_vector = point(
        key="Parsed summary", enrichment_status="completed", tags=["BUGFIX", "db"]
    )
    graph, transaction = graph_store(current=enriched, vector=existing_vector)

    assert graph.add_node_confirmed(MEMORY_ID, RAW_MEMORY, metadata()) == MEMORY_ID

    assert graph.vec_db.writes == []
    assert graph.vec_db.item == existing_vector
    assert "ON CREATE SET" in queries(transaction)
    assert "ON MATCH SET" not in queries(transaction)


def test_duplicate_with_missing_vector_repairs_it_using_existing_metadata():
    graph, _transaction = graph_store(
        current=node(key="Parsed summary", enrichment_status="completed", tags=["BUGFIX", "db"])
    )

    assert graph.add_node_confirmed(MEMORY_ID, RAW_MEMORY, metadata()) == MEMORY_ID

    assert graph.vec_db.item.payload["key"] == "Parsed summary"
    assert graph.vec_db.item.payload["enrichment_status"] == "completed"
    assert graph.vec_db.item.payload["tags"] == ["BUGFIX", "db"]


def test_duplicate_with_incomplete_payload_repairs_search_filters():
    existing = point(vector_sync="failed", key="Parsed summary")
    graph, _transaction = graph_store(
        current=node(key="Parsed summary", enrichment_status="completed"), vector=existing
    )

    assert graph.add_node_confirmed(MEMORY_ID, RAW_MEMORY, metadata()) == MEMORY_ID

    assert graph.vec_db.item.payload["vector_sync"] == "success"
    assert graph.vec_db.item.payload["key"] == "Parsed summary"
    assert graph.vec_db.item.payload["enrichment_status"] == "completed"
    assert graph.vec_db.writes == []


def test_vector_only_record_restores_enrichment_on_recreated_graph():
    existing = point(
        key="Parsed summary", tags=["BUGFIX", "db"], background="Existing context",
        enrichment_status="completed", enrichment_attempts=2,
    )
    graph, transaction = graph_store(current=node(), vector=existing, created=True)

    assert graph.add_node_confirmed(MEMORY_ID, RAW_MEMORY, metadata()) == MEMORY_ID

    assert graph.vec_db.item.payload["key"] == "Parsed summary"
    assert graph.vec_db.item.payload["enrichment_status"] == "completed"
    graph_fields = transaction.run.call_args.kwargs["fields"]
    assert graph_fields["key"] == "Parsed summary"
    assert graph_fields["background"] == "Existing context"
    assert graph_fields["tags"] == ["BUGFIX", "db"]
    assert graph_fields["enrichment_status"] == "completed"
    assert graph_fields["enrichment_attempts"] == 2
    assert graph.vec_db.writes == []


@pytest.mark.parametrize("status", ["activated", "archived"])
def test_vector_only_recovery_preserves_lifecycle_timestamps_and_provenance(status):
    original_sources = ['{"type": "text", "content": "Original source"}']
    existing = point(
        status=status,
        created_at="2026-01-01T00:00:00",
        updated_at="2026-02-01T00:00:00",
        source="file",
        sources=original_sources,
        source_ref="docs/original.md",
        session_id="original-session",
        user_id="alice",
        custom_label="keep-original",
    )
    graph, transaction = graph_store(
        current=node(user_id="alice", source="conversation", sources=[]),
        vector=existing, created=True,
    )

    assert graph.add_node_confirmed(
        MEMORY_ID, RAW_MEMORY, metadata(user_id="alice", source="conversation")
    ) == MEMORY_ID

    assert graph.vec_db.item == existing
    graph_fields = transaction.run.call_args.kwargs["fields"]
    assert graph_fields["status"] == status
    assert graph_fields["source"] == "file"
    assert graph_fields["sources"] == original_sources
    assert graph_fields["source_ref"] == "docs/original.md"
    assert graph_fields["session_id"] == "original-session"
    assert graph_fields["custom_label"] == "keep-original"
    assert "2026-01-01T00:00:00" in transaction.run.call_args.kwargs.values()
    assert "2026-02-01T00:00:00" in transaction.run.call_args.kwargs.values()
    assert "n.`created_at` = datetime(" in queries(transaction)
    assert "n.`updated_at` = datetime(" in queries(transaction)


def test_vector_only_recovery_rejects_a_deleted_vector():
    existing = point(status="deleted")
    graph, transaction = graph_store(current=node(), vector=existing, created=True)

    with pytest.raises(ValueError, match="deleted"):
        graph.add_node_confirmed(MEMORY_ID, RAW_MEMORY, metadata())

    transaction.commit.assert_not_called()
    assert graph.vec_db.item == existing
    assert graph.vec_db.updates == []


def test_vector_only_recovery_rejects_conflicting_user_identity():
    existing = point(user_id="alice")
    graph, transaction = graph_store(current=node(user_id="bob"), vector=existing, created=True)

    with pytest.raises(ValueError, match="identity"):
        graph.add_node_confirmed(MEMORY_ID, RAW_MEMORY, metadata(user_id="bob"))

    transaction.commit.assert_not_called()
    assert graph.vec_db.item == existing
    assert graph.vec_db.updates == []


def test_vector_only_recovery_does_not_copy_structural_payload_fields():
    existing = point()
    existing.payload.update(id="foreign-id", embedding=[9.0, 9.0], _confirmed_new_node=True)
    graph, transaction = graph_store(current=node(), vector=existing, created=True)

    assert graph.add_node_confirmed(MEMORY_ID, RAW_MEMORY, metadata()) == MEMORY_ID

    graph_fields = transaction.run.call_args.kwargs["fields"]
    assert not {"id", "memory", "embedding", "user_name", "_confirmed_new_node"} & graph_fields.keys()
    assert graph.vec_db.item.id == MEMORY_ID
    assert graph.vec_db.item.vector == [0.25, 0.75]


def test_duplicate_does_not_delete_preexisting_vector_on_graph_failure():
    existing_vector = point()
    graph, transaction = graph_store(current=node(), vector=existing_vector)
    transaction.commit.side_effect = RuntimeError("graph commit failed")

    with pytest.raises(RuntimeError, match="graph commit failed"):
        graph.add_node_confirmed(MEMORY_ID, RAW_MEMORY, metadata())

    assert graph.vec_db.deletes == []
    assert graph.vec_db.item == existing_vector


@pytest.mark.parametrize(
    "current",
    [node(memory="Edited later"), node(status="deleted"), node(user_name="other-cube")],
)
def test_existing_conflicting_record_is_never_overwritten(current):
    graph, transaction = graph_store(current=current)

    with pytest.raises(ValueError):
        graph.add_node_confirmed(MEMORY_ID, RAW_MEMORY, metadata())

    assert graph.vec_db.writes == []
    transaction.commit.assert_not_called()


def test_foreign_vector_is_never_overwritten():
    foreign = point(user_name="other-cube")
    graph, transaction = graph_store(current=node(), vector=foreign)

    with pytest.raises(ValueError):
        graph.add_node_confirmed(MEMORY_ID, RAW_MEMORY, metadata())

    assert graph.vec_db.writes == []
    assert graph.vec_db.item == foreign
    transaction.commit.assert_not_called()


@pytest.mark.parametrize("bad_embedding", [None, [], [float("nan"), 0.1], [0.1]])
def test_native_confirmed_write_rejects_invalid_vectors(bad_embedding):
    graph, transaction = graph_store(Neo4jGraphDB, current=node())

    with pytest.raises(ValueError, match="embedding"):
        graph.add_node_confirmed(MEMORY_ID, RAW_MEMORY, metadata(embedding=bad_embedding))

    transaction.commit.assert_not_called()


def test_native_confirmed_write_retains_embedding_and_commits():
    graph, transaction = graph_store(Neo4jGraphDB, current=node())

    assert graph.add_node_confirmed(MEMORY_ID, RAW_MEMORY, metadata()) == MEMORY_ID

    transaction.commit.assert_called_once()
    written_params = [call.kwargs for call in transaction.run.call_args_list]
    assert any(p.get("metadata", {}).get("embedding") == [0.25, 0.75] for p in written_params)


def test_native_confirmed_write_propagates_commit_failure():
    graph, transaction = graph_store(Neo4jGraphDB, current=node())
    transaction.commit.side_effect = RuntimeError("native commit failed")

    with pytest.raises(RuntimeError, match="native commit failed"):
        graph.add_node_confirmed(MEMORY_ID, RAW_MEMORY, metadata())


@pytest.mark.parametrize("cls", [Neo4jGraphDB, Neo4jCommunityGraphDB])
@pytest.mark.parametrize(
    "current", [None, node(memory="Edited later"), node(status="deleted"), node(status="archived")]
)
def test_enrichment_skips_missing_edited_or_inactive_record(cls, current):
    graph, _transaction = graph_store(cls, current=current, vector=point())

    assert not graph.update_node_if_current(
        MEMORY_ID, RAW_MEMORY, {"key": "Extracted summary", "enrichment_status": "completed"}
    )

    assert graph.vec_db.updates == []


@pytest.mark.parametrize("cls", [Neo4jGraphDB, Neo4jCommunityGraphDB])
def test_enrichment_is_scoped_to_the_configured_cube(cls):
    graph, _transaction = graph_store(cls, current=node(user_name="other-cube"), vector=point())

    assert not graph.update_node_if_current(MEMORY_ID, RAW_MEMORY, {"key": "summary"})

    assert graph.vec_db.updates == []


@pytest.mark.parametrize("cls", [Neo4jGraphDB, Neo4jCommunityGraphDB])
def test_enrichment_checks_content_status_and_tenant_in_the_query(cls):
    graph, transaction = graph_store(cls, current=node(), vector=point())

    assert graph.update_node_if_current(MEMORY_ID, RAW_MEMORY, {"key": "summary"})

    cypher = queries(transaction)
    assert "n.memory = $expected_memory" in cypher
    assert "n.status = 'activated'" in cypher
    assert "n.user_name = $user_name" in cypher
    assert "MERGE" not in cypher
    transaction.commit.assert_called_once()


@pytest.mark.parametrize("field", ["id", "memory", "embedding", "user_name", "status"])
def test_enrichment_rejects_changes_to_identity_content_vector_or_lifecycle(field):
    graph, transaction = graph_store(current=node(), vector=point())

    with pytest.raises(ValueError):
        graph.update_node_if_current(MEMORY_ID, RAW_MEMORY, {field: "replace"})

    transaction.commit.assert_not_called()
    assert graph.vec_db.updates == []


def test_enrichment_updates_only_payload_and_leaves_vector_unchanged():
    graph, transaction = graph_store(current=node(), vector=point())
    fields = {"key": "Extracted summary", "tags": ["BUGFIX", "db"], "enrichment_status": "completed"}
    untouched = deepcopy(fields)

    assert graph.update_node_if_current(MEMORY_ID, RAW_MEMORY, fields)

    assert graph.vec_db.item.vector == [0.25, 0.75]
    assert graph.vec_db.item.payload["memory"] == RAW_MEMORY
    assert graph.vec_db.item.payload["key"] == "Extracted summary"
    assert graph.vec_db.item.payload["enrichment_status"] == "completed"
    assert graph.vec_db.writes == []
    assert fields == untouched
    transaction.commit.assert_called_once()


def test_enrichment_vector_failure_leaves_graph_uncommitted():
    graph, transaction = graph_store(current=node(), vector=point())
    graph.vec_db.update_error = RuntimeError("payload write failed")

    with pytest.raises(RuntimeError, match="payload write failed"):
        graph.update_node_if_current(MEMORY_ID, RAW_MEMORY, {"key": "summary"})

    transaction.commit.assert_not_called()


def test_enrichment_does_not_recreate_a_missing_vector():
    graph, transaction = graph_store(current=node())

    with pytest.raises(RuntimeError, match="vector"):
        graph.update_node_if_current(MEMORY_ID, RAW_MEMORY, {"key": "summary"})

    assert graph.vec_db.writes == []
    transaction.commit.assert_not_called()


def test_enrichment_graph_commit_failure_restores_payload():
    original = point()
    graph, transaction = graph_store(current=node(), vector=original)
    transaction.commit.side_effect = RuntimeError("graph commit failed")

    with pytest.raises(RuntimeError, match="graph commit failed"):
        graph.update_node_if_current(MEMORY_ID, RAW_MEMORY, {"key": "summary"})

    assert graph.vec_db.item == original
    assert graph.vec_db.writes == []


@pytest.mark.parametrize("operation", ["add", "update-vector", "update-payload", "delete"])
def test_qdrant_mutations_explicitly_wait_for_completion(operation):
    store = object.__new__(QdrantVecDB)
    store.config = SimpleNamespace(collection_name="isolated-test")
    store.client = MagicMock()

    if operation == "add":
        store.add([point()])
        call = store.client.upsert.call_args
    elif operation == "update-vector":
        store.update(MEMORY_ID, point())
        call = store.client.upsert.call_args
    elif operation == "update-payload":
        store.update(MEMORY_ID, VecDBItem(id=MEMORY_ID, payload={"key": "summary"}))
        call = store.client.set_payload.call_args
    else:
        store.delete([MEMORY_ID])
        call = store.client.delete.call_args

    assert call.kwargs.get("wait") is True

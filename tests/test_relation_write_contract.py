"""Relation write-back contract tests.

These exercise the API request model and the MOSCore allowlist boundary without
a live Neo4j/Qdrant stack, because the relationship type reaches Cypher through
string interpolation and must never be accepted unchecked.
"""

import pytest
from pydantic import ValidationError

from oh_memos.api.product_models import APIAddRelationRequest
from oh_memos.mem_os.core import ALLOWED_RELATION_TYPES, MOSCore


def test_relation_request_accepts_supported_types():
    for relation_type in sorted(ALLOWED_RELATION_TYPES):
        request = APIAddRelationRequest(
            user_id="dev_user",
            mem_cube_id="dev_cube",
            source_id="a",
            target_id="b",
            relation_type=relation_type,
        )
        assert request.relation_type == relation_type


def test_relation_request_rejects_injection_and_unknown_types():
    for bad in ["DROP", "RELATE_TO", "relate", "CAUSE]->() MATCH (n) DETACH DELETE n //", ""]:
        with pytest.raises(ValidationError):
            APIAddRelationRequest(
                user_id="dev_user",
                mem_cube_id="dev_cube",
                source_id="a",
                target_id="b",
                relation_type=bad,
            )


def test_core_rejects_unlisted_type_before_touching_a_cube():
    core = object.__new__(MOSCore)
    with pytest.raises(ValueError, match="Unsupported relation_type"):
        MOSCore.add_relation(core, "dev_cube", "a", "b", "MALICIOUS", user_id="dev_user")


def test_core_rejects_self_edges():
    core = object.__new__(MOSCore)
    with pytest.raises(ValueError, match="must differ"):
        MOSCore.add_relation(core, "dev_cube", "same", "same", "RELATE", user_id="dev_user")


def test_core_requires_graph_backed_text_memory():
    class FlatTextMem:
        """A non-graph backend: no graph_store attribute."""

    class Cube:
        text_mem = FlatTextMem()

    core = object.__new__(MOSCore)
    core.user_id = "dev_user"
    core.mem_cubes = {"dev_cube": Cube()}
    core._validate_cube_access = lambda *_args, **_kwargs: None

    with pytest.raises(NotImplementedError, match="RELATIONS_UNSUPPORTED"):
        MOSCore.add_relation(core, "dev_cube", "a", "b", "RELATE", user_id="dev_user")


def test_core_rejects_missing_endpoints_and_writes_valid_edge():
    written: list[tuple[str, str, str, str]] = []

    class GraphStore:
        def add_edge(self, source_id, target_id, type, user_name=None):
            written.append((source_id, target_id, type, user_name))

    class TreeTextMem:
        graph_store = GraphStore()

        def get(self, memory_id):
            return object() if memory_id in {"a", "b"} else None

    class Cube:
        text_mem = TreeTextMem()

    core = object.__new__(MOSCore)
    core.user_id = "dev_user"
    core.mem_cubes = {"dev_cube": Cube()}
    core._validate_cube_access = lambda *_args, **_kwargs: None

    with pytest.raises(ValueError, match="does not exist in cube"):
        MOSCore.add_relation(core, "dev_cube", "a", "missing", "CAUSE", user_id="dev_user")
    assert written == []

    MOSCore.add_relation(core, "dev_cube", "a", "b", "CAUSE", user_id="dev_user")
    assert written == [("a", "b", "CAUSE", "dev_cube")]

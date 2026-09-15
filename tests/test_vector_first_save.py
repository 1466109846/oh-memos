"""Exercise real API/core code with isolated model and persistence boundaries."""

from __future__ import annotations

import copy
import asyncio
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from oh_memos.api import start_api
from oh_memos.mem_os.core import MOSCore
from oh_memos.mem_reader.simple_struct import SimpleStructMemReader


RAW = "[ERROR_PATTERN] Keep the original vector while slow LLM parsing runs."
CUBE = "vector_first_test_cube"


class Graph:
    def __init__(self):
        self.config = SimpleNamespace(user_name=CUBE)
        self.nodes = {}
        self.lock = threading.Lock()
        self.failure = None
        self.failed = threading.Event()
        self.completed = threading.Event()

    def add_node_confirmed(self, memory_id, memory, metadata, user_name=None):
        if self.failure:
            raise self.failure
        with self.lock:
            self.nodes.setdefault(memory_id, {
                "id": memory_id,
                "memory": memory,
                "metadata": {**copy.deepcopy(metadata), "vector_sync": "success"},
            })
        return memory_id

    def get_node(self, memory_id, **_kwargs):
        with self.lock:
            return copy.deepcopy(self.nodes.get(memory_id))

    def get_by_metadata(self, filters, **_kwargs):
        def matches(node):
            metadata = node["metadata"]
            for condition in filters:
                value = metadata.get(condition["field"])
                expected = condition["value"]
                operator = condition.get("op", "=")
                if operator == "=" and value != expected:
                    return False
                if operator == "in" and value not in expected:
                    return False
                if operator == "<" and (value is None or value >= expected):
                    return False
                if operator == "<=" and (value is None or value > expected):
                    return False
            return True

        with self.lock:
            return [memory_id for memory_id, node in self.nodes.items() if matches(node)]

    def update_node_if_current(self, memory_id, expected_memory, fields, user_name=None):
        with self.lock:
            node = self.nodes.get(memory_id)
            if not node or node["memory"] != expected_memory or node["metadata"]["status"] != "activated":
                return False
            node["metadata"].update(copy.deepcopy(fields))
            if fields.get("enrichment_status") == "failed":
                self.failed.set()
            if fields.get("enrichment_status") == "completed":
                self.completed.set()
            return True


class Reader:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls = 0
        self.failure = None

    def get_memory(self, *_args, **_kwargs):
        raise AssertionError("LLM extraction was called on the foreground save path")

    def extract_metadata(self, content, custom_tags=None):
        self.calls += 1
        self.started.set()
        assert self.release.wait(5), "test did not release the slow parser"
        if self.failure:
            raise self.failure
        return {"key": "Parsed title", "tags": ["storage", "latency"], "background": "Parsed context"}


def core_with_graph(graph, reader):
    core = object.__new__(MOSCore)
    core.user_id = "tester"
    core.session_id = "session-1"
    core.config = SimpleNamespace(enable_textual_memory=True, enable_preference_memory=False)
    core.enable_mem_scheduler = False
    core._validate_cube_access = lambda *_args, **_kwargs: None
    core.mem_reader = reader
    core.chat_history_manager = {}
    embeddings = []

    def embed(values):
        embeddings.extend(values)
        return [[0.2, 0.8] for _ in values]

    text_mem = SimpleNamespace(
        mode="sync", graph_store=graph, embedder=SimpleNamespace(embed=embed),
        is_reorganize=False,
    )
    core.mem_cubes = {CUBE: SimpleNamespace(
        text_mem=text_mem, config=SimpleNamespace(text_mem=SimpleNamespace(backend="tree_text")),
    )}
    return core, embeddings


@pytest.fixture
def stack(monkeypatch):
    graph = Graph()
    reader = Reader()
    core, embeddings = core_with_graph(graph, reader)
    monkeypatch.setattr(start_api, "get_mos_instance", lambda: core)
    monkeypatch.setattr(start_api, "_try_auto_register_cube", lambda *_args: None)
    monkeypatch.setenv("MOS_TYPED_SAVE_FAST", "false")
    yield core, graph, reader, embeddings
    reader.release.set()
    if hasattr(core, "stop_background_enrichment"):
        core.stop_background_enrichment()


def save_request(**kwargs):
    return start_api.add_memory(start_api.MemoryCreate(
        user_id="tester", mem_cube_id=CUBE, memory_content=RAW,
        memory_type="ERROR_PATTERN", **kwargs,
    ))


def test_api_acknowledges_confirmed_vector_while_llm_is_still_blocked(stack):
    _core, graph, reader, embeddings = stack
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(save_request)
        try:
            response = future.result(timeout=1)
            assert response.code == 200
            assert response.data["vector_saved"] is True
            assert response.data["queued"] is False
            assert response.data["enrichment_status"] == "pending"
            assert len(response.data["memory_ids"]) == 1
            memory_id = response.data["memory_ids"][0]
            node = graph.get_node(memory_id)
            assert node["memory"] == RAW
            assert node["metadata"]["embedding"] == [0.2, 0.8]
            assert node["metadata"]["vector_sync"] == "success"
            assert embeddings == [RAW]
            assert reader.started.wait(1)
            assert not graph.completed.is_set()
        finally:
            reader.release.set()


def test_http_response_is_sent_before_the_slow_parser_finishes(stack):
    _core, graph, reader, _embeddings = stack
    client = TestClient(start_api.app)
    with ThreadPoolExecutor(max_workers=1) as pool:
        request = pool.submit(client.post, "/memories", json={
            "user_id": "tester", "mem_cube_id": CUBE,
            "memory_content": RAW, "memory_type": "ERROR_PATTERN",
        })
        try:
            response = request.result(timeout=1)
            assert response.status_code == 200
            data = response.json()["data"]
            assert data["vector_saved"] is True
            assert data["enrichment_status"] == "pending"
            assert graph.get_node(data["memory_ids"][0])["memory"] == RAW
            assert reader.started.wait(1)
            assert not graph.completed.is_set()
        finally:
            reader.release.set()
            client.close()


def test_http_vector_failure_is_not_a_success_response(stack):
    _core, graph, reader, _embeddings = stack
    graph.failure = RuntimeError("Qdrant unavailable")
    client = TestClient(start_api.app, raise_server_exceptions=False)
    try:
        response = client.post("/memories", json={
            "user_id": "tester", "mem_cube_id": CUBE, "memory_content": RAW,
        })
        assert response.status_code == 500
        assert not reader.started.is_set()
        assert not graph.nodes
    finally:
        client.close()


def test_parsing_enriches_the_same_record_without_replacing_raw_text_or_vector(stack):
    _core, graph, reader, _embeddings = stack
    response = save_request(tags=["explicit"], confidence=0.7, source="file", source_ref="notes.md")
    memory_id = response.data["memory_ids"][0]
    original = graph.get_node(memory_id)
    reader.release.set()
    assert graph.completed.wait(2)
    enriched = graph.get_node(memory_id)
    assert enriched["memory"] == original["memory"]
    assert enriched["metadata"]["embedding"] == original["metadata"]["embedding"]
    assert enriched["metadata"]["created_at"] == original["metadata"]["created_at"]
    assert enriched["metadata"]["confidence"] == 0.7
    assert enriched["metadata"]["source"] == "file"
    assert enriched["metadata"]["key"] == "Parsed title"
    assert set(enriched["metadata"]["tags"]) >= {"ERROR_PATTERN", "explicit", "storage", "latency"}
    assert enriched["metadata"]["enrichment_status"] == "completed"
    assert len([n for n in graph.nodes.values() if n["metadata"]["memory_type"] == "LongTermMemory"]) == 1


def test_duplicate_save_returns_original_id_and_does_not_repeat_inflight_parsing(stack):
    _core, graph, reader, _embeddings = stack
    first = save_request()
    assert reader.started.wait(1)
    second = save_request()
    assert second.data["memory_ids"] == first.data["memory_ids"]
    assert reader.calls == 1
    reader.release.set()
    assert graph.completed.wait(2)
    third = save_request()
    assert third.data["memory_ids"] == first.data["memory_ids"]
    assert graph.get_node(first.data["memory_ids"][0])["metadata"]["key"] == "Parsed title"


def test_vector_failure_never_returns_success_or_starts_parser(stack):
    _core, graph, reader, _embeddings = stack
    graph.failure = RuntimeError("Qdrant unavailable")
    with pytest.raises(RuntimeError, match="Qdrant unavailable"):
        save_request()
    assert graph.nodes == {}
    assert not reader.started.is_set()


def test_failed_extraction_keeps_raw_memory_searchable_and_records_retry_state(stack):
    _core, graph, reader, _embeddings = stack
    reader.failure = TimeoutError("LLM exhausted its fallback chain")
    response = save_request()
    reader.release.set()
    assert graph.failed.wait(2)
    node = graph.get_node(response.data["memory_ids"][0])
    assert node["memory"] == RAW
    assert node["metadata"]["vector_sync"] == "success"
    assert node["metadata"]["enrichment_status"] == "failed"
    assert node["metadata"]["enrichment_attempts"] == 1
    assert node["metadata"]["enrichment_retry_after"] > time.time()
    assert "TimeoutError" in node["metadata"]["enrichment_error"]


@pytest.mark.parametrize("change", ["delete", "edit"])
def test_background_result_does_not_resurrect_or_overwrite_a_changed_record(stack, change):
    _core, graph, reader, _embeddings = stack
    finished = threading.Event()
    worker = _core._get_vector_ingestion().worker
    process = worker._process

    def track_completion(job):
        try:
            process(job)
        finally:
            finished.set()

    worker._process = track_completion
    response = save_request()
    memory_id = response.data["memory_ids"][0]
    assert reader.started.wait(1)
    with graph.lock:
        if change == "delete":
            del graph.nodes[memory_id]
        else:
            graph.nodes[memory_id]["memory"] = "edited by user"
            graph.nodes[memory_id]["metadata"]["enrichment_status"] = "completed"
    reader.release.set()
    # Wait for the actual callback, so shutdown cannot bypass its stale-result check.
    assert finished.wait(2)
    current = graph.get_node(memory_id)
    if change == "delete":
        assert current is None
    else:
        assert current["memory"] == "edited by user"
        assert current["metadata"]["key"] != "Parsed title"


def test_a_new_core_resumes_persisted_pending_enrichment_without_another_save(stack):
    first_core, graph, first_reader, _embeddings = stack
    response = save_request()
    memory_id = response.data["memory_ids"][0]
    assert first_reader.started.wait(1)
    first_core.stop_background_enrichment()
    second_reader = Reader()
    second_reader.release.set()
    second_core, _ = core_with_graph(graph, second_reader)
    try:
        second_core.start_background_enrichment()
        assert graph.completed.wait(2)
        assert graph.get_node(memory_id)["metadata"]["enrichment_status"] == "completed"
    finally:
        first_reader.release.set()
        second_core.stop_background_enrichment()


@pytest.mark.parametrize("stored_path", ["local", "old_windows", "mixed_windows"])
def test_restart_recovers_an_unloaded_nondefault_project_from_the_registry(stack, tmp_path, monkeypatch, stored_path):
    first_core, graph, first_reader, _embeddings = stack
    response = save_request()
    first_core.stop_background_enrichment()
    first_reader.release.set()
    reader = Reader()
    reader.release.set()
    restarted, _ = core_with_graph(graph, reader)
    saved_cube = restarted.mem_cubes.pop(CUBE)
    cube_path = tmp_path / CUBE
    cube_path.mkdir()
    (cube_path / "config.json").write_text("{}")
    monkeypatch.setenv("MEMOS_CUBES_DIR", str(tmp_path))
    paths = {
        "local": str(cube_path),
        "old_windows": f"G:/test/MemOS/data/memos_cubes/{CUBE}",
        "mixed_windows": f"G:/test/oh-memos/data/oh-memos_cubes\\{CUBE}",
    }
    record = SimpleNamespace(cube_id=CUBE, cube_path=paths[stored_path], owner_id="inactive-owner")
    restarted.user_manager = SimpleNamespace(
        list_users=lambda: [SimpleNamespace(user_id="tester")],
        get_user_cubes=lambda _user_id: [record],
    )
    registrations = []

    def register(path, mem_cube_id, user_id, **_kwargs):
        registrations.append((path, mem_cube_id, user_id))
        restarted.mem_cubes[mem_cube_id] = saved_cube

    restarted.register_mem_cube = register
    try:
        restarted.start_background_enrichment()
        assert graph.completed.wait(2)
        assert registrations == [(str(cube_path), CUBE, "tester")]
        assert graph.get_node(response.data["memory_ids"][0])["metadata"]["enrichment_status"] == "completed"
    finally:
        restarted.stop_background_enrichment()


def test_interruption_during_the_last_attempt_remains_recoverable(stack, monkeypatch):
    core, graph, reader, _embeddings = stack
    monkeypatch.setenv("MEMOS_DISABLE_BACKGROUND_WRITERS", "true")
    response = save_request()
    memory_id = response.data["memory_ids"][0]
    graph.nodes[memory_id]["metadata"]["enrichment_attempts"] = 2
    reader.release.set()
    reader.failure = SystemExit("simulated process interruption")
    with pytest.raises(SystemExit):
        core._get_vector_ingestion()._enrich((CUBE, memory_id))
    core.stop_background_enrichment()
    monkeypatch.delenv("MEMOS_DISABLE_BACKGROUND_WRITERS")
    resumed_reader = Reader()
    resumed_reader.release.set()
    resumed, _ = core_with_graph(graph, resumed_reader)
    try:
        resumed.start_background_enrichment()
        assert graph.completed.wait(2)
    finally:
        resumed.stop_background_enrichment()


def test_background_discovery_does_not_reload_a_cube_unregistered_in_the_meantime(stack, tmp_path):
    core, _graph, _reader, _embeddings = stack
    cube = core.mem_cubes.pop(CUBE)
    (tmp_path / "config.json").write_text("{}")
    record = SimpleNamespace(cube_id=CUBE, cube_path=str(tmp_path), owner_id="tester")
    core.user_manager = SimpleNamespace(
        list_users=lambda: [SimpleNamespace(user_id="tester")],
        get_user_cubes=lambda _user: [record],
    )
    discovered = threading.Event()
    proceed = threading.Event()
    recovered = threading.Event()
    registrations = []
    original_register = core.register_mem_cube

    def perform_registration(_path, cube_id, _user):
        registrations.append(cube_id)
        core.mem_cubes[cube_id] = cube
        core._get_vector_ingestion().include_cube(cube_id)

    def pause_recovery(path, **kwargs):
        discovered.set()
        assert proceed.wait(3)
        try:
            original_register(path, **kwargs)
        finally:
            recovered.set()

    core._register_mem_cube = perform_registration
    core.register_mem_cube = pause_recovery
    try:
        core.start_background_enrichment()
        assert discovered.wait(1)
        original_register(str(tmp_path), mem_cube_id=CUBE, user_id="tester")
        core.unregister_mem_cube(CUBE)
        proceed.set()
        assert recovered.wait(1)
        assert CUBE not in core.mem_cubes
        assert registrations == [CUBE]
    finally:
        proceed.set()


def test_reconfiguration_stops_the_previous_enrichment_worker(monkeypatch):
    stopped = threading.Event()
    started = threading.Event()
    previous = SimpleNamespace(stop_background_enrichment=stopped.set)
    replacement = SimpleNamespace(start_background_enrichment=started.set)
    monkeypatch.setattr(start_api, "MOS_INSTANCE", previous)
    monkeypatch.setattr(start_api, "UserManager", lambda: SimpleNamespace(validate_user=lambda _id: True))
    monkeypatch.setattr(start_api, "MOS", lambda **_kwargs: replacement)
    response = asyncio.run(start_api.set_config(SimpleNamespace(user_id="tester")))
    assert response.code == 200
    assert start_api.MOS_INSTANCE is replacement
    assert stopped.is_set()
    assert started.is_set()


def test_metadata_extraction_reuses_prompt_without_calling_embedder():
    reader = object.__new__(SimpleStructMemReader)
    reader.config = SimpleNamespace(remove_prompt_example=False)
    prompt_calls = []

    def generate(messages):
        prompt_calls.append(messages)
        return json.dumps({"memory list": [
            {"key": "Storage order", "value": "Parsed fact", "tags": ["async", "storage"]},
            {"key": "Slow LLM", "value": "Another fact", "tags": ["storage", "LLM"]},
        ], "summary": "Vector saved before parsing"})

    reader.llm = SimpleNamespace(generate=generate)
    reader.embedder = SimpleNamespace(embed=lambda _values: pytest.fail("metadata extraction embedded text"))
    fields = reader.extract_metadata(RAW, custom_tags=["ERROR_PATTERN"])
    assert fields["key"] == "Storage order"
    assert fields["tags"] == ["async", "storage", "LLM"]
    assert fields["background"] == "Vector saved before parsing"
    assert len(json.loads(fields["enrichment_items"])) == 2
    assert len(prompt_calls) == 1


@pytest.mark.parametrize("response", ["not JSON", '{"memory list": []}', '{"unrelated": 1}'])
def test_invalid_llm_metadata_is_reported_as_failure(response):
    reader = object.__new__(SimpleStructMemReader)
    reader.config = SimpleNamespace(remove_prompt_example=False)
    reader.llm = SimpleNamespace(generate=lambda _messages: response)
    with pytest.raises(ValueError, match="extraction"):
        reader.extract_metadata(RAW)

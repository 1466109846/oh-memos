"""Background parsing must never hold up foreground vector acknowledgements."""

import importlib.util
import threading
import time
from pathlib import Path

import pytest


def worker_class():
    # The worker itself only needs the stdlib; keep this test runnable without
    # importing the optional model/database stack from oh_memos.__init__.
    path = Path(__file__).resolve().parents[1] / "src/oh_memos/mem_os/enrichment.py"
    assert path.exists(), "the independent background enrichment worker is missing"
    spec = importlib.util.spec_from_file_location("background_enrichment_test_module", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.BackgroundEnrichmentWorker


def test_blocked_parsers_leave_notify_fast_and_limit_concurrency():
    pending = [("cube", str(i)) for i in range(5)]
    lock = threading.Lock()
    release = threading.Event()
    two_started = threading.Event()
    all_done = threading.Event()
    active = 0
    maximum_active = 0
    completed = set()

    def list_pending():
        with lock:
            return [job for job in pending if job not in completed]

    def parse(job):
        nonlocal active, maximum_active
        with lock:
            active += 1
            maximum_active = max(maximum_active, active)
            if active == 2:
                two_started.set()
        assert release.wait(3), "test did not release the simulated slow LLM"
        with lock:
            completed.add(job)
            active -= 1
            if len(completed) == len(pending):
                all_done.set()

    worker = worker_class()(list_pending, parse, workers=2, poll_interval=0.02)
    try:
        started = time.monotonic()
        worker.notify()
        assert time.monotonic() - started < 0.25
        assert two_started.wait(1)
        with lock:
            assert maximum_active == 2
            assert completed == set()
        started = time.monotonic()
        worker.notify()
        assert time.monotonic() - started < 0.25
        release.set()
        assert all_done.wait(2)
        assert maximum_active == 2
    finally:
        release.set()
        worker.close()


def test_one_failed_job_does_not_kill_workers_or_spin_on_the_same_record():
    good_done = threading.Event()
    failures = []

    def pending():
        return [("c", "bad")] + ([] if good_done.is_set() else [("c", "good")])

    def parse(job):
        if job[1] == "bad":
            failures.append(job)
            raise RuntimeError("temporary storage failure")
        good_done.set()

    worker = worker_class()(pending, parse, workers=1, poll_interval=1)
    try:
        worker.notify()
        assert good_done.wait(0.75)
        assert len(failures) == 1
    finally:
        worker.close()


def test_stopping_does_not_wait_for_llm_and_pending_work_can_resume():
    started = threading.Event()
    release = threading.Event()
    recovered = threading.Event()
    pending = [("cube", "durable-original-id")]

    def blocked_parse(job):
        started.set()
        release.wait(3)

    first = worker_class()(lambda: list(pending), blocked_parse, workers=1)
    second = None
    try:
        first.notify()
        assert started.wait(1)
        before = time.monotonic()
        first.close(timeout=0.05)
        assert time.monotonic() - before < 0.25
        assert pending == [("cube", "durable-original-id")]

        def resume(job):
            assert job == pending.pop()
            recovered.set()

        second = worker_class()(lambda: list(pending), resume, workers=1)
        second.notify()
        assert recovered.wait(1)
    finally:
        release.set()
        first.close()
        if second:
            second.close()


def test_notify_is_nonblocking_when_database_scan_is_slow():
    scanning = threading.Event()
    release = threading.Event()

    def pending():
        scanning.set()
        release.wait(3)
        return []

    worker = worker_class()(pending, lambda _job: None, workers=1)
    try:
        worker.notify()
        assert scanning.wait(1)
        before = time.monotonic()
        worker.notify()
        assert time.monotonic() - before < 0.25
    finally:
        release.set()
        worker.close()


def test_database_scan_recovers_after_a_transient_error():
    done = threading.Event()
    scans = 0

    def pending():
        nonlocal scans
        scans += 1
        if scans == 1:
            raise OSError("database restarting")
        return [] if done.is_set() else [("cube", "one")]

    worker = worker_class()(pending, lambda _job: done.set(), workers=1, poll_interval=0.02)
    try:
        worker.notify()
        assert done.wait(1)
    finally:
        worker.close()


@pytest.mark.parametrize("workers", [0, -1])
def test_worker_count_must_be_positive(workers):
    with pytest.raises(ValueError, match="workers"):
        worker_class()(lambda: [], lambda _job: None, workers=workers)

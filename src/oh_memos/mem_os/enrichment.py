"""Bounded background consumers of enrichment work persisted with raw memories.

The database is the queue: a process restart cannot discard an in-memory task
list. Callbacks own persistence and retry state; this module never waits on an
LLM from the caller of ``notify`` or ``close``.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Iterable


logger = logging.getLogger(__name__)
EnrichmentJob = tuple[str, str]


class BackgroundEnrichmentWorker:
    def __init__(
        self,
        list_pending: Callable[[], Iterable[EnrichmentJob]],
        process: Callable[[EnrichmentJob], None],
        *,
        workers: int = 2,
        poll_interval: float = 30.0,
    ) -> None:
        if workers < 1:
            raise ValueError("workers must be positive")
        if poll_interval <= 0:
            raise ValueError("poll_interval must be positive")
        self._list_pending = list_pending
        self._process = process
        self._worker_count = workers
        self._poll_interval = poll_interval
        self._lifecycle_lock = threading.Lock()
        self._selection_lock = threading.Lock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._threads: list[threading.Thread] = []
        self._in_flight: set[EnrichmentJob] = set()
        self._cooldown: dict[EnrichmentJob, float] = {}

    def notify(self) -> None:
        """Start consumers once and wake them, without reading the database."""
        with self._lifecycle_lock:
            if self._stop.is_set():
                return
            if not self._threads:
                for index in range(self._worker_count):
                    thread = threading.Thread(
                        target=self._run,
                        name=f"memos-enrichment-{index}",
                        daemon=True,
                    )
                    self._threads.append(thread)
                    thread.start()
        self._wake.set()

    def _take_pending(self) -> EnrichmentJob | None:
        # Selection may involve database I/O. It deliberately has a different
        # lock from notify/close, which are on the foreground request path.
        with self._selection_lock:
            now = time.monotonic()
            self._cooldown = {job: until for job, until in self._cooldown.items() if until > now}
            for job in self._list_pending():
                if self._stop.is_set():
                    return None
                if job not in self._in_flight and job not in self._cooldown:
                    self._in_flight.add(job)
                    return job
        return None

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                job = self._take_pending()
            except Exception:
                logger.warning("Could not scan pending memory enrichment", exc_info=True)
                job = None
            if job is None:
                self._wake.wait(self._poll_interval)
                self._wake.clear()
                continue
            try:
                if not self._stop.is_set():
                    self._process(job)
            except Exception:
                # Even failure to persist a retry must not kill a consumer or
                # create a tight loop against the same unavailable database.
                logger.warning("Background enrichment failed for %s/%s", *job, exc_info=True)
                with self._selection_lock:
                    self._cooldown[job] = time.monotonic() + self._poll_interval
            finally:
                with self._selection_lock:
                    self._in_flight.discard(job)
                self._wake.set()

    def close(self, timeout: float = 0.2) -> None:
        """Stop taking work promptly; unfinished records stay pending in storage."""
        with self._lifecycle_lock:
            self._stop.set()
            threads = list(self._threads)
        self._wake.set()
        deadline = time.monotonic() + timeout
        for thread in threads:
            if thread is not threading.current_thread():
                thread.join(max(0.0, deadline - time.monotonic()))

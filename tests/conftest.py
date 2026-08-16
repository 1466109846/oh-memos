"""Shared test bootstrap.

The import chain ``oh_memos -> configs -> mem_reader -> transformers -> torch``
makes every contract test fail at collection time on hosts where the torch
Windows DLLs cannot initialize (WinError 1114, a broken local install — not a
code defect). The memory write/relation contracts under test never touch torch
or transformers themselves, so when a real import is impossible we substitute
minimal stubs. Hosts with a working torch keep the real libraries untouched.
"""

from __future__ import annotations

import sys

from unittest.mock import MagicMock


def _stub_if_unimportable(module_name: str) -> None:
    if module_name in sys.modules:
        return
    try:
        __import__(module_name)
    except Exception:
        sys.modules[module_name] = MagicMock(name=module_name)


_stub_if_unimportable("torch")
# transformers.DynamicCache is imported by oh_memos.memories.activation.item;
# a MagicMock module satisfies it without pulling the real (torch-backed) lib.
_stub_if_unimportable("transformers")

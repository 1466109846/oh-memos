"""Tests for credential redaction.

Two failure modes matter here and they pull in opposite directions:

- a miss leaks a live key into Neo4j/Qdrant, where every later search reads it
  back into the context window;
- an over-match silently corrupts ordinary memories (code snippets, paths,
  prose), and the corruption is invisible until someone reads the memory back.

So the false-positive cases below are as load-bearing as the detection ones.

Run: python3 -m pytest tests/test_redact.py -q
"""

from __future__ import annotations

import importlib.util
import re

from pathlib import Path

import pytest


# Loaded straight from the file rather than via `from oh_memos.security.redact
# import …`. Importing the package would run oh_memos/__init__.py, which pulls
# configs → mem_reader → transformers → torch; redact.py itself needs nothing
# but `os` and `re`. Keeping these tests free of the ML stack means they still
# run when that stack is broken — which is exactly when you want the security
# primitive to be verifiable.
_REDACT_PATH = Path(__file__).resolve().parents[1] / "src" / "oh_memos" / "security" / "redact.py"
_spec = importlib.util.spec_from_file_location("_redact_under_test", _REDACT_PATH)
_redact = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_redact)

redact_text = _redact.redact_text
redact_obj = _redact.redact_obj


# --------------------------------------------------------------------------
# Detection: each pattern fires on a realistically-shaped credential
# --------------------------------------------------------------------------

# Values are synthetic, but keep the exact prefix/length of the real thing —
# that structure is what the patterns anchor on.
DETECTION_CASES = [
    ("aws_access_key", "deploy failed with AKIAIOSFODNN7EXAMPLE in the env"),
    (
        "aws_secret_key",
        "aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYABCD",
    ),
    (
        "jwt",
        "cookie=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
        "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ."
        "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ),
    (
        "bearer_token",
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    ),
    (
        "github_fine_grained_pat",
        "remote url had github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz123456",
    ),
    ("github_token", "ghp_16C7e42F292c6912E7710c838347Ae178B4a"),
    ("anthropic_api_key", "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345"),
    ("openai_api_key", "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"),
    ("openai_api_key", "openai key sk-abcdefghijklmnopqrstuvwxyz0123"),
    # Built by concatenation so GitHub push protection does not flag the
    # synthetic sample as a live Slack token.
    ("slack_token", "xoxb-" + "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx"),
    ("google_api_key", "AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R"),
    (
        "private_key",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAvxQ1Z9k3\n",
    ),
    ("labelled_credential", "MEMOS_TOKEN = q7Wx2ZaP9LmN4kR8vT1yU6bC3dE5fG0h"),
]


@pytest.mark.parametrize(("label", "text"), DETECTION_CASES)
def test_detects_credential(label: str, text: str):
    cleaned, labels = redact_text(text)
    assert label in labels, f"{label} not detected in: {text!r}"
    assert "[REDACTED:" in cleaned


@pytest.mark.parametrize(("label", "text"), DETECTION_CASES)
def test_secret_body_is_gone(label: str, text: str):
    """The point of redaction: the secret must not survive in the output.

    A short prefix is deliberately kept so a human can tell *which* key leaked,
    so this checks that nothing beyond that prefix remains.
    """
    cleaned, _ = redact_text(text)
    # Find the longest credential-looking run in the original and confirm the
    # tail of it (everything past the retained hint) is no longer present.
    longest = max(re.findall(r"[A-Za-z0-9_\-/+]{16,}", text), key=len)
    assert longest not in cleaned, f"secret survived redaction: {longest!r}"


# --------------------------------------------------------------------------
# Pattern ordering — the specific prefix must win over the generic one
# --------------------------------------------------------------------------


def test_anthropic_key_not_labelled_as_openai():
    """`sk-ant-…` also matches the bare `sk-` branch; the specific one runs first."""
    _, labels = redact_text("sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345")
    assert labels == ["anthropic_api_key"]
    assert "openai_api_key" not in labels


def test_fine_grained_pat_not_labelled_as_classic_token():
    _, labels = redact_text("github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz123456")
    assert "github_fine_grained_pat" in labels
    assert "github_token" not in labels


# --------------------------------------------------------------------------
# Env-var-shaped labels — the most common way a key reaches a memory is a
# pasted env dump, where the credential word is glued to a prefix by `_`.
# `\b` does not match there (`_` is a word char), so this is regression-tested
# separately from the generic case above.
# --------------------------------------------------------------------------

ENV_DUMP_CASES = [
    "MEMOS_TOKEN = q7Wx2ZaP9LmN4kR8vT1yU6bC3dE5fG0h",
    "OPENAI_API_KEY=Zm9vYmFyYmF6cXV4Y29ycmdlZ3JhdWx0",
    "GITHUB_TOKEN: 8f3c1d9a7b5e2f4c6a8d0b3e5f7a9c1d3e5f7a9b",
    "DB_PASSWORD=p8Kd2Nf6Rt4Wq9Zx1Cv3Bn5Ml7Jh0Gs",
    "MY_APP_SECRET = 4c7f2a9e6b1d8c3f5a0e7b2d9c4f1a6e",
    "export ANTHROPIC_AUTH_TOKEN=aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
]


@pytest.mark.parametrize("text", ENV_DUMP_CASES)
def test_env_var_shaped_credential_is_caught(text: str):
    cleaned, labels = redact_text(text)
    assert labels, f"env-shaped credential missed: {text!r}"
    value = text.split("=" if "=" in text else ":", 1)[1].strip()
    assert value not in cleaned


def test_tokenizer_path_is_not_a_token():
    """The trailing \\b must still stop the label matching a longer word."""
    text = "tokenizer_path = /models/bge-large-zh-v1.5/tokenizer_config_files"
    cleaned, labels = redact_text(text)
    assert labels == []
    assert cleaned == text


# --------------------------------------------------------------------------
# False positives — ordinary memory content must pass through untouched
# --------------------------------------------------------------------------

CLEAN_CASES = [
    # Prose that merely mentions credentials.
    "The endpoint needs a Bearer token in the Authorization header.",
    "记忆写入前先做凭证脱敏,避免 API key 被向量化后反复读回上下文。",
    # Code that names credentials without containing one.
    "password = input('password: ')",
    "token = get_token()",
    "headers = {'Authorization': f'Bearer {token}'}",
    "if not os.getenv('OPENAI_API_KEY'): raise RuntimeError('missing key')",
    # Placeholders in docs and .env.example files.
    "OPENAI_API_KEY=your_key_here",
    "MEMOS_TOKEN=<paste-token>",
    "api_key: xxxxx",
    # Identifiers that are long and opaque but are not secrets.
    "memory ID: c44fd5c1-d808-4f47-9556-7f4f118b115f",
    "commit c47eefa4dad3cb129a5f39303e35f5289a042bc1 blocks secrets at commit time",
    "cube path /mnt/g/test/oh-memos/data/oh-memos_cubes/dev_cube/config.json",
    "import numpy as np  # AIza is a Google prefix, not a key",
]


@pytest.mark.parametrize("text", CLEAN_CASES)
def test_no_false_positive(text: str):
    cleaned, labels = redact_text(text)
    assert labels == [], f"false positive {labels} on: {text!r}"
    assert cleaned == text


# --------------------------------------------------------------------------
# Behaviour around the edges
# --------------------------------------------------------------------------


def test_surrounding_text_is_preserved():
    text = "启动失败,配置里写着 OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123 ,需要换 key"
    cleaned, labels = redact_text(text)
    assert labels == ["openai_api_key"]
    assert cleaned.startswith("启动失败,配置里写着 OPENAI_API_KEY=sk-abc")
    assert cleaned.endswith(",需要换 key")


def test_multiple_distinct_secrets_all_redacted():
    text = (
        "env dump:\n"
        "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123\n"
        "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n"
        "GH=ghp_16C7e42F292c6912E7710c838347Ae178B4a\n"
    )
    cleaned, labels = redact_text(text)
    assert set(labels) >= {"openai_api_key", "aws_access_key", "github_token"}
    assert cleaned.count("[REDACTED:") >= 3


def test_label_reported_once_per_kind():
    text = "sk-aaaaaaaaaaaaaaaaaaaaaaaa and sk-bbbbbbbbbbbbbbbbbbbbbbbb"
    _, labels = redact_text(text)
    assert labels.count("openai_api_key") == 1


def test_redaction_is_idempotent():
    """Re-running must not redact the placeholder it just produced."""
    once, labels_once = redact_text("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123")
    twice, labels_twice = redact_text(once)
    assert twice == once
    assert labels_twice == []
    assert labels_once == ["openai_api_key"]


def test_empty_and_none_are_safe():
    assert redact_text("") == ("", [])
    assert redact_text(None) == (None, [])


def test_disabled_by_env(monkeypatch):
    monkeypatch.setenv("MEMOS_REDACT_SECRETS", "false")
    text = "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123"
    assert redact_text(text) == (text, [])


@pytest.mark.parametrize("value", ["true", "TRUE", "1", "", "anything-else"])
def test_enabled_unless_explicitly_disabled(monkeypatch, value: str):
    monkeypatch.setenv("MEMOS_REDACT_SECRETS", value)
    _, labels = redact_text("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123")
    assert labels == ["openai_api_key"]


# --------------------------------------------------------------------------
# redact_obj — used for structured payloads (tool responses, memory dicts)
# --------------------------------------------------------------------------


def test_redact_obj_walks_nested_structures():
    payload = {
        "memories": [
            {"content": "key is sk-abcdefghijklmnopqrstuvwxyz0123", "score": 0.91},
            {"content": "no secret here", "score": 0.4},
        ],
        "meta": ("AKIAIOSFODNN7EXAMPLE", 42, None),
    }
    out, labels = redact_obj(payload)
    assert set(labels) == {"openai_api_key", "aws_access_key"}
    assert "sk-abcdefghijklmnopqrstuvwxyz0123" not in out["memories"][0]["content"]
    assert out["memories"][1]["content"] == "no secret here"
    assert out["memories"][0]["score"] == 0.91
    assert "AKIAIOSFODNN7EXAMPLE" not in out["meta"][0]
    assert out["meta"][1] == 42
    assert out["meta"][2] is None


def test_redact_obj_preserves_container_types():
    out, labels = redact_obj({"a": ["x"], "b": ("y",)})
    assert labels == []
    assert isinstance(out["a"], list)
    assert isinstance(out["b"], tuple)


def test_redact_obj_reports_each_label_once():
    payload = {"a": "ghp_16C7e42F292c6912E7710c838347Ae178B4a", "b": ["ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}
    _, labels = redact_obj(payload)
    assert labels == ["github_token"]


def test_redact_obj_leaves_clean_payload_untouched():
    payload = {"content": "普通记忆内容", "tags": ["memory", "graph"], "score": 1}
    out, labels = redact_obj(payload)
    assert labels == []
    assert out == payload

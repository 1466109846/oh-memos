"""Credential redaction for memory content.

Memories are written automatically by AI assistants from whatever context they
happen to be holding — error traces, config snippets, shell output. A key that
slips in is worse than a key in a file: it is embedded, indexed, and then read
back into the context window on *every* subsequent search.

So redaction happens on the way in (before Neo4j/Qdrant) and can also be used
on the way out. Patterns anchor on structural prefixes (AKIA, sk-, ghp_, eyJ…)
rather than entropy alone, so ordinary code and prose don't trip them.

Disable with MEMOS_REDACT_SECRETS=false (not recommended).

Credit: pattern set informed by jcodemunch-mcp's response-level redaction,
including its hard-won ordering/false-positive notes.
"""

from __future__ import annotations

import os
import re

from typing import Any


# Each pattern needs a named group `secret` marking the span to replace.
# Order matters: more specific prefixes must precede the generic ones
# (sk-ant- before the bare sk- branch, github_pat_ before gh[pousr]_).
_PATTERNS: list[tuple[str, re.Pattern]] = [
    # AWS access key IDs — always AKIA + 16 uppercase/digits
    ("aws_access_key", re.compile(r"(?<![A-Za-z0-9/+])(?P<secret>AKIA[0-9A-Z]{16})(?![A-Za-z0-9/+])")),
    # AWS secret keys — 40-char base64 only when a key-like label precedes it
    ("aws_secret_key", re.compile(
        r"(?i)(?:aws_secret|secret_access_key|aws_secret_access_key)[\s:=\"']+(?P<secret>[A-Za-z0-9/+=]{40})"
    )),
    # JWTs — three dot-separated base64url segments
    ("jwt", re.compile(r"(?P<secret>eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-]{10,})")),
    # Bearer tokens: require the Authorization prefix. Matching a bare "Bearer"
    # false-positives on prose that merely mentions the word.
    ("bearer_token", re.compile(r"(?i:authorization)\s*[:=]\s*Bearer\s+(?P<secret>[A-Za-z0-9_\-\.]{20,})")),
    # GitHub fine-grained PATs — different prefix shape from the classic tokens,
    # so this must be its own pattern and must come first.
    ("github_fine_grained_pat", re.compile(r"(?P<secret>github_pat_[A-Za-z0-9_]{20,})")),
    ("github_token", re.compile(r"(?P<secret>gh[pousr]_[A-Za-z0-9_]{20,})")),
    # Anthropic before OpenAI: the bare sk- branch would otherwise swallow it.
    ("anthropic_api_key", re.compile(r"(?P<secret>sk-ant-[A-Za-z0-9_-]{20,})")),
    ("openai_api_key", re.compile(r"(?P<secret>sk-(?:proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20,}))")),
    ("slack_token", re.compile(r"(?P<secret>xox[bpasor]-[A-Za-z0-9\-]{10,})")),
    ("google_api_key", re.compile(r"(?P<secret>AIza[A-Za-z0-9_\-]{35})")),
    ("private_key", re.compile(
        r"(?P<secret>-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]{0,64})"
    )),
    # Generic labelled assignment — last resort, requires a credential-ish name
    # AND a long opaque value, so `password = input()` or short placeholders pass.
    #
    # The leading boundary is a lookbehind rather than \b on purpose: secrets
    # usually arrive as env dumps (MEMOS_TOKEN=…, OPENAI_API_KEY=…, DB_PASSWORD=…)
    # and `_` is a word character, so \b would refuse to match the label that is
    # glued to a prefix — silently missing the most common shape of all. The
    # trailing \b stays, so `tokenizer_path = …` still doesn't trip it.
    ("labelled_credential", re.compile(
        r"(?i)(?<![A-Za-z0-9])(?:api[_-]?key|apikey|secret|token|passwd|password|access[_-]?key)\b"
        r"\s*[:=]\s*[\"']?(?P<secret>[A-Za-z0-9/+_\-]{24,})"
    )),
]

_PLACEHOLDER_LEN = 6  # keep a short prefix so humans can still recognise which key


def _enabled() -> bool:
    return os.getenv("MEMOS_REDACT_SECRETS", "true").strip().lower() not in ("false", "0", "no")


def redact_text(text: str) -> tuple[str, list[str]]:
    """Return (redacted_text, labels_found). Leaves text untouched when disabled."""
    if not text or not _enabled():
        return text, []
    found: list[str] = []
    result = text
    for label, pattern in _PATTERNS:
        def _sub(m: re.Match) -> str:
            secret = m.group("secret")
            hint = secret[:_PLACEHOLDER_LEN]
            if label not in found:
                found.append(label)
            return m.group(0).replace(secret, f"{hint}…[REDACTED:{label}]")

        result = pattern.sub(_sub, result)
    return result, found


def redact_obj(obj: Any) -> tuple[Any, list[str]]:
    """Recursively redact strings inside dicts/lists.

    Mirrors :func:`redact_text`'s contract — ``(cleaned, labels_found)`` — so a
    caller can log *which* kind of credential showed up. Only values are walked;
    dict keys are structural and a secret hiding in one would be pathological.
    """
    found: list[str] = []

    def _walk(node: Any) -> Any:
        if isinstance(node, str):
            cleaned, labels = redact_text(node)
            for label in labels:
                if label not in found:
                    found.append(label)
            return cleaned
        if isinstance(node, dict):
            return {k: _walk(v) for k, v in node.items()}
        if isinstance(node, (list, tuple)):
            return type(node)(_walk(v) for v in node)
        return node

    return _walk(obj), found

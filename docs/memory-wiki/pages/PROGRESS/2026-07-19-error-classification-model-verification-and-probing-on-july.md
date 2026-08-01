---
generator: oh-memos-wiki-export
id: 1660c564-eba8-4f56-9c39-3bb8ef4feefc
type: PROGRESS
status: activated
tags: ["error classification", "fallback", "exponential backoff", "deepseek-v4-pro", "verification", "probe", "write-after-read", "LLM", "oh-memos", "model switch", "auto downgrade"]
confidence: 0.66
created: 2026-07-19T21:21:41.836066000+00:00
updated: 2026-07-19T21:21:41.836066000+00:00
---

# Error Classification, Model Verification, and Probing on July 11 2026",
  "memory_type": "UserMemory",
  "value": "The u

The user defined explicit error‑classification rules that treat time‑outs, connection errors, WinError 10053‑10054, and 5xx server responses as transient errors, and treat 429 rate‑limiting responses, insufficient balance/quota or arrears, and authentication errors 401‑403 as permanent errors. These rules were directly used as the basis for the classify_error function implemented in src/oh_memos/llms/fallback.py, enabling the FallbackLLM to apply exponential‑backoff retries for transient errors and to skip retries and degrade immediately for permanent errors. On July 11 2026 the user completed a comprehensive verification of the oh‑memos system: all offline unit tests passed, there were no circular imports, classify_error behaved correctly, timeout scenarios retried twice then degraded, quota‑exhausted scenarios degraded immediately, and the disabled state was returned unchanged. A full‑chain test showed that a POST /memories request returned HTTP 200 in about 8 seconds, the LLM correctly extracted key, tags, background, and summary, the resulting embedding was stored successfully in both Neo4j and Qdrant (vector_sync succeeded), and a POST /search request returned the expected results. No downgrade alerts or remnants of the old xiaorong model were observed, confirming that the main model deepseek‑v4‑pro was operating normally. Because this verification confirmed correct behavior, the user subsequently initiated several validation probes on the same day: at 00:38 on July 11 2026, the write‑after‑read consistency probe PROBE‑ZXQV7731 was run via the local gateway http://localhost:3000/v1 to reproduce and check the previously reported “store‑then‑search miss” issue; at 12:35 the probe PROBE‑FIXV8842 was created and executed at 12:41 to test ORDER BY and top_k fixes; and at 13:44 the fast‑fallback probe PROBE‑FB9977 was launched to verify that, when the deepseek‑v4‑pro model timed out, the system automatically downgraded to LongCat‑2.0 within the MCP timeout and still saved memories correctly.",
  "tags": [
    "error classification",
    "fallback",
    "exponential backoff",
    "deepseek-v4-pro",
    "verification",
    "probe",
    "write-after-read",
    "LLM",
    "oh-memos",
    "model switch",
    "auto downgrade"
  ],
  "summary": "The user established clear rules for classifying errors as transient or permanent, and used these rules to build the classify_error logic in the new fallback subsystem, allowing the system to retry transient failures with exponential backoff while immediately degrading on permanent ones. On July 11 2026, a thorough verification of the oh‑memos platform confirmed that all unit tests passed, the classification worked, timeout and quota scenarios behaved as expected, and the deepseek‑v4‑pro model performed flawlessly in end‑to‑end requests, with correct extraction, embedding, and search results. Following this successful verification, the user conducted a series of probes later that day—including a write‑after‑read consistency test, an ORDER BY/top_k fix test, and a fast‑fallback test—to ensure the system’s reliability and automatic downgrade mechanisms functioned as intended.

## 关联

- 被相关 ← [[2026-07-11-写后读一致性探针测试]]
- 被后续 ← [[2026-07-11-写后读一致性探针测试]]
- 被导致 ← [[2026-07-11-llm主模型切换为deepseek-v4-pro]]
- 被后续 ← [[2026-07-11-llm主模型切换为deepseek-v4-pro]]

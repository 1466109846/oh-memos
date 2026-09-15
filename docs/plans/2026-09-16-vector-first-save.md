# Vector-first Memory Save Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** MCP memory saves acknowledge durable original-text vector storage without waiting for LLM extraction; extraction continues automatically in the background.

**Architecture:** The `/memories` content-write path stores a stable raw LongTermMemory and its vector before returning. A bounded background worker finds pending records in the existing graph, extracts metadata without changing the raw text/vector or allocating replacement IDs, and records completion or retry state. No new database service is required.

**Tech Stack:** Python 3.10+, FastAPI 0.115, Neo4j 5 / Qdrant 1.16, Node.js 20+ / TypeScript 5 / Vitest 3.

---

## Evidence and scope

- On 2026-09-16, two AudioCraft saves took 210.276s and 206.672s; the caller's `MEMOS_TIMEOUT_TOOL=120` expired while `/health` remained healthy. Both writes later completed.
- The user explicitly chose vector-first acknowledgement and background LLM parsing, including calls taking five minutes. Increasing client timeouts is not the selected solution.
- Existing `MemoryManager` and community graph insertion paths can swallow vector failures or return allocated rather than persisted IDs. The new foreground write needs an explicit confirmed-storage primitive.
- Apply the behavior to API `memory_content` writes used by MCP. Keep the existing library/chat/document ingestion contracts available.
- Preserve prior unrelated uncommitted work. Do not change LLM models, credentials, or client timeout settings.

## Task 1: Confirmed storage

**Files:** `src/oh_memos/graph_dbs/neo4j.py`, `src/oh_memos/graph_dbs/neo4j_community.py`, `src/oh_memos/vec_dbs/qdrant.py`, `tests/test_confirmed_vector_write.py`.

1. Write failing tests for vector errors, confirmed IDs, duplicate IDs, graph-write rollback, and conditional metadata updates.
2. Add `add_node_confirmed(id, memory, metadata, user_name=None) -> str`. Preserve the provided stable ID, require vector persistence in Community/Qdrant, and propagate storage failures. Repeated confirmed writes must retain existing enrichment.
3. Add `update_node_if_current(id, expected_memory, fields, user_name=None) -> bool` for metadata-only enrichment. Do not recreate deleted records, change raw text/vector, or overwrite a record whose content changed.
4. Make Qdrant write completion explicit with `wait=True`.
5. Run the focused storage tests; review failure handling and tenant isolation.

## Task 2: Background extraction

**Files:** new `src/oh_memos/mem_os/enrichment.py`, `src/oh_memos/mem_reader/simple_struct.py`, new `tests/test_background_enrichment.py`.

1. Write event-based tests proving foreground work completes while extraction is blocked and worker concurrency is bounded.
2. Extract metadata using the existing prompts without embedding or rewriting the parsed text. Invalid/failed extraction must be observable, rather than silently reported as completed.
3. Persist pending/completed/failed state on the original record. Retry transient failures with bounded attempts and delays; pending records remain recoverable when the process restarts.
4. Preserve business tags, source metadata, original text, and stable IDs; merge extracted keys/tags/background onto the same record.
5. Run tests for failures, recovery, duplicates, and a record deleted/edited while extraction is running.

## Task 3: API foreground path

**Files:** `src/oh_memos/mem_os/core.py`, `src/oh_memos/api/start_api.py`, `tests/test_memory_write_contract.py`, new `tests/test_vector_first_save.py`.

1. Add a content-write branch that creates the raw embedding using the cube's embedder and uses confirmed storage before scheduling extraction.
2. Return real `memory_ids`, `vector_saved=true`, `enrichment_status=pending`, and `queued=false` (the memory itself is already durable).
3. Start/resume workers for loaded cubes and recover local projects from the persistent cube registry; shut down polling promptly without waiting for multi-minute LLM calls. Serialize registration/unregistration so recovery cannot undo an explicit unload.
4. Exercise the HTTP response boundary with extraction blocked. Verify a vector failure cannot yield a successful acknowledgement.

## Task 4: MCP response and documentation

**Files:** `mcp-server-node/src/memory-write-response.ts`, `mcp-server-node/src/handlers/memory.ts`, their tests, and `mcp-server-node/README.md`.

1. Parse the additive vector/enrichment fields while retaining old API compatibility.
2. Acknowledge stored/searchable memory and mention pending background parsing; never wait for parsing or retry an already acknowledged write.
3. Reject an explicitly unconfirmed vector write, and retain the existing safe non-replay behavior for ambiguous POST failures.
4. Document the two phases and recovery semantics.

## Review refinements

- Persist completed attempts rather than counting a call interrupted by shutdown, so the final attempt remains recoverable.
- Restore all original metadata when only the vector remains, including archived status and creation time.
- Support strict metadata extraction in SimpleStruct, StrategyStruct, and MultiModalStruct without changing their prompts.
- Mark original records with `ingestion_mode=vector_first`; graph conflict resolution may link them but cannot merge, archive, or delete them.
- Stop the previous enrichment worker when `/configure` replaces the Core instance.
- Distinguish response deadlines (`API_TIMEOUT`) from connectivity failures, preserving the existing no-replay rule for ambiguous writes.

## Verification and rollout

- Run the targeted Python tests and existing write/relation contracts in an environment with the project dependencies.
- Run `npm run build`, the full Vitest suite, and MCP protocol smoke tests.
- Review the diff, tenant isolation, error propagation, and pending-work recovery.
- Set `PYTHONPATH=/app/src` in the development Compose override and mount only `src/oh_memos`: a source mount alone still imports the installed image package, while mounting all of `src` lets the host `.env` override container paths. Recreate only the API service to apply the environment/mount, then verify the actual module path and database health.
- Use MCP to save the actual fix record; verify fast acknowledgement, immediate retrieval, and eventual enrichment of that same ID.
- Record conclusions via `memos_save(memory_type="BUGFIX", project_path="/mnt/g/test/oh-memos")` only.

## Verification results (2026-09-16)

- Python: 118 tests passed in the recreated API container (5.43s); only existing dependency deprecation warnings.
- Node: all 582 tests in 45 files passed (13.30s); TypeScript build passed. Legacy and v2 MCP protocol smoke checks passed.
- Real MCP save returned in 596ms with ID `d05249b9-2227-51fb-bdb8-27a07aedc3a3`. An immediate MCP get completed in 35ms and returned the full original text.
- Background LLM extraction took about 225s, including primary-model timeout and fallback, then added key/tags/background to the same ID. The original content was unchanged.
- A fresh MCP process using the rebuilt server and the v2 client repeated the same save in 362ms. It returned the same ID and `vector saved`, retained completed enrichment, and preserved the original text, creation timestamp, title and tags.
- The live check exposed an existing MCP display issue: full details labeled `updated_at` as Created. `toFull()` now prefers the original creation timestamp, with legacy fallback when absent; list/compaction behavior is unchanged. Eight focused regression tests cover this distinction.
- Container imports now resolve to `/app/src/oh_memos`, with only the Python package mounted. The host `src/.env` is excluded. Neo4j and Qdrant health checks passed; the existing image, database services and data volumes were retained.
- The API fix is active locally. Existing MCP processes must load the rebuilt server to gain the new acknowledgement/error text and corrected creation-time display.

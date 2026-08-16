# Changelog

All notable changes to `oh-memos-mcp` are documented here.

This project follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Fixed

- **Auto-discovered `.env` no longer overrides launcher environment.** A `.env`
  found in the working directory or package root now only fills missing values,
  so MCP client `env` blocks and shell exports such as `MEMOS_PROVIDER=local`
  stay in effect. A file selected explicitly through `MEMOS_ENV_FILE` or
  `--memos-env-file` remains authoritative.

### Added

- **Local Lite provider.** `MEMOS_PROVIDER=local` (implied by `MEMOS_MODE=lite`)
  serves `memos_save`, `memos_get`, `memos_list_v2`, `memos_search`, and
  `memos_context_resume` from a per-cube `memories.jsonl` with deterministic
  lexical ranking, durable appends, and a cross-process lock. Graph, Think,
  Wiki, and admin tools report `LOCAL_PROVIDER_UNSUPPORTED` rather than
  pretending a graph backend exists.

- **Skill candidate lifecycle.** `memos_review_skill_candidate` records
  approve/reject with reviewer audit metadata, and
  `memos_install_skill_candidate` installs only approved candidates into
  `.claude/skills/<slug>/SKILL.md` without overwriting, following symlinks, or
  executing anything.

- **Explainable graph provenance.** `memos_graph(mode="related"|"path"|"impact")`
  now reports normalized evidence categories (`EXTRACTED`, `INFERRED`,
  `AMBIGUOUS`, or `UNKNOWN`) and includes confidence, evidence references,
  source file/location, extractor version and verification time when those
  fields exist. Legacy graph data without provenance remains readable and is
  reported as `UNKNOWN` rather than assigned invented evidence.

- **`memos_graph(mode="import")` Graphify boundary.** Accepts up to 5 MB of
  Graphify/NetworkX node-link JSON through `graph_json`, validates `nodes` plus
  `links` (or the `edges` alias), and produces a deterministic import plan with
  portable stable Code Graph ids. Duplicate ids, dangling edges, unsafe source
  paths, invalid confidence values and oversized graphs are rejected before
  any persistence boundary. This mode is intentionally **dry-run only**: it
  never writes to Neo4j, Qdrant or a memory cube.

- **`memos_canvas`** — a symbolic task canvas: short-term task state that survives
  context compaction. One Mermaid file per task under
  `{MEMOS_CUBES_DIR}/{cube_id}/canvas/`, whose nodes carry a greppable id
  (`000-N1`) and an optional `ref` anchoring them to evidence:
  `mem:<memory_id>` (a memory in the graph), `file:<path>` (any file, including
  the large tool results the harness already offloads), or `note:<text>`.

  `action`: `open` (needs `goal`) · `update` (appends a node; `node_id` edits one
  in place) · `show` · `list`.

  Canvases are deliberately **not** written to Neo4j or Qdrant. A canvas changes
  several times an hour, and paying an embedding round trip for a `doing→done`
  flip would be absurd. Durable facts still go through `memos_save`; the canvas
  points at them with a `mem:` ref.

  This is **not** a token-saving feature. The design it borrows from
  ([TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory))
  achieves its reduction by intercepting and replacing tool output before the
  model sees it, which a Claude Code hook cannot do — `PreToolUse` can rewrite a
  tool's *input* via `updatedInput`, but no hook can rewrite its *output*. What
  this offers instead is task state that survives compaction, and a path from a
  summary back to the evidence behind it.

  Node ids and canvas prefixes are allocated as max+1 and **never reuse a gap**:
  a deleted `000-N2` may still be cited from a commit message, a memory body or
  another node's ref, and handing that id to a new node would silently repoint
  every one of those citations.

- `memos_context_resume` now lists **unfinished** canvases first — headlines and
  counts only, a few dozen tokens — so the first thing visible after a compaction
  is the open work rather than a memory feed. Injecting canvas bodies here would
  rebuild the very context bloat the canvas exists to avoid; the model opens what
  it needs with `show`.

- **Test infrastructure.** This package previously had none: no test script, no
  `*.test.ts`. Adds vitest and `npm test`, with 65 unit tests covering the
  parse/render round trip, node-id allocation, Mermaid label injection, path
  traversal refusal and atomic writes. `scripts/canvas-e2e.mjs` adds 18 checks
  driven over real MCP stdio rather than mocks.

- `MEMOS_ENV_FILE` env var and `--memos-env-file` flag, to point the server at an
  explicit `.env`. Previously the file was located only by guessing from position
  (cwd, two levels above the package, dotenv's upward search) — which works from
  a checkout and never works under `npx`, where the package root sits in the npm
  cache and every candidate misses, loading not one variable. A path that does
  not exist now warns on stderr rather than falling through silently.

### Fixed

- `toLocalPath()` rewrote Windows cube paths to `/mnt/...` unconditionally. That
  mapping only resolves inside WSL; under native Windows Node the result is not
  absolute, so it resolved against the current drive and every cube write landed
  in a phantom tree while the API kept reading the real path. Registration
  reported success, then `/search` and `/memories` failed 400 — the loaded cube
  had no memory backend.

### Security

- `canvasPath` is the one place caller text becomes a filesystem path. It uses a
  **whitelist** (`[a-z0-9-]`) rather than a blacklist of dangerous characters,
  because a blacklist is always missing an entry. `.` is outside the whitelist,
  so `..` cannot survive it — traversal is structurally impossible rather than
  merely checked for — and a post-resolve containment check backs that up
  independently. `cube_id` is treated as untrusted too, since it is derived from
  a caller-supplied `project_path`.

### Documentation

- The `alwaysAllow` example carried two defects. `memos_search` appeared twice,
  and several entries were **call forms** — `memos_admin(action=list_cubes)` and
  the like. `alwaysAllow` matches tool names, so those entries matched nothing:
  a reader would believe those calls were pre-approved and still be prompted for
  every one. Replaced with bare tool names, which auto-approve every action of
  the tool.
- `memos_delete` was dropped from that example, which also set
  `MEMOS_ENABLE_DELETE: "true"` — together they auto-approve deleting memories
  with no prompt. Enabling that is a decision worth making deliberately.
- The `.env` note claimed the working directory's file loads "automatically with
  highest priority". Under `npx` no file loads at all. Documented `MEMOS_ENV_FILE`
  and what actually happens.

### Notes

- Tool surface grew 12488 B → 13680 B (+9.5%), past the +5% drift budget, and the
  baseline was re-frozen. This is the cost of a new tool rather than description
  drift; the description was trimmed from 1333 B to 1192 B first, moving detail
  into `show`'s output (the same move `memos_suggest` made with the memory-type
  decision tree).
- `tsconfig.json` now excludes `src/**/*.test.ts`. Without it the test files
  compile into `dist` and ship with `npm publish`.

---

## [2.0.1] — 2026-08-02

### Fixed

- MCP `serverInfo` was hardcoded in `server.ts` and reported
  `{name: "memos-memory", version: "1.0.1"}` — a name matching neither the
  package (`oh-memos-mcp`) nor the conventional server key (`oh-memos`), and a
  version that 2.0.0 shipped stale. Clients display this during the handshake.
  It is now read from `package.json` at startup, so it cannot drift again.

---

## [2.0.0] — 2026-08-02

### ⚠️ Breaking — tool surface consolidated from 18 to 10

Eleven tools were merged into three dispatching tools. **There is no compatibility
shim**: the MCP SDK only dispatches registered tools, so calling a removed name now
returns `Unknown tool`.

If your MCP client config pins tool names (e.g. Claude Code's `alwaysAllow` list),
you must update it before upgrading.

#### Migration

| 1.x tool | 2.0 replacement |
|----------|-----------------|
| `memos_search_context` | `memos_search` — pass the `context` array (recent turns) |
| `memos_get_graph` | `memos_graph(mode="related")` |
| `memos_trace_path` | `memos_graph(mode="path")` |
| `memos_impact` | `memos_graph(mode="impact")` |
| `memos_export_schema` | `memos_graph(mode="schema")` |
| `memos_list_cubes` | `memos_admin(action="list_cubes")` |
| `memos_register_cube` | `memos_admin(action="register_cube")` |
| `memos_create_user` | `memos_admin(action="create_user")` |
| `memos_validate_cubes` | `memos_admin(action="validate_cubes")` |
| `memos_get_stats` | `memos_admin(action="stats")` |
| `memos_calendar` | `memos_admin(action="calendar")` |

Unchanged: `memos_context_resume`, `memos_search`, `memos_save`, `memos_list_v2`,
`memos_get`, `memos_suggest`, `memos_delete`.

`alwaysAllow` for 2.0:

```json
"alwaysAllow": [
  "memos_context_resume", "memos_search", "memos_save",
  "memos_list_v2", "memos_get", "memos_suggest",
  "memos_think", "memos_graph", "memos_admin", "memos_export_wiki"
]
```

### Added

- **`memos_think`** — evidence pack for a question. Runs semantic retrieval plus a
  recent-72h temporal pass, deduplicates, and returns numbered evidence with graph
  relationships between items, contradiction/evolution candidates, staleness
  candidates, and gap analysis. Synthesis is deliberately left to the calling model;
  the server emits no prose. Results can be persisted back as `SYNTHESIS`.
- **`memos_export_wiki`** — export a cube as an interlinked markdown wiki: one page
  per memory (YAML frontmatter, `[[wikilink]]` relations), plus `index.md` and a
  mermaid `graph.md`. Only files carrying the generator marker are ever replaced;
  foreign files in the output directory are preserved. Defaults to
  `<project_path>/docs/memory-wiki`.
- **`SYNTHESIS`** memory type, for answers synthesized from retrieved evidence.

### Changed

- Tool-surface cost dropped ~51%: `tools/list` payload 22.9 KB → 11.2 KB
  (≈5850 → ≈2856 tokens). Shared `project_path` / `cube_id` parameter descriptions
  were deduplicated; the full cube-routing rules are now stated once, on
  `memos_save` and `memos_search`.
- Runtime error `suggestions` now name the 2.0 call forms, so a model reading a
  failure message is no longer told to call a tool that does not exist.

### Fixed

- `memos_admin`'s `cube_id` no longer carries a `MEMOS_DEFAULT_CUBE` default.
  Previously, calling `register_cube` without `cube_id` would silently register the
  default cube instead of failing.

---

## [1.0.0] — 2026-03-04

Initial npm release. 18 tools, Node-only MCP server for oh-memos — no Python
required, runs via `npx`.

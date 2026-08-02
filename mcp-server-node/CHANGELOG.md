# Changelog

All notable changes to `oh-memos-mcp` are documented here.

This project follows [Semantic Versioning](https://semver.org/).

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

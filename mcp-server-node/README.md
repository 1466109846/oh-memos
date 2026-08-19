# oh-memos-mcp

[![npm version](https://img.shields.io/npm/v/oh-memos-mcp.svg)](https://www.npmjs.com/package/oh-memos-mcp)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

MCP Server for **oh-memos** — Intelligent Persistent Memory for AI Assistants.

Pure Node.js. No Python required. Works with `npx` out of the box.

> **3.0:** requires Node.js 20+, serves legacy 2025-era and MCP `2026-07-28`
> clients from the same stdio package, and requires no data migration. Still on
> Node 18? Pin `oh-memos-mcp@2` until you can upgrade the runtime.

---

## Prerequisites

- **Node.js 20 or newer**

```bash
npx -y oh-memos-mcp        # 3.x, npm latest — needs Node.js 20+
npx -y oh-memos-mcp@2      # 2.x maintenance line — still runs on Node.js 18
```

oh-memos backend API must be running before connecting this MCP server:

- **oh-memos API** on `http://localhost:18000`
- **Neo4j** on `localhost:7687` (Knowledge Graph)
- **Qdrant** on `localhost:6333` (Vector Search)

> Start all services: run `scripts\local\start.bat` from the [oh-memos repo](https://github.com/lsg1103275794/oh-memos).

---

## Quick Start

Add to your Claude Code `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "oh-memos": {
      "command": "npx",
      "args": ["-y", "oh-memos-mcp"],
      "env": {
        "MEMOS_URL": "http://localhost:18000",
        "MEMOS_USER": "dev_user",
        "MEMOS_DEFAULT_CUBE": "dev_cube",
        "MEMOS_CUBES_DIR": "G:/test/oh-memos/data/oh-memos_cubes"
      }
    }
  }
}
```

Or use a `.env` file in your working directory (the server auto-discovers it):

```bash
cp node_modules/oh-memos-mcp/.env.example .env
# Edit .env with your paths
npx -y oh-memos-mcp
```

---

## Configuration Examples

### Linux / macOS

```json
{
  "mcpServers": {
    "oh-memos": {
      "command": "npx",
      "args": ["-y", "oh-memos-mcp"],
      "env": {
        "MEMOS_URL": "http://localhost:18000",
        "MEMOS_USER": "dev_user",
        "MEMOS_DEFAULT_CUBE": "dev_cube",
        "MEMOS_CUBES_DIR": "/home/user/oh-memos/data/oh-memos_cubes"
      }
    }
  }
}
```

### Windows

```json
{
  "mcpServers": {
    "oh-memos": {
      "command": "npx",
      "args": ["-y", "oh-memos-mcp"],
      "env": {
        "MEMOS_URL": "http://localhost:18000",
        "MEMOS_USER": "dev_user",
        "MEMOS_DEFAULT_CUBE": "dev_cube",
        "MEMOS_CUBES_DIR": "G:/test/oh-memos/data/oh-memos_cubes"
      }
    }
  }
}
```

### WSL2

```json
{
  "mcpServers": {
    "oh-memos": {
      "command": "npx",
      "args": ["-y", "oh-memos-mcp"],
      "env": {
        "MEMOS_URL": "http://localhost:18000",
        "MEMOS_USER": "dev_user",
        "MEMOS_DEFAULT_CUBE": "dev_cube",
        "MEMOS_CUBES_DIR": "/mnt/g/test/oh-memos/data/oh-memos_cubes"
      }
    }
  }
}
```

### With `alwaysAllow` (skip per-tool confirmation)

`alwaysAllow` matches **tool names**, so a call form like
`memos_admin(action=list_cubes)` matches nothing — list the bare name and every
action of that tool is auto-approved.

`memos_delete` is deliberately absent below. Auto-approving it means memories can
be deleted without a prompt; add it only if you have decided you want that.

```json
{
  "mcpServers": {
    "oh-memos": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "oh-memos-mcp"],
      "env": {
        "MEMOS_URL": "http://localhost:18000",
        "MEMOS_USER": "dev_user",
        "MEMOS_DEFAULT_CUBE": "dev_cube",
        "MEMOS_CUBES_DIR": "/path/to/oh-memos/data/oh-memos_cubes"
      },
      "alwaysAllow": [
        "memos_context_resume",
        "memos_search",
        "memos_save",
        "memos_list_v2",
        "memos_get",
        "memos_suggest",
        "memos_think",
        "memos_graph",
        "memos_admin",
        "memos_export_wiki",
        "memos_canvas"
      ]
    }
  }
}
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MEMOS_URL` | Yes | — | oh-memos API base URL |
| `MEMOS_USER` | Yes | — | Default user ID |
| `MEMOS_DEFAULT_CUBE` | Yes | — | Default memory cube ID |
| `MEMOS_CUBES_DIR` | Yes | — | Absolute path to cubes storage directory |
| `MEMOS_TIMEOUT_TOOL` | No | `300` | Tool call timeout (seconds) |
| `MEMOS_TIMEOUT_STARTUP` | No | `30` | API startup wait timeout (seconds) |
| `MEMOS_TIMEOUT_HEALTH` | No | `5` | Health check timeout (seconds) |
| `MEMOS_API_WAIT_MAX` | No | `60` | Max time to wait for API on startup (seconds) |
| `MEMOS_ENABLE_DELETE` | No | `false` | Enable `memos_delete` tool |
| `NEO4J_HTTP_URL` | No | — | Neo4j HTTP endpoint (for direct graph queries) |
| `NEO4J_USER` | No | — | Neo4j username |
| `NEO4J_PASSWORD` | No | — | Neo4j password |
| `MEMOS_ENV_FILE` | No | — | Explicit path to a `.env` file. Highest priority — see below |

> **On locating `.env`**: without `MEMOS_ENV_FILE`, the file is found by guessing
> from position (working directory, two levels above the package, then dotenv's
> upward search). That works from a checkout and **never works under `npx`**,
> where the package root sits in the npm cache and every candidate misses — so no
> variable loads at all. Set `MEMOS_ENV_FILE` (or pass `--memos-env-file`) when the
> client's working directory and the install location are both outside the project.
> A path that does not exist warns on stderr rather than failing silently.
>
> Copy `.env.example` to get started.

---

## Tools (17)

The package defines 17 tool schemas. `memos_delete` is exposed by `tools/list`
only when `MEMOS_ENABLE_DELETE=true`; the other 16 are available by default.

<!-- mcp-tool-inventory:start -->
| Tool | Description |
|------|-------------|
| `memos_context_resume` | Recover project context after compaction (recent 24h + project state) |
| `memos_search` | Semantic search with keyword reranking. Pass `context` (recent turns) to enable LLM intent analysis and query expansion |
| `memos_save` | Save memories with explicit type (BUGFIX, DECISION, MILESTONE, SYNTHESIS…) |
| `memos_list_v2` | List memories with auto-compaction |
| `memos_get` | Get full memory details by ID |
| `memos_suggest` | Smart search query suggestions + `memory_type` decision tree |
| `memos_think` | Evidence pack for a question: retrieval + contradiction/staleness flags + gap analysis. The caller synthesizes the answer and may persist it as `SYNTHESIS` |
| `memos_graph` | Explainable graph queries plus strict Graphify node-link validation — `mode`: `related` / `path` / `impact` / `schema` / `import` |
| `memos_admin` | Maintenance — `action`: `list_cubes` / `register_cube` / `create_user` / `validate_cubes` / `stats` / `calendar` |
| `memos_export_wiki` | Export a cube as an interlinked markdown wiki (page per memory + index + mermaid graph) |
| `memos_import_wiki` | Import an exported wiki back into a cube; supports dry-run and versioning edited pages, never deletes memories |
| `memos_canvas` | Symbolic task canvas — short-term task state that survives context compaction. `action`: `open` / `update` / `show` / `list`. Nodes carry greppable ids (`000-N1`) and a `ref` anchoring them to evidence: `mem:<memory_id>` / `file:<path>` / `note:<text>` |
| `memos_distill_skill` | Create an inert, reviewable Skill candidate under `<project_path>/skill-candidates`; it never installs the candidate automatically |
| `memos_list_skill_candidates` | List generated Skill candidates without modifying or installing them |
| `memos_review_skill_candidate` | Approve or reject a candidate with reviewer audit metadata; approval does not install |
| `memos_install_skill_candidate` | Install an approved candidate only into `.claude/skills/<slug>/SKILL.md`, without overwrite or script execution |
| `memos_delete` | Delete selected or all memories. Disabled by default and requires explicit user confirmation when enabled |
<!-- mcp-tool-inventory:end -->

### `memos_graph` modes

| Mode | Main input | Result |
|------|------------|--------|
| `related` | `query` | Related memories and edges, with provenance explanations when available |
| `path` | `source_id`, `target_id` | A bounded path between two graph nodes, including relationship evidence |
| `impact` | `memory_id`, optional `max_depth` | Forward blast radius from one memory |
| `schema` | Optional `sample_size` | Graph structure and statistics |
| `import` | `graph_json`, optional `project_key` | Deterministic validation and dry-run plan for Graphify NetworkX node-link JSON |

`import` accepts at most 5 MB of JSON and rejects duplicate node ids, dangling
edges, unsafe source paths, invalid confidence values, and oversized graphs. It
does **not** write Code Graph nodes to Neo4j, Qdrant, or a memory cube.

---

## How .env Loading Works

Priority order for configuration values (highest first):

1. **CLI configuration flags** such as `--memos-url`
2. **Explicit env file** selected by `--memos-env-file` or inherited `MEMOS_ENV_FILE`
3. **Inherited process environment** — this is where MCP client `env` values belong
4. **Auto-discovered `process.cwd()/.env`** — provides only missing defaults
5. **Auto-discovered package-root `.env`** — provides only missing defaults
6. **dotenv upward fallback**, then built-in defaults

The automatic file search never overrides explicit MCP/launcher environment values. Use `MEMOS_ENV_FILE` only when the selected file should deliberately be authoritative; this is also the reliable option for `npx` installs.

---

## Development

```bash
git clone https://github.com/lsg1103275794/oh-memos.git
cd oh-memos/mcp-server-node
npm install
npm run dev    # Run with tsx (no build needed)
npm run build  # Compile to dist/
```

---

## Requirements

- Node.js >= 20.0.0
- oh-memos backend API running (`scripts\local\start.bat`)

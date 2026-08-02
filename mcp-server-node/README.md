# oh-memos-mcp

[![npm version](https://img.shields.io/npm/v/oh-memos-mcp.svg)](https://www.npmjs.com/package/oh-memos-mcp)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

MCP Server for **oh-memos** — Intelligent Persistent Memory for AI Assistants.

Pure Node.js. No Python required. Works with `npx` out of the box.

---

## Prerequisites

oh-memos backend API must be running before connecting this MCP server:

- **oh-memos API** on `http://localhost:18000`
- **Neo4j** on `localhost:7687` (Knowledge Graph)
- **Qdrant** on `localhost:6333` (Vector Search)

> Start all services: run `scripts\local\start.bat` from the [oh-memos repo](https://github.com/xigou/oh-memos).

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
npx oh-memos-mcp
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
        "MEMOS_CUBES_DIR": "/path/to/oh-memos/data/oh-memos_cubes",
        "MEMOS_ENABLE_DELETE": "true"
      },
      "alwaysAllow": [
        "memos_context_resume",
        "memos_search",
        "memos_search",
        "memos_save",
        "memos_list_v2",
        "memos_get",
        "memos_suggest",
        "memos_admin(action=list_cubes)",
        "memos_admin(action=stats)",
        "memos_graph(mode=related)",
        "memos_graph(mode=path)",
        "memos_graph(mode=schema)",
        "memos_admin(action=register_cube)",
        "memos_admin(action=create_user)",
        "memos_admin(action=validate_cubes)",
        "memos_graph(mode=impact)",
        "memos_admin(action=calendar)",
        "memos_delete"
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

> **Tip**: `.env` file in your working directory is loaded automatically with highest priority.
> Copy `.env.example` to get started.

---

## Tools (10)

| Tool | Description |
|------|-------------|
| `memos_context_resume` | Recover project context after compaction (recent 24h + project state) |
| `memos_search` | Semantic search with keyword reranking. Pass `context` (recent turns) to enable LLM intent analysis and query expansion |
| `memos_save` | Save memories with explicit type (BUGFIX, DECISION, MILESTONE, SYNTHESIS…) |
| `memos_list_v2` | List memories with auto-compaction |
| `memos_get` | Get full memory details by ID |
| `memos_suggest` | Smart search query suggestions + `memory_type` decision tree |
| `memos_think` | Evidence pack for a question: retrieval + contradiction/staleness flags + gap analysis. The caller synthesizes the answer and may persist it as `SYNTHESIS` |
| `memos_graph` | Knowledge graph queries — `mode`: `related` / `path` / `impact` / `schema` |
| `memos_admin` | Maintenance — `action`: `list_cubes` / `register_cube` / `create_user` / `validate_cubes` / `stats` / `calendar` |
| `memos_export_wiki` | Export a cube as an interlinked markdown wiki (page per memory + index + mermaid graph) |

Plus `memos_delete`, hidden from `tools/list` unless `MEMOS_ENABLE_DELETE=true`.

---

## How .env Loading Works

Priority order (highest first):

1. **`process.cwd()/.env`** — your project working directory
2. **Package root `.env`** — where oh-memos-mcp is installed
3. **dotenv default search** — walks up from cwd

This means you can place a `.env` in your project root and `npx oh-memos-mcp` will pick it up automatically — no need to repeat env vars in every MCP config.

---

## Development

```bash
git clone https://github.com/xigou/oh-memos.git
cd oh-memos/mcp-server-node
npm install
npm run dev    # Run with tsx (no build needed)
npm run build  # Compile to dist/
```

---

## Requirements

- Node.js >= 18.0.0
- oh-memos backend API running (`scripts\local\start.bat`)

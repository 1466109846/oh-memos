# Deployment modes | 部署架构

oh-memos has two memory architectures. Native Windows and host-database Docker are **Full-mode variants**, not separate memory providers.

## Choose a mode | 选择模式

| | Lite | Full |
|---|---|---|
| Runtime | Node.js MCP process | Node MCP + FastAPI/MOS |
| External services | None required | Qdrant + Neo4j; chat/embedding provider |
| Durable store | `<MEMOS_CUBES_DIR>/<cube>/memories.jsonl` | Cube files + Qdrant vectors + Neo4j graph |
| Search | Lexical by default; optional local Ollama embedding blend | Semantic/vector + lexical + graph context |
| Relations and graph queries | Not available | Available through `memos_graph` |
| LLM extraction | Not available | Available through the configured backend |
| Wiki export/import and remote admin | Not available in the local provider | Available through the Full API/provider |
| Canvas and typed save/list/get/search | Available | Available |
| Best for | A single developer, offline work, quick setup | Teams, causal context, semantic retrieval, and production-like use |

### Lite architecture

```text
AI client
    │ MCP / stdio
    ▼
Node MCP server
    │
    ▼
LocalJsonlProvider
    │
    └── <MEMOS_CUBES_DIR>/<cube>/memories.jsonl
```

Lite is a local Node.js path. It does **not** start or contact the Python API,
Neo4j, or Qdrant. The default search is deterministic lexical ranking. If a
local Ollama is reachable, the MCP process can optionally blend its embeddings;
embedding failure falls back to lexical search.

### Full architecture

```text
AI client
    │ MCP / stdio
    ▼
Node MCP server
    │ HTTP / JSON
    ▼
FastAPI + MOS/MOSCore
    ├── Qdrant  (semantic vectors)
    ├── Neo4j   (relations and graph context)
    └── cube files (config, canvas, wiki)
```

Full is the recommended path when the project needs semantic retrieval, graph
relationships, LLM extraction, Wiki round-trip, or graph/admin operations. The
recommended entry point is the Docker Compose stack:

```bash
docker compose --env-file docker/.env.docker \
  -f docker/docker-compose.yml up -d --build
```

See [DEPLOY_CN.md](DEPLOY_CN.md) or [DEPLOY_EN.md](DEPLOY_EN.md) for native
Windows and Docker operations. `docker/docker-compose.host-db.yml` is a Full
variant that makes the API container use Neo4j/Qdrant already running on the
host.

## Lite quick start | Lite 快速开始

Only Node.js 20+ is required. Configure the MCP server with the same `npx`
command used by Full, but set the local provider and omit `MEMOS_URL`:

```json
{
  "mcpServers": {
    "oh-memos": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "oh-memos-mcp"],
      "env": {
        "MEMOS_MODE": "lite",
        "MEMOS_PROVIDER": "local",
        "MEMOS_USER": "dev_user",
        "MEMOS_DEFAULT_CUBE": "dev_cube",
        "MEMOS_CUBES_DIR": "/absolute/path/to/oh-memos/data/oh-memos_cubes",
        "MEMOS_LITE_EMBED": "off"
      }
    }
  }
}
```

On Windows, use a JSON-safe path such as
`C:/work/oh-memos/data/oh-memos_cubes`. `MEMOS_LITE_EMBED=off` is optional;
remove it to allow the default local Ollama embedding fallback. You can tune
that fallback with `MEMOS_LITE_EMBED_URL` and `MEMOS_LITE_EMBED_MODEL`.

The first Lite calls to try are:

```text
memos_save(content="Keep the migration idempotent", memory_type="DECISION")
memos_search(query="migration idempotent")
memos_list_v2()
memos_get(memory_id="<id returned by search>")
```

No API health check is needed for Lite. `memos_graph`, `memos_think`, Wiki
round-trip, remote admin operations, and deletion remain Full-only.

## Migration boundary | 迁移边界

Lite JSONL is intentionally human-readable and easy to back up, but the project
does not silently copy it into Neo4j/Qdrant. To move to Full, back up the Lite
cube first, start the Full backend, then perform an explicit migration using a
reviewed importer or recreate selected memories with `memos_save`. Treat the
JSONL as source data and verify IDs, types, and timestamps before deleting the
Lite copy.

## Related guides | 相关指南

- [MCP configuration](MCP_GUIDE.md) — client-specific stdio configuration
- [Chinese deployment guide](DEPLOY_CN.md) — native Windows and Docker operations
- [English deployment guide](DEPLOY_EN.md) — native Windows and Docker operations
- [Architecture](../ARCHITECTURE.md) — runtime boundaries and code navigation

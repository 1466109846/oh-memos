# oh-memos Project Guide

> This file provides project-specific context to Codex.
> 保持中文交流

---

## Critical: Memory Operations via MCP Only

**禁止手动创建 memory 目录或文件。** 所有记忆操作必须通过 MCP oh-memos 工具完成。

如果你想运行 `mkdir -p .../memory` 或用 `Write` 创建记忆文件 → **停下来**,改用 MCP oh-memos 工具。

### Tools Available:
`oh-memos_context_resume`, `oh-memos_search`(可带 `context` 做上下文感知检索), `oh-memos_save`, `oh-memos_list_v2`, `oh-memos_get`, `oh-memos_suggest`, `oh-memos_think`(证据包+缺口分析), `oh-memos_graph`(`mode`: related/path/impact/schema), `oh-memos_admin`(`action`: list_cubes/register_cube/create_user/validate_cubes/stats/calendar), `oh-memos_export_wiki`

### Cube Routing (CRITICAL)

每个项目有自己的 memory cube。**必须传 `project_path` 参数**,让 MCP server 自动推导 cube_id。

推导规则: 取目录名 → 小写 → 替换 `-`/`.`/空格为 `_` → 追加 `_cube`

示例:
| 项目路径 | 自动推导 cube_id |
|---------|----------------|
| `/mnt/g/test/oh-memos` | `oh_memos_cube` |
| `/mnt/g/Cyber/AudioCraft Studio` | `audiocraft_studio_cube` |
| `~/projects/my-web-app` | `my_web_app_cube` |

```python
# 正确用法
oh-memos_save(content="...", memory_type="BUGFIX", project_path="/mnt/g/test/oh-memos")
oh-memos_search(query="...", project_path="/mnt/g/test/oh-memos")

# 错误用法 — 不要硬编码 dev_cube
oh-memos_save(content="...", cube_id="dev_cube")  # ✗
```

### Operational Workflow:
1. **Before Coding (Context Retrieval)**:
    - 在回答任何复杂问题或开始新功能前,**必须**使用 `oh-memos_search` 或 `oh-memos_list_v2` 检索项目记忆。
    - 上下文压缩后,调用 `oh-memos_context_resume` 恢复上下文。

2. **During Development (Dependency & Logic)**:
    - 识别当前项目的技术栈版本。
    - 如果发现现有记忆与当前代码冲突,使用 `oh-memos_graph`(mode=related)梳理关系。

3. **After Coding (Knowledge Consolidation)**:
    - 完成功能模块、修复 Bug 或达成技术决策后,**必须**使用 `oh-memos_save` 将关键信息写入记忆。
    - **必须显式指定 `memory_type` 参数**,不依赖自动检测。

### Memory Type 速查表
- Bug 修复 → `BUGFIX` 或 `ERROR_PATTERN`
- 技术决策 → `DECISION`
- 发现陷阱 → `GOTCHA`
- 代码模板 → `CODE_PATTERN`
- 配置变更 → `CONFIG`
- 完成里程碑 → `MILESTONE`
- 新增功能 → `FEATURE`
- 纯进度汇报 → `PROGRESS`

**详细操作规则、MCP 工具使用说明、决策树见 `/project-memory` skill**

---

## Project Overview

**oh-memos** is a persistent project memory solution for AI assistants, featuring:

- **MCP Server**: Proactive memory tools with project_path-based cube routing
- **Neo4j Knowledge Graph**: Structured memory with relationships (tree_text mode)
- **Qdrant Vector Database**: Semantic similarity search
- **LLM Memory Extraction**: Auto-extract key, tags, background, confidence
- **AI Graph Intelligence**: Path tracing, context-aware search, schema analysis
- **Smart Cube Management**: Auto-create, auto-register cubes from project path
- **Hooks System**: Session start, pre-compact, post-tool reminders (see `project-memory/hooks/`)

---

## Project Configuration

### Memory Cube (for oh-memos development itself)
- **Cube ID**: `oh_memos_cube` (auto-derived from project path)
- **Storage Path**: `data/oh-memos_cubes/dev_cube`
- **Usage**: `oh-memos_save(..., project_path="/mnt/g/test/oh-memos")`

### Memory Mode
- **Backend**: `tree_text` (Knowledge Graph)
- **Graph DB**: Neo4j Community Edition (localhost:7687)
- **Vector DB**: Qdrant Local (localhost:6333)

### Service Ports
| Service | Port | URL |
|---------|------|-----|
| oh-memos API | 18000 | http://localhost:18000/docs |
| Memory Admin GUI | 18010 | http://127.0.0.1:18010 (memory-admin.bat) |
| Qdrant | 16333 | http://localhost:16333/dashboard |
| Neo4j | 7474/7687 | http://localhost:7474 |
| Ollama | 11434 | http://localhost:11434 |

---

## Hooks for Users

oh-memos provides Codex hooks in `project-memory/hooks/node/`. See `project-memory/hooks/settings-template.json` for setup instructions.

| Hook | Event | Purpose |
|------|-------|---------|
| `oh_memos_session_start.js` | SessionStart | Output CWD→cube_id mapping |
| `oh_memos_user_prompt.js` | UserPromptSubmit | Smart intent detection, suggest oh-memos_search |
| `oh_memos_block_mkdir_memory.js` | PreToolUse (Bash) | Block `mkdir.*memory` commands |
| `oh_memos_auto_save.js` | PostToolUse (Bash/Edit/Write) | Suggest memory type + project_path |
| `oh_memos_notify_milestone.js` | PostToolUse (Edit/Write) | Suggest MILESTONE for important files |
| `oh_memos_pre_compact.js` | PreCompact | Remind: use MCP oh-memos, not mkdir |

---

## API Endpoints

本地 API 由 `src/oh_memos/api/start_api.py` 提供(端口 18000)。以下是它**实际注册**的端点。

### Search API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/search` | POST | Search memories(`SearchRequest`: `query` 必填,`user_id` / `install_cube_ids` / `top_k` 可选)|

### Graph API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/product/graph/data`(别名 `/graph/data`)| POST | Export graph nodes and edges |
| `/product/graph/trace_path`(别名 `/graph/trace_path`)| POST | Trace paths between two nodes |
| `/product/graph/schema`(别名 `/graph/schema`)| POST | Export graph schema and statistics |
| `/product/graph/relation` | POST | Add graph relation |

### Example: Search

```json
POST /search
{
  "user_id": "dev_user",
  "query": "what was the solution?",
  "install_cube_ids": ["oh_memos_cube"],
  "top_k": 10
}
```

> ⚠️ **不要写 `/product/search`**。它不在 `start_api.py` 里,只挂在另外两个独立 app
> 上(`product_api.py` / `server_api.py`,各自 `include_router(prefix="/product")`),
> 本地不启动。同理:
> - `readable_cube_ids` 只属于 `server_api.py` 的 `APISearchRequest`,`/search` 用的是 `install_cube_ids`
> - `chat_history` 同上,也只在 `APISearchRequest` 上
> - `enable_context_analysis` 在 `src/` 内**没有任何声明**,任何 app 都不认
>
> Pydantic 会静默丢弃模型上不存在的字段——传错字段不会报错,只会不生效。

---

## Key Files

| File | Purpose |
|------|---------|
| `scripts/local/start.bat` | One-click silent launcher |
| `memory-admin.bat` | Launch the memory admin GUI (port 18010) |
| `.env` | Environment configuration |
| `mcp-server-node/src/index.ts` | MCP server implementation (ACTIVE - all clients load this) |
| `mcp-server-node/src/tools-registry.ts` | Tool definitions (descriptions survive compaction) |
| `mcp-server-node/src/handlers/` | Tool handler implementations |
| `mcp-server/` (Python) | [DEPRECATED] legacy MCP - kept for reference, no client loads it |
| `tools/memory-admin/` | Standalone memory admin GUI (browse/delete cubes & memories) |
| `project-memory/SKILL.md` | Full skill documentation |
| `project-memory/hooks/` | Codex hooks for users |
| `data/oh-memos_cubes/dev_cube/config.json` | Default cube configuration |

---

## Quick Start

```bash
# Start all services (silent databases + API)
scripts/local/start.bat

# Stop databases
scripts/local/stop_db_silent.bat

# Memory admin GUI (works even when the API is down)
memory-admin.bat   # → http://127.0.0.1:18010
```

---

*This file is read by Codex at conversation start to provide project context.*

# MCP Server 配置指南 | MCP Server Configuration Guide

**让 AI 助手主动调用记忆功能 | Enable AI assistants to proactively use memory**

---

> ℹ️ **路径说明 | About paths**
> 本文只有一个需要你替换的路径：`MEMOS_CUBES_DIR`，它指向你的 oh-memos 数据目录。
> The only path you must replace is `MEMOS_CUBES_DIR`, pointing at your oh-memos data directory.

---

## 📖 概述 | Overview

MCP (Model Context Protocol) 让 AI **主动调用**记忆功能，而非被动等待用户下令。

MCP lets the AI **proactively invoke** memory, instead of waiting to be told.

| 模式 \| Mode | 触发 \| Trigger | 适用 \| Use case |
|---|---|---|
| **Skill（被动 \| passive）** | 用户调用 `/project-memory` | 明确需要记忆操作时 \| explicit memory work |
| **MCP（主动 \| proactive）** | AI 自行判断并调用 | 遇错、决策、完成任务时 \| on errors, decisions, milestones |

两者可以并存，且互相增强。 They coexist and reinforce each other.

---

## 🚀 快速配置 | Quick Setup

MCP server 以 [`oh-memos-mcp`](https://www.npmjs.com/package/oh-memos-mcp) 发布到 npm，**不需要 Python**，通过 `npx` 运行。

The MCP server ships to npm as [`oh-memos-mcp`](https://www.npmjs.com/package/oh-memos-mcp). **No Python required** — it runs via `npx`.

**前置条件 | Prerequisites**

- Node.js ≥ 18
- oh-memos 后端在运行 | the oh-memos backend running (`scripts/local/start.bat` → `http://localhost:18000`)

**通用配置 | Canonical config**

以下 JSON 适用于所有遵循 MCP 协议的客户端，仅**配置文件位置**不同（见下节）。

This JSON works for every MCP-compliant client; only the **config file location** differs (see below).

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
        "memos_context_resume", "memos_search", "memos_save",
        "memos_list_v2", "memos_get", "memos_suggest",
        "memos_think", "memos_graph", "memos_admin",
        "memos_export_wiki", "memos_canvas"
      ]
    }
  }
}
```

四个 `env` 变量**全部必填** —— `config.ts` 的 `requireEnv` 缺任一即退出。

All four `env` vars are **required**: `requireEnv` in `config.ts` exits if any is missing.

| 平台 \| Platform | `MEMOS_CUBES_DIR` 示例 \| example |
|---|---|
| **Windows** | `C:/Users/you/oh-memos/data/oh-memos_cubes` |
| **Linux / macOS** | `/home/you/oh-memos/data/oh-memos_cubes` |
| **WSL2** | `/mnt/c/Users/you/oh-memos/data/oh-memos_cubes` |

> ⚠️ **Windows 用户请用正斜杠** `/` 或转义反斜杠 `\\`。JSON 里单个 `\` 是转义符，`C:\Users` 会解析失败。
> **On Windows use forward slashes** `/` or escaped `\\`. A lone `\` is a JSON escape character.

### `.env` 找不到时 | When `.env` cannot be found

经 `npx` 安装时，包根位于 npm 缓存内，基于位置猜测 `.env` 的方式**全部落空**——一个变量都加载不到，随后 cube 构建会死在第一个必填变量上（`MOS_CHAT_MODEL is required...`），对外表现为「注册成功但立刻自报未注册」。

Under `npx` the package root sits in the npm cache, so positional guessing for `.env` misses every candidate — not one variable loads, and cube construction then dies on its first required var, surfacing as a cube that "registers" and immediately reports itself unregistered.

用 `MEMOS_ENV_FILE` 显式指定即可（Node server 亦支持 `--memos-env-file`）：

Point at it explicitly with `MEMOS_ENV_FILE` (the Node server also accepts `--memos-env-file`):

```json
"env": {
  "MEMOS_ENV_FILE": "/path/to/oh-memos/.env",
  "MEMOS_URL": "http://localhost:18000"
}
```

路径不存在时会在 stderr 告警，不会静默穿透。 A path that does not exist warns on stderr rather than failing silently.

---

## 🖥️ 各平台配置文件位置 | Config File Locations

配置内容用上面那份 JSON，只是放在不同位置。

Use the JSON above; only the location changes.

| 平台 \| Platform | 配置文件 \| Config file |
|---|---|
| **Claude Code (CLI)** | `~/.claude/settings.json`（全局）或项目内 `.claude/settings.json` |
| **Claude Desktop** — Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| **Claude Desktop** — macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Cursor** | `~/.cursor/mcp.json`（全局）或项目内 `.cursor/mcp.json` |
| **Trae** | 设置 → MCP → 手动添加 \| Settings → MCP → add manually |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |
| **Cline / Roo Code** | VS Code 扩展设置内的 MCP Servers 面板 \| MCP Servers panel in extension settings |

> Cline / Roo Code 的面板可能不接受 `alwaysAllow` 字段，改用界面上的 auto-approve 勾选项。
> Cline / Roo Code may not accept `alwaysAllow`; use the UI's auto-approve checkboxes instead.

### WSL 注意事项 | WSL notes

在 WSL 里运行客户端时，`npx` 与 `MEMOS_CUBES_DIR` 必须**同属一侧**。混用（Windows 的 node + Linux 路径）会让 cube 落进幻影目录：注册报告成功，随后 `/search` 与 `/memories` 全部 400，因为载入的 cube 没有记忆后端。

When the client runs inside WSL, `npx` and `MEMOS_CUBES_DIR` must live on the **same side**. Mixing them (Windows node with a Linux path) lands cubes in a phantom tree: registration reports success, then `/search` and `/memories` fail 400 because the loaded cube has no memory backend.

不再需要 wrapper 脚本 —— 旧版 Python 路线为跨 WSL 边界调用 `python.exe` 才需要它。

No wrapper script is needed any more; that was only required by the old Python route calling `python.exe` across the WSL boundary.

---

## ✅ 验证安装 | Verify Installation

重启客户端后，应能看到 **11 个工具**（`memos_delete` 默认隐藏，需 `MEMOS_ENABLE_DELETE=true`）。

After restarting the client you should see **11 tools** (`memos_delete` is hidden unless `MEMOS_ENABLE_DELETE=true`).

不依赖客户端的直接验证 | Client-independent check:

```bash
# 后端健康 | backend health
curl http://localhost:18000/health
```

MCP server 没有 `--help`；它是 stdio 服务，直接运行会静默等待输入。要确认它能启动并列出工具，用一次真实的握手（把四个必填变量替换成你的值）：

The server has no `--help` — it is a stdio service and simply waits for input. To confirm it starts and lists tools, do one real handshake (substitute your four required vars):

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
| MEMOS_URL=http://localhost:18000 \
  MEMOS_USER=dev_user \
  MEMOS_DEFAULT_CUBE=dev_cube \
  MEMOS_CUBES_DIR=/path/to/oh-memos/data/oh-memos_cubes \
  npx -y oh-memos-mcp
```

应返回两行 JSON，第二行含工具列表。缺任一必填变量则 `requireEnv` 直接退出，stderr 会指名缺哪个。

Two JSON lines come back, the second listing the tools. If a required var is missing, `requireEnv` exits and names it on stderr.

> 首次 `npx` 拉包可能超过 120 秒，第二次走缓存才快。若客户端报超时，先在终端手动跑一次 `npx -y oh-memos-mcp` 预热。
> The first `npx` fetch can exceed 120 s; the second is cached. If the client times out, warm the cache by running it once in a terminal.

---

## 🛠️ 工具参考 | Tools Reference

2.0 起工具面合并为 11 个：图谱操作走 `memos_graph(mode)`，运维操作走 `memos_admin(action)`。**1.x 的旧名一律返回 `Unknown tool`，没有兼容层。**

Since 2.0 the surface is 11 tools: graph work goes through `memos_graph(mode)`, maintenance through `memos_admin(action)`. **1.x names return `Unknown tool` — there is no compatibility shim.**

| 工具 \| Tool | 用途 \| Purpose |
|---|---|
| `memos_context_resume` | 压缩后恢复上下文：未完成画布 + 近 24h 记忆 \| after compaction: unfinished canvases + recent memories |
| `memos_search` | 检索记忆；传 `context`（近几轮对话）启用意图分析 \| search; pass `context` for intent analysis |
| `memos_save` | 保存记忆，**必须显式传 `memory_type`** \| save; `memory_type` is required |
| `memos_list_v2` | 列出记忆（大结果自动压缩）\| list (compacted when large) |
| `memos_get` | 按 ID 取完整记忆 \| full memory by id |
| `memos_suggest` | 检索词建议 + `memory_type` 决策树 \| query suggestions + type decision tree |
| `memos_think` | 证据包：检索 + 矛盾/陈旧标记 + 缺口分析（由调用方综合）\| evidence pack; caller synthesizes |
| `memos_graph` | 图谱查询 —— `mode`: related / path / impact / schema |
| `memos_admin` | 运维 —— `action`: list_cubes / register_cube / create_user / validate_cubes / stats / calendar |
| `memos_export_wiki` | 导出 cube 为互链 markdown wiki \| export a cube as an interlinked wiki |
| `memos_canvas` | 任务画布：跨压缩存续的任务状态 —— `action`: open / update / show / list |
| `memos_delete` | 删除记忆（默认禁用）\| delete (disabled by default) |

### Cube 路由（关键）| Cube Routing (critical)

**每个项目应有独立 cube。传 `project_path`，让服务端推导 `cube_id`。**

**Each project gets its own cube. Pass `project_path` and let the server derive `cube_id`.**

推导规则：目录名 → 小写 → `-` `.` 空格 转 `_` → 追加 `_cube`

Rule: basename → lowercase → `-` `.` space become `_` → append `_cube`

```python
# 正确 | correct
memos_save(content="...", memory_type="BUGFIX", project_path="/mnt/g/test/oh-memos")
# → oh_memos_cube

# 错误：所有项目会混进同一个 cube | wrong: every project lands in one cube
memos_save(content="...", cube_id="dev_cube")
```

省略 `project_path` 时会回落到 `MEMOS_DEFAULT_CUBE` —— 此时**空结果并不代表你的项目没有记忆**，只说明搜错了 cube。

Omitting `project_path` falls back to `MEMOS_DEFAULT_CUBE`; an empty result then says nothing about your project's memories — it searched the wrong cube.

### 任务画布 | Task Canvas

`memos_canvas` 管的是**会话内**的任务状态，与长期记忆分工不同：

`memos_canvas` holds **in-session** task state, a different job from long-term memory:

| | 长期记忆 \| Long-term | 短期画布 \| Short-term canvas |
|---|---|---|
| 回答 \| Answers | 我们知道什么 \| what do we know | 我做到哪了 \| where was I |
| 存储 \| Storage | Neo4j + Qdrant | `{cube}/canvas/NNN-slug.mmd` |
| 写入成本 \| Write cost | LLM 抽取 + embedding | 一次文件写 \| a file write |

节点带可 grep 的 id（`000-N1`）和指向证据的 `ref`：

Nodes carry a greppable id (`000-N1`) and a `ref` anchoring them to evidence:

| `ref` | 指向 \| Points at | 打开 \| Open with |
|---|---|---|
| `mem:<memory_id>` | 图谱里的一条记忆 \| a memory in the graph | `memos_get(memory_id=...)` |
| `file:<path>` | 任意文件 \| any file | Read |
| `note:<text>` | 内联说明 \| inline remark | — |

---

## 🪝 Hooks 集成 | Hooks Integration

Hooks 让记忆操作**无需显式调用**。配置模板见 [`project-memory/hooks/settings-template.json`](../project-memory/hooks/settings-template.json)。

Hooks make memory work happen **without explicit calls**. Template: [`project-memory/hooks/settings-template.json`](../project-memory/hooks/settings-template.json).

| Hook | 事件 \| Event | 作用 \| Does |
|---|---|---|
| `oh_memos_session_start.js` | SessionStart | 输出 CWD → cube_id 映射 \| map CWD to cube_id |
| `oh_memos_user_prompt.js` | UserPromptSubmit | 意图识别 → 建议检索 \| detect intent, suggest search |
| `oh_memos_context_inject.js` | PreToolUse | Grep/Read/Edit 时**自动注入**相关记忆 \| auto-inject related memories |
| `oh_memos_block_mkdir_memory.js` | PreToolUse | 拦截手工建记忆目录 \| block manual memory dirs |
| `oh_memos_auto_save.js` | PostToolUse | 建议 `memory_type` \| suggest a memory type |
| `oh_memos_notify_milestone.js` | PostToolUse | 重要文件改动建议存 MILESTONE |
| `oh_memos_pre_compact.js` | PreCompact | 提醒压缩前保存、压缩后恢复 \| save before, resume after |

安装：把模板里的 `hooks` 段并入 `~/.claude/settings.json`，并把 `<MEMOS_PATH>` 换成你的安装路径。

Install: merge the template's `hooks` block into `~/.claude/settings.json` and replace `<MEMOS_PATH>`.

> ⚠️ hook 路径里的脚本名是**下划线** `oh_memos_*.js`。
> Script names use **underscores**: `oh_memos_*.js`.

---

## 🩺 故障排查 | Troubleshooting

| 症状 \| Symptom | 原因与处理 \| Cause and fix |
|---|---|
| 客户端看不到工具 \| no tools listed | 四个 `env` 缺一即退出；先手动跑 `npx -y oh-memos-mcp` 看 stderr \| a missing env var exits at startup |
| 首次连接超时 \| first connect times out | `npx` 拉包 >120 s；终端预热一次 \| warm the npx cache |
| `Cube not found` | `memos_admin(action="list_cubes")` 查看，再 `register_cube` |
| `User does not exist` | `memos_admin(action="create_user", user_id="dev_user")` |
| 检索结果为空 \| empty results | 大概率漏传 `project_path`，搜到了默认 cube \| likely missing `project_path` |
| 报「注册成功但未注册」\| registers then reports unregistered | `.env` 未加载，用 `MEMOS_ENV_FILE` 显式指定 \| set `MEMOS_ENV_FILE` |
| `Unknown tool: memos_xxx` | 用了 1.x 旧工具名，见上方工具表 \| 1.x name; see the table above |

后端健康详情 | Backend health detail:

```bash
curl http://localhost:18000/health/detail   # neo4j / qdrant 各自状态
```

---

## 🧠 进阶：知识图谱模式 | Advanced: Knowledge Graph Mode

`tree_text` 后端在 Neo4j 中建立记忆间的关系（CAUSE / RELATE / CONFLICT / CONDITION），使因果链可追溯。

The `tree_text` backend builds relationships between memories in Neo4j (CAUSE / RELATE / CONFLICT / CONDITION), making causal chains traceable.

| | `naive_text` | `tree_text` |
|---|---|---|
| 存储 \| Storage | 仅向量 \| vectors only | 向量 + 图谱 \| vectors + graph |
| 关系 \| Relationships | ✗ | ✓ |
| 依赖 \| Requires | Qdrant | Qdrant + Neo4j |

启用后可用：`memos_graph(mode="related")` 看关系、`mode="path"` 追因果链、`mode="impact"` 看影响范围、`mode="schema"` 看图谱健康度。

Once enabled: `memos_graph(mode="related")` for relationships, `"path"` to trace causality, `"impact"` for blast radius, `"schema"` for graph health.

配置见 [`docs/DB/CUBE_CONFIG_CN.md`](DB/CUBE_CONFIG_CN.md)。 Neo4j 浏览器：http://localhost:7474

---

## 📚 相关文档 | Related Documentation

| 文档 \| Doc | 内容 \| Contents |
|---|---|
| [`README.md`](../README.md) | 项目总览、架构、快速开始 \| overview, architecture, quick start |
| [`mcp-server-node/README.md`](../mcp-server-node/README.md) | MCP server 完整选项 \| full server options |
| [`mcp-server-node/CHANGELOG.md`](../mcp-server-node/CHANGELOG.md) | 版本变更与 1.x → 2.0 迁移表 \| changes and migration |
| [`project-memory/SKILL.md`](../project-memory/SKILL.md) | Skill 完整说明 \| full skill docs |
| [`docs/DB/CUBE_CONFIG_CN.md`](DB/CUBE_CONFIG_CN.md) | Cube 配置与后端选择 \| cube config and backends |

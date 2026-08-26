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

## Lite mode | Lite 轻部署

Lite runs the Node MCP server with its local JSONL provider. It does **not**
need the oh-memos API, Python, Neo4j, or Qdrant, so do not start
`scripts/local/start.bat` first. Use this configuration when you need local,
offline, or single-developer memory:

```json
{
  "mcpServers": {
    "oh-memos": {
      "type": "stdio",
      "command": "node",
      "args": ["<npm root -g>/oh-memos-mcp/dist/index.js"],
      "env": {
        "MEMOS_MODE": "lite",
        "MEMOS_PROVIDER": "local",
        "MEMOS_USER": "dev_user",
        "MEMOS_DEFAULT_CUBE": "dev_cube",
        "MEMOS_CUBES_DIR": "/path/to/oh-memos/data/oh-memos_cubes",
        "MEMOS_LITE_EMBED": "off"
      }
    }
  }
}
```

`MEMOS_URL` is required for Full mode, but not for Lite. Lite stores records
under `<MEMOS_CUBES_DIR>/<cube>/memories.jsonl` and provides typed save/list/get,
search, context resume, and canvas operations. Search is lexical by default.
Remove `MEMOS_LITE_EMBED=off` to allow optional Ollama embeddings, or set
`MEMOS_LITE_EMBED_URL` and `MEMOS_LITE_EMBED_MODEL` explicitly. Graph, think,
Wiki round-trip, remote admin, and delete operations are Full-only.

For the Full configuration below, start the backend first and keep the four
Full env variables (`MEMOS_URL`, `MEMOS_USER`, `MEMOS_DEFAULT_CUBE`, and
`MEMOS_CUBES_DIR`) configured.

---


MCP server 以 [`oh-memos-mcp`](https://www.npmjs.com/package/oh-memos-mcp) 发布到 npm，**不需要 Python**。

The MCP server ships to npm as [`oh-memos-mcp`](https://www.npmjs.com/package/oh-memos-mcp). **No Python required.**

### 安装与升级 | Install and upgrade

全局装一次，配置里写安装后的入口路径：

Install once globally, then point the config at the installed entry point:

```bash
npm install -g oh-memos-mcp
npm root -g          # 打印下面 args 要用的目录 | prints the directory used in args
```

升级只需重装，**配置不用改**：

To upgrade, reinstall — **the config needs no edit**:

```bash
npm install -g oh-memos-mcp@latest
```

之后**重启客户端**。运行中的 MCP server 不会中途换掉 —— stdio 管道在客户端启动时就绑定了，升级只在客户端重启后生效。同一台机器上同时开多个客户端时，各自持有一份 server，互不影响，也各自需要重启。

Then **restart the client**. A running MCP server is never swapped mid-session: the
stdio pipe is bound when the client starts, so an upgrade takes effect only after a
restart. When several clients run at once each holds its own server — they do not
interfere, and each needs its own restart.

> **为什么不用 `npx`** | **Why not `npx`**
>
> `npx -y oh-memos-mcp@<版本>` 也能用，试用无妨，但每个客户端要多起两个进程
> （`cmd`/`sh` → `npx-cli`(node) → `cmd`/`sh` → server(node)，而直接启动只要两个）。
> 同时开多个 MCP 客户端时这笔开销可观：某台 Windows 机器上同时跑七个客户端，
> 仅 npx 包装层就占了约 360 MB。且 `npx` 把版本号钉在每个客户端配置里，
> 升级要逐个改。
>
> `npx -y oh-memos-mcp@<version>` works and is fine for a trial, but it costs two
> extra processes per client (`cmd`/`sh` → `npx-cli` (node) → `cmd`/`sh` → server
> (node), versus two for a direct launch). With several MCP clients open that adds
> up: on one Windows machine running seven clients, the npx wrappers alone held
> ~360 MB. `npx` also pins the version inside every client config, so upgrading
> means editing each one.
>
> 第三种写法是让 `args` 指向仓库 checkout 的 `dist/index.js` —— 开发 oh-memos 本身
> 时开销最低，`npm run build` 后重启客户端即生效、不必发包，但仓库移动或构建产物
> 过期时客户端就起不来。
>
> A third option points `args` at a checkout's `dist/index.js`: lowest overhead when
> working *on* oh-memos (`npm run build` takes effect on the next restart, no publish
> needed), but the client breaks if the checkout moves or its build is stale.

## Full mode prerequisites | Full 重部署前置条件

- Node.js ≥ 20
- For Full mode only: oh-memos backend running | the oh-memos backend running (`scripts/local/start.bat` → `http://localhost:18000`)

**Full configuration | Full 配置**

以下 JSON 适用于所有遵循 MCP 协议的客户端，仅**配置文件位置**不同（见下节）。

This JSON works for every MCP-compliant client; only the **config file location** differs (see below).

```json
{
  "mcpServers": {
    "oh-memos": {
      "type": "stdio",
      "command": "node",
      "args": ["<npm root -g>/oh-memos-mcp/dist/index.js"],
      "env": {
        "MEMOS_URL": "http://localhost:18000",
        "MEMOS_USER": "dev_user",
        "MEMOS_DEFAULT_CUBE": "dev_cube",
        "MEMOS_CUBES_DIR": "/path/to/oh-memos/data/oh-memos_cubes",
        "MEMOS_ENV_FILE": "/path/to/oh-memos/.env"
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

包装在项目之外时（**全局安装**或 `npx`），基于位置猜测 `.env` 的方式**全部落空**——一个变量都加载不到，随后 cube 构建会死在第一个必填变量上（`MOS_CHAT_MODEL is required...`），对外表现为「注册成功但立刻自报未注册」。这也是全局安装务必设 `MEMOS_ENV_FILE` 的原因。

When the package sits outside the project (**a global install** or `npx`), positional guessing for `.env` misses every candidate — not one variable loads, and cube construction then dies on its first required var, surfacing as a cube that "registers" and immediately reports itself unregistered. This is why a global install should always set `MEMOS_ENV_FILE`.

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

在 WSL 里运行客户端时，启动 server 的 node 与 `MEMOS_CUBES_DIR` 必须**同属一侧**。混用（Windows 的 node + Linux 路径）会让 cube 落进幻影目录：注册报告成功，随后 `/search` 与 `/memories` 全部 400，因为载入的 cube 没有记忆后端。全局安装时尤其注意：WSL 侧的 `npm root -g` 与 Windows 侧是两个不同目录。

When the client runs inside WSL, the node that launches the server and `MEMOS_CUBES_DIR` must live on the **same side**. Mixing them (Windows node with a Linux path) lands cubes in a phantom tree: registration reports success, then `/search` and `/memories` fail 400 because the loaded cube has no memory backend. With a global install, note that WSL's `npm root -g` and Windows' are two different directories.

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
  node "$(npm root -g)/oh-memos-mcp/dist/index.js"
```

应返回两行 JSON，第二行含工具列表。缺任一必填变量则 `requireEnv` 直接退出，stderr 会指名缺哪个。

Two JSON lines come back, the second listing the tools. If a required var is missing, `requireEnv` exits and names it on stderr.

> 全局安装后启动无需拉包，不会再出现首次连接超时。若仍用 `npx`，首次拉包可能超过 120 秒，需先在终端跑一次预热。
> A global install starts with no fetch, so first-connect timeouts disappear. If you stay on `npx`, the first fetch can exceed 120 s — warm it once in a terminal.

---

## 🛠️ 工具参考 | Tools Reference

图谱操作走 `memos_graph(mode)`，运维操作走 `memos_admin(action)`。**1.x 的旧名一律返回 `Unknown tool`，没有兼容层。**

Graph work goes through `memos_graph(mode)`, maintenance through `memos_admin(action)`. **1.x names return `Unknown tool` — there is no compatibility shim.**

共 17 个工具，其中 `memos_delete` 仅在 `MEMOS_ENABLE_DELETE=true` 时出现在 `tools/list`，其余 16 个默认可用。

17 tools in total. `memos_delete` appears in `tools/list` only when `MEMOS_ENABLE_DELETE=true`; the other 16 are available by default.

| 工具 \| Tool | 用途 \| Purpose |
|---|---|
| `memos_context_resume` | 压缩后恢复上下文：未完成画布 + 近 24h 记忆 \| after compaction: unfinished canvases + recent memories |
| `memos_search` | 检索记忆；传 `context`（近几轮对话）启用意图分析 \| search; pass `context` for intent analysis |
| `memos_save` | 保存记忆，**必须显式传 `memory_type`** \| save; `memory_type` is required |
| `memos_list_v2` | 列出记忆（大结果自动压缩）\| list (compacted when large) |
| `memos_get` | 按 ID 取完整记忆 \| full memory by id |
| `memos_suggest` | 检索词建议 + `memory_type` 决策树 \| query suggestions + type decision tree |
| `memos_think` | 证据包：检索 + 矛盾/陈旧标记 + 缺口分析（由调用方综合）\| evidence pack; caller synthesizes |
| `memos_graph` | 图谱查询与 Graphify 校验 —— `mode`: related / path / impact / schema / import |
| `memos_admin` | 运维 —— `action`: list_cubes / register_cube / create_user / validate_cubes / stats / calendar / capabilities |
| `memos_export_wiki` | 导出 cube 为互链 markdown wiki \| export a cube as an interlinked wiki |
| `memos_import_wiki` | 把导出的 wiki 导回 cube；支持 dry-run 与编辑页版本化，从不删除记忆 \| import a wiki back; dry-run and versioning, never deletes |
| `memos_canvas` | 任务画布：跨压缩存续的任务状态 —— `action`: open / update / show / list / delete（未完成节点需 `confirm=true`）|
| `memos_distill_skill` | 从复现记忆生成待审 Skill 候选（写在 `skill-candidates/`，不自动安装）\| distill a reviewable Skill candidate; never auto-installs |
| `memos_list_skill_candidates` | 列出 Skill 候选，不修改也不安装 \| list candidates without modifying or installing |
| `memos_review_skill_candidate` | 批准或驳回候选（带审阅人审计信息；批准≠安装）\| approve or reject; approval does not install |
| `memos_install_skill_candidate` | 仅把已批准候选装到 `.claude/skills/<slug>/SKILL.md`，不覆盖、不执行脚本 \| install an approved candidate only |
| `memos_delete` | 删除记忆（默认禁用，需显式确认）\| delete (disabled by default) |

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
| 客户端看不到工具 \| no tools listed | 四个 `env` 缺一即退出；先手动跑 `node "$(npm root -g)/oh-memos-mcp/dist/index.js"` 看 stderr \| a missing env var exits at startup |
| 首次连接超时 \| first connect times out | 仅 `npx` 会拉包 >120 s；改全局安装即无此问题 \| only `npx` fetches; a global install avoids it |
| 开了扩散却无 ` via ` 标注 \| spreading on but no annotations | Neo4j 凭据没传到 server（全局安装/`npx` 下要设 `MEMOS_ENV_FILE`）；检索本身正常故无报错 \| Neo4j vars did not reach the server; retrieval still works so nothing errors |
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

## 🔍 检索行为 | Retrieval Behaviour

检索排序有几项行为**不需要配置、默认生效**，另有两个开关默认关闭。默认值都偏保守，所以升级不会悄悄改变排序结果。

Several ranking behaviours are **on by default and need no configuration**; two switches are off by default. Defaults are conservative, so upgrading never silently changes what search returns.

### 默认生效 | On by default

| 行为 \| Behaviour | 说明 \| What it does |
|---|---|
| 分类型时间衰减 \| per-type decay | 按 `memory_type` 分档：`PROGRESS` 几周即淡出，`CONFIG` 半年，`BUGFIX`/`ERROR_PATTERN` 一年，`DECISION`/`GOTCHA`/`CODE_PATTERN` 三年。进度汇报本该过期，原理性结论不该 \| a `PROGRESS` note ages out in weeks; a `DECISION` stays relevant for years |
| 访问强化 \| access reinforcement | 常被 `memos_get` 打开的记忆排名略升（对数饱和，不会让一条记忆霸榜）\| frequently opened memories rank slightly higher, log-saturating |
| 近重复折叠 \| near-duplicate folding | 措辞略异的重复按类型分档折叠：`PROGRESS` 激进、`DECISION` 保守。被折叠的**不丢弃**，标注为 ` · folded N: <ids>` \| duplicates folded with per-type thresholds; folded ids are reported, not dropped |
| 隐藏短期副本 \| hide short-term copies | 后端每条记忆写两份（一份 scheduler 管的短期副本 + 一份长期图节点，内容逐字相同），默认只显示长期那份 \| the backend writes each memory twice; only the long-term one is shown |

### 需要开关 | Opt-in switches

```json
"env": {
  "MEMOS_SPREAD_ACTIVATION": "true"
}
```

| 开关 \| Switch | 默认 | 作用 \| Effect |
|---|---|---|
| `MEMOS_SPREAD_ACTIVATION` | `false` | **一跳图扩散联想**。开启后检索除直接命中外，还沿 `CAUSE` / `CONDITION` / `RELATE` 边带回相邻记忆，标注 ` · via CAUSE from <源记忆 id 前 8 位>`。仅 Full 模式 —— 它直连 Neo4j，需要 `NEO4J_HTTP_URL`/`NEO4J_USER`/`NEO4J_PASSWORD` 都能取到 \| one-hop spreading activation; Full mode only |
| `MEMOS_SHOW_WORKING_MEMORY` | `false` | 显示 scheduler 的短期副本层。开启后每条记忆会成对出现 —— 仅调试用 \| show the short-term tier; every memory then appears in pairs. Debugging only |

**扩散联想能带回什么** —— 例如查「admin-web 项目」，直接命中是四条 admin-web 的进度记录，扩散再带回 CORS 预检失败、双 `/api` 拼接、token 刷新 403 这些同一条线上的调试记录。这些在原查询下一条都不会返回。

What spreading activation adds: a search for "admin-web" returns its direct hits, then pulls in the CORS-preflight failure, the double-`/api` bug, and the token-refresh 403 — same thread of work, none of which the original query would match.

联想**永不排在直接命中之前**，无论分数高低 —— 弱匹配也是匹配，联想不是。上界 12 条。

Spread results **never outrank direct hits**, whatever their score — a weak match is still a match; an association is not. Capped at 12.

> ⚠️ **缺 Neo4j 凭据时扩散会静默降级**：检索照常返回记忆、stderr 无异常，只是没有 ` via ` 标注 —— 表象与「功能没开」完全一样。开了开关却看不到标注，先查 Neo4j 变量有没有真的传到 server（全局安装或 `npx` 下意味着要设 `MEMOS_ENV_FILE`），而不是怀疑功能不存在。
>
> **Spreading activation degrades silently without Neo4j credentials**: retrieval still returns memories and logs nothing unusual — you just get no ` via ` annotations, which looks identical to the feature being off. If you enabled it and see no annotations, check that the Neo4j variables actually reach the server (under a global install or `npx`, that means `MEMOS_ENV_FILE`).

> **`MEMOS_ENV_FILE` 里的值压过客户端配置。** 它以 `override: true` 加载，所以同一个键在 env 文件里的值会覆盖 MCP 客户端 `env` 块里的值。按位置猜到的 `.env` 则相反 —— 只补缺、从不覆盖启动器。这是有意设计：显式指定的 env 文件应当说了算，恰好在旁边的 `.env` 不该反压。实际后果是 `.env` 一旦写了这两个开关，就**无法从客户端配置翻转**，只能改 env 文件。
>
> **`MEMOS_ENV_FILE` wins over the client config** (loaded with `override: true`), while positionally-discovered `.env` files only fill gaps. So once `.env` sets these switches they cannot be flipped from the client config — edit the env file instead.

---

## 📚 相关文档 | Related Documentation

| 文档 \| Doc | 内容 \| Contents |
|---|---|
| [`README.md`](../README.md) | 项目总览、架构、快速开始 \| overview, architecture, quick start |
| [`mcp-server-node/README.md`](../mcp-server-node/README.md) | MCP server 完整选项 \| full server options |
| [`mcp-server-node/CHANGELOG.md`](../mcp-server-node/CHANGELOG.md) | 版本变更与 1.x → 2.0 迁移表 \| changes and migration |
| [`project-memory/SKILL.md`](../project-memory/SKILL.md) | Skill 完整说明 \| full skill docs |
| [`docs/DB/CUBE_CONFIG_CN.md`](DB/CUBE_CONFIG_CN.md) | Cube 配置与后端选择 \| cube config and backends |

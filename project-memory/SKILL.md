---
name: project-memory
description: "Proactive project memory management via oh-memos MCP. ALWAYS pass project_path parameter for correct cube routing. USE MCP TOOLS AUTOMATICALLY when: (1) Starting work - memos_search for context, (2) Completing tasks - memos_save as MILESTONE, (3) Fixing bugs - memos_save as ERROR_PATTERN, (4) Making decisions - memos_save as DECISION, (5) Encountering errors - memos_search for solutions, (6) User mentions '之前/上次/previously' - memos_search history, (7) Context compacted - memos_context_resume to recover. NEVER use mkdir or Write for memory files."
---

# Project Memory (MCP Powered)

Intelligent project memory system powered by **oh-memos MCP Server**. Use MCP tools directly - no scripts needed!

---

## 🚨 强制规则 (MUST/MUST NOT)

### MUST (必须遵守)

1. **修复 Bug 后必须保存为 `BUGFIX` 或 `ERROR_PATTERN`**，不得使用 PROGRESS
2. **做出技术决策后必须保存为 `DECISION`**，包含理由和备选方案
3. **发现非显而易见的陷阱必须保存为 `GOTCHA`**
4. **保存时必须显式指定 `memory_type` 参数**，不依赖自动检测
5. **保存时必须传 `project_path` 参数**（当前工作目录），确保存入正确的 cube

### MUST NOT (禁止)

1. **禁止将 PROGRESS 作为默认/万能类型**
2. **禁止省略 memory_type 参数** (除非是纯进度汇报)
3. **禁止在 PROGRESS 中包含错误解决方案、技术决策、陷阱警告**
4. **禁止用 mkdir 或 Write 创建 memory 目录/文件** — 所有记忆通过 MCP memos 工具保存
5. **禁止不加 project_path 就用 `dev_cube`** — 每个项目应有独立 cube

### 类型选择决策树

```
是否解决了一个错误/Bug？
├─ 是 → 是否有通用价值？
│       ├─ 是 → ERROR_PATTERN (错误模式，可复用)
│       └─ 否 → BUGFIX (一次性修复)
└─ 否 → 是否做出了技术选择？
        ├─ 是 → DECISION
        └─ 否 → 是否发现了非显而易见的问题？
                ├─ 是 → GOTCHA
                └─ 否 → 是否是可复用的代码模板？
                        ├─ 是 → CODE_PATTERN
                        └─ 否 → 是否修改了配置？
                                ├─ 是 → CONFIG
                                └─ 否 → 是否完成了重大里程碑？
                                        ├─ 是 → MILESTONE
                                        └─ 否 → 是否新增了功能？
                                                ├─ 是 → FEATURE
                                                └─ 否 → PROGRESS (仅限纯进度)
```

### 错误示范 vs 正确示范

❌ **错误**: `memos_save(content="修复了模型路径问题")` → 默认 PROGRESS
✅ **正确**: `memos_save(content="修复了模型路径问题...", memory_type="BUGFIX")`

❌ **错误**: `memos_save(content="决定采用三轨架构")` → 可能被误检测
✅ **正确**: `memos_save(content="决定采用三轨架构...", memory_type="DECISION")`

❌ **错误**: `memos_save(content="注意: fallbacks会自动切换")` → 可能落入 PROGRESS
✅ **正确**: `memos_save(content="注意: fallbacks会自动切换...", memory_type="GOTCHA")`

### 置信度机制

`detect_memory_type()` 返回 `(类型, 置信度)` 元组：

| 置信度 | 含义 |
|--------|------|
| 1.0 | 显式指定类型 |
| 0.85-0.95 | 强特征匹配（如 traceback、决定采用） |
| 0.7-0.84 | 中等特征匹配 |
| 0.3 | 默认 PROGRESS（无特征匹配，会触发警告） |

**当置信度 < 0.6 且类型为 PROGRESS 时，系统会输出警告提示显式指定类型。**

### 健康检查

`memos_admin(action=stats)` 会在 PROGRESS 占比 >70% 时输出健康警告：

```
⚠️ 健康警告: PROGRESS 类型占比过高 (>70%)

这可能导致 Neo4j 知识图谱无法建立有效关系。建议:
1. 保存记忆时显式指定 memory_type 参数
2. 参考类型选择决策树
```

---

## Quick Reference: MCP Tools

### Cube Routing (CRITICAL)

**每个项目必须使用独立的 cube，不要全部存入 `dev_cube`！**

使用 `project_path` 参数让服务端自动推导 cube_id：

```python
# CORRECT: 传 project_path，自动推导
memos_save(content="...", memory_type="FEATURE", project_path="/mnt/g/Cyber/AudioCraft Studio")
# → 自动存入 audiocraft_studio_cube

# WRONG: 不指定或用 dev_cube
memos_save(content="...", memory_type="FEATURE", cube_id="dev_cube")
# → 所有项目混在一起！
```

**推导规则**: 取目录名 → 小写 → 替换 `-`/`.`/空格 为 `_` → 加 `_cube` 后缀

| 项目路径 | cube_id |
|---------|---------|
| `/mnt/g/Cyber/AudioCraft Studio` | `audiocraft_studio_cube` |
| `/mnt/g/test/oh-memos` | `oh_memos_cube` |
| `/mnt/g/MCP_server/Skill_Seekers` | `skill_seekers_cube` |
| `~/my-app` | `my_app_cube` |

### Tool Reference

| Tool | When to Use | Example |
|------|-------------|---------|
| `memos_context_resume` | **Context compacted or session start** | `project_path: "/mnt/g/Cyber/AudioCraft Studio"` |
| `memos_search` | Find related memories, solutions, patterns | `query: "ERROR_PATTERN ModuleNotFoundError"` |
| `memos_search` | Search + client-side intent/temporal boosting (pass recent messages as `context`) | `query: "what was the solution?"` |
| `memos_save` | Record important information | `content: "Fixed X by Y", memory_type: "BUGFIX"` |
| `memos_list_v2` | See all memories in project (compacted when large) | `project_path: "...", limit: 10` |
| `memos_get` | Full details of ONE memory after a compacted list/search | `memory_id: "uuid"` |
| `memos_think` | **Evidence pack for a question** — contradictions, staleness, gaps. You synthesize, citing `[n]` | `query: "why did retrieval regress?"` |
| `memos_canvas` | **Short-term task state that survives compaction** (Mermaid file per task) | `action: "open", goal: "..."` |
| `memos_admin(action=list_cubes)` | **Discover available cubes** | `include_status: true` |
| `memos_suggest` | Get search suggestions + memory_type decision tree | `context: "Connection refused error"` |
| `memos_graph(mode=related)` | View dependency/causal relationships | `query: "Neo4j"` → shows CAUSE/RELATE/CONFLICT |
| `memos_graph(mode=path)` | **Trace paths between memories** | `source_id: "...", target_id: "..."` |
| `memos_graph(mode=impact)` | Forward blast radius of one memory | `memory_id: "uuid"` |
| `memos_graph(mode=schema)` | **View graph structure and health** | Shows node/edge counts, types, connectivity |
| `memos_admin(action=register_cube)` | **Manual cube registration (fallback)** | `cube_id: "my_project_cube"` |
| `memos_admin(action=create_user)` | **Create user (fallback)** | `user_id: "dev_user"` |
| `memos_admin(action=stats)` | Per-type counts + health warning | `project_path: "..."` |
| `memos_export_wiki` | Export a cube as an interlinked markdown wiki (git-friendly) | `project_path: "..."` |

`memos_delete` exists but is **hidden unless `MEMOS_ENABLE_DELETE=true`**. Never
assume it is callable.

---

## Browsing memories as a human

Two read paths exist outside the MCP tools:

- **Web GUI** — `memory-admin.bat` serves `http://127.0.0.1:18010`. Lists every
  cube with its Neo4j node count and Qdrant point count, browses and filters
  memories, shows relationships, deletes, exports. It talks to Neo4j/Qdrant
  directly, so it works even when the API is down. Use it when the human wants
  to audit or clean up memories across many projects.
- **Markdown wiki** — `memos_export_wiki` renders a cube into interlinked
  markdown (one page per memory + index + graph). Git-friendly, good for review.

Neo4j node count and Qdrant point count for the same cube are **expected to
differ** — Qdrant stores chunked vectors, so one memory can map to several
points. Only a column being empty indicates orphaned data.

### Memory tiers — `WorkingMemory` is hidden by default

The API writes **two nodes per saved memory**: a `LongTermMemory` graph node
and a short-lived `WorkingMemory` copy with identical text (the scheduler
evicts the latter FIFO). Both are needed — the short tier serves "what we just
discussed", the long tier persists.

Search and `memos_list_v2` **hide the `WorkingMemory` tier**, so one saved
memory shows up once. If you ever see paired duplicates, that is the tier
leaking through, not a double write — do not "deduplicate" them.
Set `MEMOS_SHOW_WORKING_MEMORY=true` only to debug the scheduler.

`metadata.memory_type` (the tier: WorkingMemory / LongTermMemory / UserMemory)
and `metadata.type` (the business type: DECISION / BUGFIX / …) are **two
orthogonal axes**. Confusing them is the most common mistake here.

---

## Result annotations

Search results append signals after the ID when they carry information.
A clean, never-read, fresh memory shows a bare `` ID: `abc123` ``.

| Annotation | Meaning | What to do |
|---|---|---|
| `access_count 4` | You opened this memory with `memos_get` 4 times | Higher count = repeatedly useful. Weak reliability signal |
| `stale` | Older than a year (by `updated_at`) | Verify before relying on it; config and code may have moved on |
| `expired` | Past its `expires_at` | Treat as historical record, not current truth |
| `folded 2: id-a, id-b` | 2 near-duplicates were collapsed into this one | Use `memos_get` on those ids if you need the variants |
| `via CAUSE from 49b59302` | **Not a direct match** — reached by spreading one hop from memory `49b59302` along a CAUSE edge | Side evidence. Useful context, but it did not match your query |

`via …` deserves attention: those entries are associations, not answers.
They always rank below every direct match. Edge types are `CAUSE` >
`CONDITION` > `RELATE` in priority. Requires `MEMOS_SPREAD_ACTIVATION=true`
and Full mode (Lite has no graph).

---

## Proactive Triggers (Use MCP Automatically!)

### When to Search (`memos_search`)

| User Says / Context | Search Query |
|---------------------|--------------|
| "之前", "上次", "previously" | `{topic} history` |
| "为什么", "why did we" | `DECISION {topic}` |
| "怎么解决", "how to fix", error message | `ERROR_PATTERN {error_type}` |
| "类似", "similar" | `CODE_PATTERN {pattern}` |
| Working with config file | `CONFIG {filename}` |
| Opening file for editing | `{filename} gotcha` |

### When to Get Graph (`memos_graph(mode=related)`) - NEW!

| User Says / Context | Query | Returns |
|---------------------|-------|---------|
| "依赖关系", "dependencies" | `{component}` | CAUSE/RELATE relationships |
| "为什么失败", "why failed", "root cause" | `{error/feature}` | Causal chain (A→B→C) |
| "相关的", "related to", "关联" | `{topic}` | RELATE relationships |
| "冲突", "conflict", "矛盾" | `{topic}` | CONFLICT relationships |
| "影响", "impact", "会影响什么" | `{change}` | What depends on this |
| Debugging complex issues | `{error_keyword}` | Full context graph |

**Example Output:**
```
[Neo4j需要Java 17+]
    ──CAUSE──>
[Neo4j启动失败, JAVA_HOME not set]
```

### When to Trace Path (`memos_graph(mode=path)`) - NEW!

| Scenario | Use Case |
|----------|----------|
| 追溯根因 | `source_id: "症状ID", target_id: "根因ID"` → 显示完整因果链 |
| 理解影响 | 从决策A到结果B的路径 |
| 调试复杂问题 | 找到错误之间的关联 |

**Example:**
```
memos_graph(mode="path", source_id="uuid1", target_id="uuid2", max_depth=5)
→ [决策A] ──CAUSE──> [变更B] ──CAUSE──> [问题C]
```

### When to List Cubes (`memos_admin(action=list_cubes)`) - NEW!

| Scenario | Action |
|----------|--------|
| 遇到 "cube not found" 错误 | `memos_admin(action="list_cubes")` 查看可用 cubes |
| 切换项目 | `memos_admin(action="list_cubes", include_status=true)` 查看注册状态 |
| 初始化项目 | 确认 cube 是否存在 |

### When to Export Schema (`memos_graph(mode=schema)`) - NEW!

| Scenario | What You Get |
|----------|--------------|
| 理解知识库结构 | 节点/边总数, 类型分布 |
| 检查健康状态 | 孤立节点数, 连接度 |
| 查看常用标签 | Top 20 tags |

### When to Save (`memos_save`)

| Scenario | Memory Type | Content Should Include |
|----------|-------------|------------------------|
| Bug fixed | `ERROR_PATTERN` | Error signature, cause, solution, prevention |
| Feature done | `FEATURE` | What was added, how to use |
| Task completed | `MILESTONE` | Summary of achievement |
| Made a choice | `DECISION` | Options considered, rationale, impact |
| Found a trap | `GOTCHA` | Issue, context, workaround |
| Changed config | `CONFIG` | What changed, why, how to revert |
| Code template | `CODE_PATTERN` | Template, usage, parameters |

---

## Memory Type Formats

### [ERROR_PATTERN] - For Solved Errors

```markdown
[ERROR_PATTERN] Error: {ErrorType}

## Signature
- Type: {ErrorType}
- Message: {Full error message}
- Context: {When this occurs}

## Root Cause
{Why this error happens}

## Solution
1. {Step 1}
2. {Step 2}

## Prevention
{How to avoid in future}

Tags: error, {error_type}, {category}
```

### [DECISION] - For Choices Made

```markdown
[DECISION] Topic: {topic}

## Decision
{What was decided}

## Options Considered
1. **{Option A}**: {pros/cons}
2. **{Option B}** (chosen): {pros/cons}

## Rationale
{Why this option was chosen}

## Impact
- Files affected: {list}
- Dependencies: {list}

Tags: decision, {topic}
```

### [CODE_PATTERN] - For Reusable Code

```markdown
[CODE_PATTERN] Pattern: {name}

## Purpose
{What this pattern does}

## Template
```{language}
{code template}
```

## Usage
{When and how to use}

Tags: pattern, {language}, {category}
```

### [MILESTONE] - For Achievements

```markdown
[MILESTONE] {short description}

## Summary
{What was accomplished}

## Details
- {detail 1}
- {detail 2}

Tags: milestone, {category}
```

### [GOTCHA] - For Traps and Workarounds

```markdown
[GOTCHA] {short description}

## Issue
{The non-obvious problem}

## Context
{When/where this occurs}

## Workaround
{How to avoid or fix}

Tags: gotcha, {category}
```

---

## Workflow with MCP

```
┌─────────────────────────────────────────────────────────────────┐
│                    PROJECT MEMORY WORKFLOW (MCP)                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  TRIGGER              MCP TOOL              ACTION              │
│  ───────              ────────              ──────              │
│                                                                 │
│  Start working   ───> memos_search    ───> Get project context  │
│                                                                 │
│  Hit error       ───> memos_search    ───> Find ERROR_PATTERN   │
│                       query: "ERROR_PATTERN {type}"             │
│                                                                 │
│  Need context    ───> memos_search ─> Smart search      │
│                       with conversation history                 │
│                                                                 │
│  Need root cause ───> memos_graph(mode=related) ───> View CAUSE chain     │
│                       query: "{error_keyword}"                  │
│                                                                 │
│  Trace path      ───> memos_graph(mode=path) ──> A→B→C chain          │
│                       source_id, target_id                      │
│                                                                 │
│  Check deps      ───> memos_graph(mode=related) ───> View relationships   │
│                       query: "{component}"                      │
│                                                                 │
│  Cube not found  ───> memos_admin(action=list_cubes) ──> Discover cubes       │
│                       include_status: true                      │
│                                                                 │
│  Graph health    ───> memos_graph(mode=schema) > Stats & structure   │
│                                                                 │
│  Solved error    ───> memos_save      ───> Save ERROR_PATTERN   │
│                       memory_type: "ERROR_PATTERN"              │
│                                                                 │
│  Make decision   ───> memos_save      ───> Save DECISION        │
│                       memory_type: "DECISION"                   │
│                                                                 │
│  Complete task   ───> memos_save      ───> Save MILESTONE       │
│                       memory_type: "MILESTONE"                  │
│                                                                 │
│  "之前/上次"     ───> memos_search    ───> Find history          │
│                                                                 │
│  Unsure search   ───> memos_suggest   ───> Get suggestions      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Best Practices

1. **Search Before Save** - Check if similar memory exists
2. **Be Specific** - Include file paths, function names, error messages
3. **Include Why** - Don't just record what, explain the reasoning
4. **Tag Consistently** - Use standard tags for searchability
5. **Save Immediately** - Record while context is fresh

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMOS_URL` | `http://localhost:18000` | oh-memos API base URL |
| `MEMOS_USER` | `dev_user` | Default user ID |
| `MEMOS_DEFAULT_CUBE` | `dev_cube` | Default memory cube ID |
| `MEMOS_CUBES_DIR` | *(required)* | Absolute path to the cube directory; must match the API's |
| `MEMOS_ENV_FILE` | — | Explicit `.env` location for the MCP server (needed under `npx`, where cwd is not the project) |
| `MEMOS_ENABLE_DELETE` | `false` | Exposes `memos_delete`; leave off unless the user asks |
| `MEMOS_SPREAD_ACTIVATION` | `false` | One-hop graph spreading activation (Full mode only). Brings back up to 12 related memories along CAUSE/CONDITION/RELATE edges |
| `MEMOS_SHOW_WORKING_MEMORY` | `false` | Show the scheduler-managed `WorkingMemory` tier. Hidden by default — those are short-lived duplicates of `LongTermMemory` |

`MEMOS_URL`, `MEMOS_USER`, `MEMOS_DEFAULT_CUBE` and `MEMOS_CUBES_DIR` are all
**required** by the MCP server — it exits if any is missing.

Neo4j/Qdrant credentials belong to the API, not to this skill; the MCP server
never connects to them directly.

---

## Auto-Registration & Auto-Creation

The MCP server includes **smart cube management**:

1. **Auto-Creation**: New projects automatically get their own cube (cloned from `dev_cube` template)
2. **Automatic Registration**: Cubes are auto-registered on first use
3. **Path Verification**: Checks if cube directory exists before registration
4. **Helpful Error Messages**: If a cube is not found and cannot be created, shows available cubes
5. **Cube Discovery**: Use `memos_admin(action=list_cubes)` to see all available cubes

**How it works for new projects:**
```
User starts Claude Code in ~/projects/my-new-project/
        ↓
MCP derives cube_id: "my_new_project_cube"
        ↓
Cube not found? Auto-create from dev_cube template
        ↓
Auto-register with oh-memos API
        ↓
Ready to use!
```

**Requirements:**
- `dev_cube` must exist as template in `MEMOS_CUBES_DIR`
- Cubes directory must be writable

If you see "Cube Registration Failed" error:
1. Use `memos_admin(action="list_cubes")` to see available cubes
2. Verify `dev_cube` exists as template
3. Check cubes directory permissions

```bash
# Manual registration (fallback)
curl -X POST "http://localhost:18000/mem_cubes" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"dev_user","mem_cube_name_or_path":"G:/test/oh-memos/data/oh-memos_cubes/dev_cube"}'
```

---

## Troubleshooting (MCP Tools Only)

> **Note**: All error recovery uses MCP tools - no Bash/curl required. Works in isolated projects.

### Cube Not Found Error

**Error**: `Cube 'xxx' not found` or `Cube not registered`

**Recovery Steps** (all via MCP):
1. `memos_admin(action="list_cubes")` → See available cubes
2. If cube exists but not registered: `memos_admin(action="register_cube", cube_id="xxx")`
3. If cube doesn't exist: Create cube directory with config.json, then register

**Example**:
```
memos_admin(action="list_cubes", include_status=true)
→ Shows: dev_cube (registered), my_project (not registered)

memos_admin(action="register_cube", cube_id="my_project")
→ "Cube 'my_project' registered successfully"
```

### User Does Not Exist Error

**Error**: `User 'xxx' does not exist`

**Recovery Steps** (all via MCP):
1. `memos_admin(action="create_user", user_id="xxx")` → Create the user
2. Retry the original operation

**Example**:
```
memos_save(content="...", cube_id="my_cube")
→ Error: User 'dev_user' does not exist

memos_admin(action="create_user", user_id="dev_user")
→ "User 'dev_user' created successfully"

memos_save(content="...", cube_id="my_cube")
→ Success
```

### MCP Connection Error

**Error**: MCP tools not responding or timeout

**Recovery Steps**:
1. Wait a moment and retry (API may be starting)
2. Try a simpler operation first: `memos_admin(action="list_cubes")`
3. If persistent, the oh-memos API service may need restart (outside MCP scope)

### Memory Not Found

**Error**: Search returns empty results

**Recovery Steps** (all via MCP):
1. `memos_list_v2(cube_id="xxx", limit=20)` → Check what memories exist
2. `memos_admin(action="list_cubes")` → Verify using correct cube_id
3. `memos_search(query="...", context=[...])` → Use context-aware search
4. Try broader search terms or different memory types

### Save Failed

**Error**: `Save operation failed`

**Recovery Steps** (all via MCP):
1. `memos_admin(action="list_cubes", include_status=true)` → Check cube status
2. If not registered: `memos_admin(action="register_cube", cube_id="xxx")`
3. If user error: `memos_admin(action="create_user", user_id="xxx")`
4. Retry save operation

### Quick Recovery Flowchart

```
Error occurred
    │
    ├─ "Cube not found" ────────────> memos_admin(action="list_cubes")
    │                                      │
    │                                      ├─ Found? → memos_admin(action="register_cube")
    │                                      └─ Not found? → Create cube first
    │
    ├─ "User does not exist" ───────> memos_admin(action="create_user", user_id="xxx")
    │
    ├─ "Save failed" ───────────────> memos_admin(action="list_cubes", include_status=true)
    │                                      │
    │                                      └─ Check cube/user, then retry
    │
    └─ "No results" ────────────────> memos_list_v2() to verify data exists
```

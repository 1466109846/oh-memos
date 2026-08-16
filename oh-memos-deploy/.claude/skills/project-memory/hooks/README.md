# oh-memos Hooks

Claude Code hooks that wire oh-memos into your session — context injection, intent
detection, milestone prompts, and guardrails against hand-rolled memory directories.

## Quick Start

Hook configuration lives in a single file: **[`settings-template.json`](settings-template.json)**.

Copy its `hooks` section into your `~/.claude/settings.json` (or the project's
`.claude/settings.json`), then replace every `<MEMOS_PATH>` with your oh-memos
install path.

```bash
# 查看模板
cat project-memory/hooks/settings-template.json

# 把 <MEMOS_PATH> 替换成你的安装路径，例如：
#   Linux / WSL   →  /mnt/g/test/oh-memos
#   Windows       →  G:/test/oh-memos
```

The hooks are Node.js scripts and run unchanged on Windows, WSL, Linux and macOS —
`node` on PATH is the only requirement.

## 已接入模板的 Hooks

| Hook | 事件 | 功能 |
|------|------|------|
| `oh_memos_session_start.js` | SessionStart | 输出 CWD → cube_id 映射 |
| `oh_memos_user_prompt.js` | UserPromptSubmit | 意图检测（历史 / 报错 / 决策）→ 建议 `memos_search` |
| `oh_memos_context_inject.js` | PreToolUse `Grep\|Glob\|Read\|Edit\|Write` | 自动检索记忆并注入为 `additionalContext` |
| `oh_memos_block_sensitive.js` | PreToolUse `Edit\|Write` | 编辑 `.env` / credentials 等敏感文件前告警 |
| `oh_memos_block_mkdir_memory.js` | PreToolUse `Bash` | 拦截 `mkdir.*memory`，强制走 MCP 工具 |
| `oh_memos_log_commands.js` | PostToolUse `Bash` | 记录命令历史备查 |
| `oh_memos_auto_save.js` | PostToolUse `Bash\|Edit\|Write` | 建议 `memory_type` 与 `project_path` |
| `oh_memos_notify_milestone.js` | PostToolUse `Edit\|Write` | 改动重要文件时提示存 MILESTONE |
| `oh_memos_pre_compact.js` | PreCompact | 提醒用 MCP 工具而非 `mkdir` 重建记忆 |
| `oh_memos_auto_capture.js` | PreCompact | **默认关闭**；`MEMOS_AUTO_CAPTURE=true` 后把有界会话 checkpoint 低置信度写入 API，失败开放且按 session/event 去重 |

The automatic capture hook is deliberately opt-in:

```text
MEMOS_AUTO_CAPTURE=true
MEMOS_AUTO_CAPTURE_MAX_CHARS=6000
MEMOS_AUTO_CAPTURE_TIMEOUT_MS=2500
```

It accepts a Claude hook JSON payload on stdin, keeps only bounded `summary`/
`context`/checkpoint text, and calls the existing `/memories` API. The API remains
the credential-redaction boundary. `MEMOS_MODE=lite` disables capture even when the
flag is set. API failures never block the assistant. The hook stores a hash marker
under the operating system temp directory so repeated PreCompact events do not
write the same checkpoint twice. It does not capture every PostToolUse result and
it never installs skills automatically.


| Hook | 说明 |
|------|------|
| `oh_memos_suggest_compact.js` | 上下文用量监控，70% / 90% 时告警。文件存在但未写进 `settings-template.json`，需要的话自行添加 |

## 文件结构

```
project-memory/hooks/
├── README.md
├── settings-template.json        ← 唯一配置入口，用 <MEMOS_PATH> 占位符
│
├── node/                         ← 跨平台实现（Windows / WSL / Linux / macOS）
│   ├── oh_memos_session_start.js
│   ├── oh_memos_user_prompt.js
│   ├── oh_memos_context_inject.js
│   ├── oh_memos_block_sensitive.js
│   ├── oh_memos_block_mkdir_memory.js
│   ├── oh_memos_log_commands.js
│   ├── oh_memos_auto_save.js
│   ├── oh_memos_notify_milestone.js
│   ├── oh_memos_pre_compact.js
│   ├── oh_memos_auto_capture.js
│   └── oh_memos_suggest_compact.js
│
└── powershell/                   ← 纯 Windows 的部分实现（无配置模板，需手写）
    ├── oh_memos_user_prompt.ps1
    ├── oh_memos_user_prompt.cmd
    ├── oh_memos_block_sensitive.ps1
    ├── oh_memos_log_commands.ps1
    └── oh_memos_notify_milestone.ps1
```

> `powershell/` 只覆盖 4 个 hook，且不再随附 `settings.json`。它存在的前提是你不想装
> Node —— 但 oh-memos 的 MCP server 本身就需要 Node，所以绝大多数情况直接用 `node/`
> 即可。

## 自定义

**添加敏感文件模式** — 编辑 `node/oh_memos_block_sensitive.js`：

```javascript
const sensitivePatterns = [
  '.env',
  'credentials',
  'your_pattern_here'
];
```

**添加里程碑文件** — 编辑 `node/oh_memos_notify_milestone.js`：

```javascript
const milestoneFiles = [
  'README.md',
  'your_file_here'
];
```

## 调试

```bash
claude --debug
```

## 相关文档

- [MCP Guide](../../docs/MCP_GUIDE.md) — MCP 记忆工具
- [CLAUDE.md](../../CLAUDE.md) — 项目配置

# Project Memory Skill (Enhanced)

<div align="center">

**Intelligent Project Memory for Claude Code**

*让 AI 真正理解你的项目历史*

[![MemOS](https://img.shields.io/badge/Powered%20by-MemOS-blue)](https://github.com/MemTensor/MemOS)
[![Claude Code](https://img.shields.io/badge/For-Claude%20Code-orange)](https://claude.ai)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

</div>

---

## What's New in Enhanced Version

| Feature | Description |
|---------|-------------|
| 🧠 **Smart Triggers** | Auto-detect when to search/save based on language patterns |
| 🔴 **Error Pattern Learning** | Remember error signatures and solutions for instant fixes |
| 📦 **Code Pattern Library** | Save reusable code templates, suggest when similar code detected |
| 🔗 **Decision Chain Tracking** | Track how decisions evolve over time with linked history |
| ⚠️ **Proactive Reminders** | Warn before repeating past mistakes |
| 🕸️ **Knowledge Graph** | Link related memories for better context |

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                    INTELLIGENT MEMORY WORKFLOW                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  USER ACTION          SMART TRIGGER           AI RESPONSE        │
│  ───────────          ─────────────           ────────────       │
│                                                                  │
│  "之前怎么做的"  ───>  Language detect   ───>  Search history    │
│  "last time..."                                                  │
│                                                                  │
│  Writing code    ───>  Pattern match    ───>  Suggest template  │
│                                               "Use CODE_PATTERN?" │
│                                                                  │
│  Error occurs    ───>  Signature match  ───>  Show solution     │
│                                               from ERROR_PATTERN │
│                                                                  │
│  Risky change    ───>  GOTCHA match     ───>  Proactive warning │
│                                               "Last time this..." │
│                                                                  │
│  Task complete   ───>  Auto evaluate    ───>  Prompt to save    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Memory Types

### Standard Types

| Type | Icon | Use Case |
|------|------|----------|
| `[MILESTONE]` | ✅ | Significant achievement |
| `[BUGFIX]` | 🐛 | Problem solved with solution |
| `[FEATURE]` | ✨ | New functionality added |
| `[DECISION]` | 🏗️ | Architecture/design choice |
| `[GOTCHA]` | ⚠️ | Non-obvious issue or workaround |
| `[CONFIG]` | ⚙️ | Environment/configuration change |
| `[PROGRESS]` | 📊 | Status update or checkpoint |

### Enhanced Types (New)

| Type | Icon | Use Case |
|------|------|----------|
| `[ERROR_PATTERN]` | 🔴 | Reusable error signature + solution |
| `[CODE_PATTERN]` | 📦 | Reusable code template |
| `[DECISION_CHAIN]` | 🔗 | Decision evolution timeline |
| `[KNOWLEDGE]` | 📚 | General project knowledge |

---

## Smart Triggers

### Language Pattern Detection

| When You Say | AI Automatically |
|--------------|------------------|
| "之前", "上次", "previously", "last time" | Searches history |
| "还记得", "remember", "recall" | Searches specific memory |
| "为什么", "why did we", "原因" | Searches decisions |
| "error", "错误", "how to fix" | Searches ERROR_PATTERN |
| "类似", "similar" | Searches CODE_PATTERN |
| "进度", "status", "progress" | Searches milestones |

### Code Context Detection

| When You Do | AI Automatically |
|-------------|------------------|
| Open file for editing | Search memories about that file |
| Error message appears | Search matching ERROR_PATTERN |
| Create new file | Search similar file patterns |
| Modify config | Search CONFIG history |
| Write repetitive code | Suggest existing CODE_PATTERN |

---

## Error Pattern Learning

When you solve an error, AI saves it structured for future instant recognition:

```markdown
[ERROR_PATTERN] Project: my-api | Date: 2025-01-25

## Error Signature
- Type: ModuleNotFoundError
- Message: No module named 'uvicorn'
- Context: Windows portable environment

## Root Cause
PATH not set for conda_venv/Scripts

## Solution
1. Check Python path: `where python`
2. Set PATH: `set PATH=%CD%\conda_venv;%CD%\conda_venv\Scripts;%PATH%`

## Prevention
Always use run.bat which sets PATH correctly

Tags: error, ModuleNotFoundError, PATH, windows
```

**Next time same error occurs** → AI instantly shows the solution!

---

## Code Pattern Library

Save reusable patterns for consistency:

```markdown
[CODE_PATTERN] Project: my-api | Pattern: Async Retry Decorator

## Purpose
Generic retry with exponential backoff for async functions

## Template
```python
def async_retry(retries=3, delay=1.0, backoff=2.0):
    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            # ... retry logic
        return wrapper
    return decorator
```

## Used In
- src/services/api.py:25
- src/db/connection.py:42
```

**When AI detects similar code** → Suggests: "Use existing pattern?"

---

## Decision Chain Tracking

Track how decisions evolve:

```markdown
[DECISION_CHAIN] Project: my-api | Topic: Authentication

## Evolution Timeline
| Date | Decision | Rationale |
|------|----------|-----------|
| 01-10 | Session-based | Simple, familiar |
| 01-15 | JWT only | Stateless, scalable |
| 01-25 | JWT + Refresh | Balance security & UX |

## Current Decision
JWT with Refresh Token

## Why Changed
Session didn't scale; pure JWT had security concerns
```

**When working on auth** → AI shows decision history & rationale

---

## Proactive Reminders

AI warns you before repeating mistakes:

```
⚠️ Heads up: Last time we modified redis.conf, we encountered
   connection timeout issues. Remember to restart the Redis
   container after config changes.

   Related: [GOTCHA-REDIS-001]
```

### Reminder Triggers

| Priority | Type | When |
|----------|------|------|
| 🔴 High | Gotcha/Error Prevention | Before risky action |
| 🟡 Medium | Code Pattern Suggestion | When writing similar code |
| 🟢 Low | Progress Checkpoint | After 3+ tasks completed |

---

## Quick Start

### Installation

```bash
# Copy skill to Claude Code skills directory
cp -r project-memory ~/.claude/skills/

# Run installer for CLI commands
bash ~/.claude/skills/project-memory/scripts/linux/install.sh
```

### CLI Commands

```bash
memos-init                           # Initialize project
memos-save "content" -t TYPE         # Save memory
memos-search "query"                 # Search memories
```

### Memory Type Options

```bash
memos-save "Fixed login bug" -t BUGFIX
memos-save "Chose PostgreSQL" -t DECISION
memos-save "Auth system complete" -t MILESTONE
memos-save "Docker needs 2GB RAM" -t GOTCHA
memos-save "Retry decorator pattern" -t CODE_PATTERN
memos-save "Connection error fix" -t ERROR_PATTERN
```

---

## Directory Structure

```
project-memory/
├── SKILL.md                    # AI behavior instructions
├── README.md                   # This file
├── README_CN.md                # Chinese documentation
├── LICENSE
├── references/
│   └── examples.md             # Memory format examples
├── scripts/
│   └── oh_memos_utils.py       # Shared helpers
└── hooks/
    ├── settings-template.json  # Claude Code hook wiring
    ├── README.md
    ├── node/                   # 10 hooks (session start, prompt, compact, ...)
    └── powershell/             # PowerShell variants of a subset
```

Memory operations go through the MCP tools, not through scripts.

---

## Environment Variables

All four are **required** — the MCP server exits if any is missing.

| Variable | Example | Description |
|----------|---------|-------------|
| `MEMOS_URL` | `http://127.0.0.1:18000` | oh-memos API URL |
| `MEMOS_USER` | `dev_user` | Default user ID |
| `MEMOS_DEFAULT_CUBE` | `dev_cube` | Default memory cube ID |
| `MEMOS_CUBES_DIR` | `/abs/path/oh-memos/data/oh-memos_cubes` | Cube directory; must match the API's |

Optional: `MEMOS_ENV_FILE` pins the `.env` location (needed under `npx`, where the
cwd is not the project), and `MEMOS_ENABLE_DELETE=true` exposes `memos_delete`.

---

## Prerequisites

- [oh-memos](https://github.com/lsg1103275794/oh-memos) API running at `127.0.0.1:18000`
- Node.js 18+ for the MCP server (`npx -y oh-memos-mcp`)
- Claude Code CLI

---

## Example Scenarios

### Scenario 1: Error Recognition

```
👤 You: I'm getting "ConnectionRefusedError" when starting the app

🤖 AI: [Searching ERROR_PATTERN...]

    Found matching error pattern!

    📌 ERROR_PATTERN: ConnectionRefusedError - Redis Startup

    Root Cause: Redis container not ready when app starts

    Solution:
    1. Add healthcheck to Redis in docker-compose.yml
    2. Use `depends_on: condition: service_healthy`

    [GOTCHA-REDIS-001]
```

### Scenario 2: Code Reuse

```
👤 You: I need to add retry logic to this API call

🤖 AI: I noticed you have an existing pattern for this!

    📦 CODE_PATTERN: Async Retry Decorator

    Already used in:
    - src/services/api.py:25
    - src/db/connection.py:42

    Would you like to use this pattern for consistency?
```

### Scenario 3: Decision Context

```
👤 You: Why are we using JWT instead of sessions?

🤖 AI: [Searching DECISION_CHAIN...]

    🔗 DECISION_CHAIN: Authentication Method

    Evolution:
    • 01-10: Session-based → Simple but doesn't scale
    • 01-15: JWT only → Stateless but security concerns
    • 01-25: JWT + Refresh → Current (balanced approach)

    Current rationale: Need to support multiple clients
    (web, mobile, CLI) with different security needs
```

---

## Related Links

- [MemOS](https://github.com/MemTensor/MemOS) - Memory backend
- [Claude Code](https://claude.ai) - Anthropic CLI
- [Full Examples](references/examples.md) - Memory format templates

---

## License

MIT License

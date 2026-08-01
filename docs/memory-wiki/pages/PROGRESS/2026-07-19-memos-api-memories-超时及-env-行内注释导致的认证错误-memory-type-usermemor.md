---
generator: oh-memos-wiki-export
id: 1e412ee0-a36b-4e29-8c75-27341403fb30
type: PROGRESS
status: activated
tags: ["MemOS", "API", "timeout", ".env", "inline comment", "authentication", "debugging", "uvicorn", "WSL"]
confidence: 0.66
created: 2026-07-19T21:23:00.159902000+00:00
updated: 2026-07-19T21:23:00.159902000+00:00
---

# MemOS API /memories 超时及 .env 行内注释导致的认证错误",
  "memory_type": "UserMemory",
  "value": "2026年4月18日17:51，用户在使用位于 /mnt/g/tes

2026年4月18日17:51，用户在使用位于 /mnt/g/test/oh-memos 项目的 MemOS API 时，向 POST /memories（http://localhost:18000/memories）发送请求，出现持续 60 秒的超时。MCP 工具 memos_save 返回 502 或 UNEXPECTED_ERROR，使用 curl 直接访问同一接口同样在 60 秒后超时；而 /health/detail 接口返回 200，Neo4j 与 Qdrant 正常工作。经排查，根因是 .env 文件中第 76 行和第 104 行的行内注释未使用引号，形如 OPENAI_API_KEY=xxxx # API 密钥，导致 python‑dotenv 将注释内容一起作为环境变量值传递，进而在调用 LongCat LLM 和 SiliconFlow 嵌入服务时产生带有额外字符的 token，返回 401 Authentication failed。用户通过三步诊断（curl -m 60 POST /memories、直接用 .env 中的 key 访问上游接口、检查 401 错误中的多余字符）确认了该问题。修复方案为：将注释移至变量上方，或使用引号包裹值（KEY=\"value\" # comment），并手动重启 uvicorn 因其自动重载不监控 .env 的跨 WSL/Windows 文件更改。",
  "tags": [
    "MemOS",
    "API",
    "timeout",
    ".env",
    "inline comment",
    "authentication",
    "debugging",
    "uvicorn",
    "WSL"
  ],
  "summary": "在 2026 年 4 月 18 日，用户在使用 MemOS 项目时，发现 POST /memories 接口会卡住 60 秒，导致 MCP 工具返回 502 或 UNEXPECTED_ERROR，而健康检查接口仍然正常。经过排查，用户发现 .env 文件中出现了行内注释未加引号的情况（如 KEY=value # comment），导致 python‑dotenv 将注释内容一起读取，向 LongCat 和 SiliconFlow 发送的 API key 含有多余字符，从而触发 401 认证失败。用户采用了“curl‑m‑60 POST /memories → 直接测试 .env 中的 key → 检查 401 错误中是否有多余字符”的三步诊断法，确认了问题根源。为了解决，用户将注释移到变量上方或为变量值加上引号，并在修改后手动重启 uvicorn，因为自动重载在 WSL 与 Windows 文件系统之间无法检测 .env 的变化。项目位于 /mnt/g/test/oh-memos，根 .env 会覆盖 src/.env。

## 关联

- 上级 → [[2026-04-18-修复方案-移动注释或加引号]]
- 上级 → [[2026-04-18-诊断三步法]]
- 上级 → [[2026-04-18-根因分析-行内注释污染-api-key]]
- 上级 → [[2026-04-18-memos-api-请求挂死问题]]
- 被后续 ← [[2026-04-18-uvicorn-reload-不监听-env-变化]]
- 被导致 ← [[2026-04-18-uvicorn-reload-不监听-env-变化]]
- 被后续 ← [[2026-04-18-memos-api-请求挂死问题]]
- 被相关 ← [[2026-04-18-memos-api-请求挂死问题]]

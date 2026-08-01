---
generator: oh-memos-wiki-export
id: 138e8cab-e794-4382-a04a-696361607724
type: ERROR_PATTERN
status: activated
tags: ["uvicorn", "reload limitation", "WSL", "restart required"]
confidence: 0.99
created: 2026-04-18T17:51:07.536740000+00:00
updated: 2026-04-18T17:51:07.620479000+00:00
---

# uvicorn --reload 不监听 .env 变化

A critical pitfall is that uvicorn --reload only monitors .py files and does not detect changes to .env files. In WSL environments modifying Windows-hosted files may not trigger reload even if touched, requiring manual Ctrl+C restart of the API process in the Windows run.bat window.

## 关联

- 被上级 ← [[2026-07-19-uvicorn-重载-wsl-环境下-fastapi-测试与服务重启注意事项-memory-type-longtermm]]
- 后续 → [[2026-07-19-uvicorn-重载-wsl-环境下-fastapi-测试与服务重启注意事项-memory-type-longtermm]]
- 相关 → [[2026-07-19-uvicorn-重载-wsl-环境下-fastapi-测试与服务重启注意事项-memory-type-longtermm]]
- 后续 → [[2026-07-19-memos-api-memories-超时及-env-行内注释导致的认证错误-memory-type-usermemor]]
- 导致 → [[2026-07-19-memos-api-memories-超时及-env-行内注释导致的认证错误-memory-type-usermemor]]

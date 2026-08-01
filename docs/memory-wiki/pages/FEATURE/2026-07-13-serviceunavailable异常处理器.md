---
generator: oh-memos-wiki-export
id: 1635cd1a-ba9b-45aa-b4df-b408cbee1788
type: FEATURE
status: activated
tags: ["start_api", "异常处理", "503", "ServiceUnavailable"]
confidence: 0.99
created: 2026-07-13T04:37:31.256554000+00:00
updated: 2026-07-13T04:37:31.377814000+00:00
---

# ServiceUnavailable异常处理器

用户在src/oh_memos/api/start_api.py中，在通用Exception handler之前新增了@app.exception_handler(neo4j.exceptions.ServiceUnavailable)，返回503及清晰提示，而非裸500堆栈。使用try/except ImportError守护注册过程（因为neo4j是可选后端，general_text模式可能未安装）。

## 关联

- 被上级 ← [[2026-07-17-oh-memos项目neo4j连接韧性与fallback超时修复全记录]]
- 相关 → [[2026-07-17-oh-memos项目neo4j连接韧性与fallback超时修复全记录]]
- 后续 → [[2026-07-17-oh-memos项目neo4j连接韧性与fallback超时修复全记录]]

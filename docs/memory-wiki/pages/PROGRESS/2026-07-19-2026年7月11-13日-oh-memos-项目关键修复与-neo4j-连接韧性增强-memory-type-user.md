---
generator: oh-memos-wiki-export
id: 147f1650-5ad3-43fd-a3f6-9fa07510eea5
type: PROGRESS
status: activated
tags: ["Neo4j", "连接韧性", "指数退避", "写后读一致性", "搜索一致性", "probe", "deepseek", "fallback", "uvicorn", "服务恢复", "API异常处理"]
confidence: 0.66
created: 2026-07-19T21:22:45.738800000+00:00
updated: 2026-07-19T21:22:45.738800000+00:00
---

# 2026年7月11‑13日 oh‑memos 项目关键修复与 Neo4j 连接韧性增强",
  "memory_type": "UserMemory",
  "value": "2026年7月11日凌晨12:38，用户在 oh‑memos 

2026年7月11日凌晨12:38，用户在 oh‑memos 系统中执行编号为 PROBE‑ZXQV7731 的写后读一致性探针，旨在复现“存后即搜不命中”问题，涉及 deepseek‑v4‑pro 降级子系统的全链路验证。随后同一天，用户定位根因：neo4j_community.py 中的 Cypher 查询缺少 ORDER BY，导致返回顺序不确定；以及 start_api.py 的 /search 接口未转发 MCP 的 top_k 参数。为解决，用户在 neo4j_community.py 的 get_all_memory_items 中加入 `ORDER BY coalesce(n.updated_at,n.created_at) DESC` 并删除冗余打印；在 start_api.py 的 SearchRequest 中增加 top_k 字段并在 mos.search 中转发。用户通过存入记忆 PROBE‑FB9977 并立即搜索，验证该记忆位列第一，问题得到修复。同时，用户在 2026年7月13日 为 oh‑memos 项目加入 Neo4j 连接韧性：在 Neo4jGraphDB.__init__ 中于 driver.verify_connectivity 前调用 _wait_for_connection，实现带封顶指数退避的重试（默认 max_retries=8，backoff_cap=5 秒，约 32 秒），仅对 ServiceUnavailable 错误重试，AuthError 与 ConfigurationError 直接抛出。由于 GraphStoreFactory 在 cube 注册时缓存，重试仅在每个 cube 初始化时执行一次。API 层新增对 ServiceUnavailable 的异常处理器，返回 503 状态码及清晰提示，并用 ImportError 包裹可选依赖注册。用户确认相关文件已通过 py_compile，但运行的仍是旧代码，需要通过重启 uvicorn（使用 start.bat）使改动生效；运维层已利用 winnat 端口保留并启动 Neo4j，恢复服务。",
  "tags": [
    "Neo4j",
    "连接韧性",
    "指数退避",
    "写后读一致性",
    "搜索一致性",
    "probe",
    "deepseek",
    "fallback",
    "uvicorn",
    "服务恢复",
    "API异常处理"
  ],
  "summary": "2026年7月11日，用户通过探针 PROBE‑ZXQV7731 重现并定位了 oh‑memos 中“存后即搜不命中”的写后读一致性问题，随后在 neo4j_community.py 添加 ORDER BY 并在 start_api.py 转发 top_k 参数，验证 PROBE‑FB9977 能立即被搜索命中。2026年7月13日，用户又为项目加入 Neo4j 连接韧性，参考此前修复 LLM WinError 10053 的思路，在 Neo4jGraphDB 初始化中实现封顶指数退避的连接等待，并在 API 层加入 ServiceUnavailable 异常处理返回 503。两项改动均已通过 py_compile，需重启 uvicorn 生效，运维已通过 winnat 端口保留并启动 Neo4j，确保服务恢复。

## 关联

- 上级 → [[2026-07-13-neo4jgraphdb初始化重试机制]]
- 上级 → [[2026-07-13-为oh-memos增加neo4j连接韧性]]
- 上级 → [[2026-07-11-修复存后即搜不命中问题-写后读一致性]]
- 上级 → [[2026-07-11-写后读一致性探针测试]]
- 被相关 ← [[2026-07-13-为oh-memos增加neo4j连接韧性]]
- 被后续 ← [[2026-07-13-为oh-memos增加neo4j连接韧性]]
- 被后续 ← [[2026-07-11-写后读一致性探针测试]]
- 被导致 ← [[2026-07-11-写后读一致性探针测试]]

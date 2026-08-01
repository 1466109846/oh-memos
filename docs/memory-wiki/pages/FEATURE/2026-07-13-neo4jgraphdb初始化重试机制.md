---
generator: oh-memos-wiki-export
id: 6af3435b-b83a-46b5-becd-7e3a3c637c3f
type: FEATURE
status: activated
tags: ["Neo4jGraphDB", "指数退避", "启动竞态", "重试机制"]
confidence: 0.99
created: 2026-07-13T04:37:31.111583000+00:00
updated: 2026-07-13T04:37:31.377814000+00:00
---

# Neo4jGraphDB初始化重试机制

用户在src/oh_memos/graph_dbs/neo4j.py的Neo4jGraphDB.__init__中，在GraphDatabase.driver()（惰性，不建连）之后、_ensure_database_exists()/create_index()（首次真正建连）之前，新增了self._wait_for_connection()方法。该方法使用driver.verify_connectivity()加上封顶指数退避（默认max_retries=8, backoff_cap=5s，合计约32s）进行轮询，仅重试ServiceUnavailable错误（AuthError/ConfigurationError属于永久配置错误，立即抛出），耗尽后抛出带指引的ServiceUnavailable。目的是将“API先于Neo4j就绪”的启动竞态从崩溃变成短暂等待。由于Neo4jGraphDB由GraphStoreFactory.from_config在cube注册（TreeTextMemory构造）时创建并缓存进mos.mem_cubes，重试每个cube只发生一次，不会每请求阻塞。Neo4jCommunityGraphDB通过super().__init__自动继承。

## 关联

- 被上级 ← [[2026-07-19-2026年7月11-13日-oh-memos-项目关键修复与-neo4j-连接韧性增强-memory-type-user]]

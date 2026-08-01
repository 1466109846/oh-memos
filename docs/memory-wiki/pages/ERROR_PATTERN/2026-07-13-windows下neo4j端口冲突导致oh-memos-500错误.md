---
generator: oh-memos-wiki-export
id: d3451ebf-0d36-4eee-9f6d-4301e4b25a42
type: ERROR_PATTERN
status: activated
tags: ["oh-memos", "Neo4j", "Windows", "端口冲突", "winnat", "500错误", "Hyper-V", "WSL2"]
confidence: 0.99
created: 2026-07-13T04:36:10.956259000+00:00
updated: 2026-07-13T04:36:11.213149000+00:00
---

# Windows下Neo4j端口冲突导致oh-memos 500错误

在2026年7月13日，用户修复了oh-memos在Windows启动时Neo4j连接失败的问题，该问题导致/memories、/mem_cubes及MCP memos_search全部返回500错误。根本原因是Windows Hyper-V/WSL2的winnat服务将Bolt端口7687和7474动态保留进了TCP排除端口范围（诊断命令`netsh int ipv4 show excludedportrange protocol=tcp`显示7614-7713覆盖7687，7462-7561覆盖7474）。关键识别特征是Neo4j绑定时报`java.net.BindException: Address already in use: bind`，但`Get-NetTCPConnection -LocalPort 7687`显示无人监听（端口只是被保留，不是被占用）。neo4j.log表现为`ERROR Failed to start Neo4j on localhost:7474` -> `SocketNettyConnector ... failed to start` -> `Caused by: java.net.BindException: Address already in use: bind`。

## 关联

- 被相关 ← [[2026-07-13-为oh-memos增加neo4j连接韧性]]
- 后续 → [[2026-07-17-oh-memos项目neo4j连接韧性与fallback超时修复全记录]]
- 相关 → [[2026-07-17-oh-memos项目neo4j连接韧性与fallback超时修复全记录]]
- 后续 → [[2026-07-13-为oh-memos增加neo4j连接韧性]]
- 导致 → [[2026-07-13-为oh-memos增加neo4j连接韧性]]
- 相关 → [[2026-07-13-为oh-memos增加neo4j连接韧性]]
- 相关 → [[2026-07-11-全链路验证通过]]
- 被后续 ← [[2026-07-11-全链路验证通过]]

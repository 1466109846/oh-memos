---
generator: oh-memos-wiki-export
id: 2eada517-3cbc-47aa-b0c6-a4569ed644a1
type: ERROR_PATTERN
status: activated
tags: ["Neo4j", "Java 24", "G1 OOM", "内存配置", "heap", "pagecache"]
confidence: 0.99
created: 2026-07-13T04:36:11.212136000+00:00
updated: 2026-07-13T04:36:11.213149000+00:00
---

# Neo4j在Java 24下的G1 mmap OOM隐患修复

用户发现并修复了另一隐患：该机Neo4j 5.15运行在Java 24上（官方仅支持17），且neo4j.conf的堆内存使用自动计算加`-XX:+AlwaysPreTouch`，在内存抖动时触发了G1 mmap OOM（hs_err_pid*.log显示"insufficient memory ... G1 virtual space"）。用户通过在conf中显式设置heap为1g和pagecache为1g来规避此问题。

## 关联

- 被上级 ← [[2026-07-17-oh-memos项目neo4j连接韧性与fallback超时修复全记录]]
- 后续 → [[2026-07-17-oh-memos项目neo4j连接韧性与fallback超时修复全记录]]
- 相关 → [[2026-07-17-oh-memos项目neo4j连接韧性与fallback超时修复全记录]]

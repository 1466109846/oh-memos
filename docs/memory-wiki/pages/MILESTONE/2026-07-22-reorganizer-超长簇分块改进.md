---
generator: oh-memos-wiki-export
id: 789a66db-6981-4ca7-a487-51cf30efd9ce
type: MILESTONE
status: activated
tags: ["reorganizer", "超长簇", "分块", "LLM"]
confidence: 0.99
created: 2026-07-22T17:15:59.741307000+00:00
updated: 2026-07-22T17:16:00.375260000+00:00
---

# reorganizer 超长簇分块改进

用户在 _local_subcluster 中将超过 15000 字符的超长簇改为确定性分块（每组 20），避免了之前截断喂入 LLM 导致尾部节点丢失和超时的问题。

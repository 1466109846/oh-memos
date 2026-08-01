---
generator: oh-memos-wiki-export
id: 49dc818e-1457-43f0-9cb0-c60a1549d24a
type: MILESTONE
status: activated
tags: ["Python", "get_default_cube_id", "对齐", "环境变量"]
confidence: 0.99
created: 2026-07-22T17:16:00.232825000+00:00
updated: 2026-07-22T17:16:00.375260000+00:00
---

# Python get_default_cube_id 对齐 Node 行为

用户在 Python 中对 get_default_cube_id 进行对齐，使其在 env 明确设置且 cube 存在时优先使用，否则通过 CWD 推导，消除了双端漂移，并启用了原先已废弃的 is_default_cube_from_env。

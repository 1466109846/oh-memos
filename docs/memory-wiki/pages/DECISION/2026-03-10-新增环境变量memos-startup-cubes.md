---
generator: oh-memos-wiki-export
id: 1a0b9339-f745-4fa5-81bf-d7b4635fad56
type: DECISION
status: activated
tags: ["环境变量", "配置管理", "启动控制", "向后兼容"]
confidence: 0.99
created: 2026-03-10T19:38:16.706899000+00:00
updated: 2026-03-10T19:38:16.866124000+00:00
---

# 新增环境变量MEMOS_STARTUP_CUBES

用户添加了名为MEMOS_STARTUP_CUBES的环境变量来控制启动时注册的cube数量：未设置或为空时仅注册默认cube实现快速启动；设置为具体cube名称如'cube1,cube2'时可指定多个cube；设置为'all'时恢复旧行为注册全部cube。

## 关联

- 被上级 ← [[2026-04-18-cube自动注册问题修复与api启动优化]]

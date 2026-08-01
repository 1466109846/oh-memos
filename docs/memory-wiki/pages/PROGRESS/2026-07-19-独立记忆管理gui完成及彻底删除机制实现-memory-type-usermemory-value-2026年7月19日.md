---
generator: oh-memos-wiki-export
id: 850a78ee-1e70-4953-9ff3-5f3f5a951041
type: PROGRESS
status: activated
tags: ["memory management", "FastAPI", "Neo4j", "Qdrant", "data deletion", "backup", "dirty data", "verification"]
confidence: 0.66
created: 2026-07-19T19:54:47.326977000+00:00
updated: 2026-07-19T19:54:47.326977000+00:00
---

# 独立记忆管理GUI完成及彻底删除机制实现",
  "memory_type": "UserMemory",
  "value": "2026年7月19日19:53，用户完成了独立记忆管理GUI（位于 tools/memory-admin/）

2026年7月19日19:53，用户完成了独立记忆管理GUI（位于 tools/memory-admin/），使用 FastAPI 与单页 HTML，直接连接 Neo4j、Qdrant 与文件系统，独立于主 API（端口18000），即使主 API 未启动也可运行。启动方式为 .venv/Scripts/python.exe tools/memory-admin/run.py，访问 http://127.0.0.1:18010。GUI 功能包括浏览/搜索各 cube 记忆、查看详情、删除单条记忆、彻底删除整个 cube、导出备份。彻底删除 cube 需要同步清理三处数据：1）Neo4j 中匹配 user_name=cube_id 的所有 Memory 节点，使用 MATCH (n:Memory) WHERE n.user_name=$cube DETACH DELETE n；2）Qdrant 中对应的 {cube_id}_graph collection，使用 delete_collection 删除；3）文件系统中 MEMOS_CUBES_DIR/{cube_id}/ 目录及其 config.json。删除前实现三重保护：① 二次确认，必须输入 cube 名称并经后端校验；② 干跑预览（/delete-preview 端点），仅统计将被删除的内容；③ 自动导出该 cube 的 JSON 备份至 backups/。db_admin.py 对每个数据源采用独立 try‑catch 容错，app.py 使用同步 def 端点避免阻塞。验证结果显示 Neo4j 中共有 4688 条节点，user_name 与 cube_id 完全对应，例如 dev_cube=60、audiocraft_studio_cube=996 等。dev_cube 预览显示 Neo4j 节点数 60、Qdrant collection dev_cube_graph 包含 77 条向量、文件系统目录存在。检查中发现脏数据：user_name 为 'openclaw'（34 条）和 'jincaizhaopin'（2 条）的节点缺少 _cube 后缀，可通过该 GUI 进行清理。",
  "tags": [
    "memory management",
    "FastAPI",
    "Neo4j",
    "Qdrant",
    "data deletion",
    "backup",
    "dirty data",
    "verification"
  ],
  "summary": "用户于2026年7月19日19:53完成了独立记忆管理GUI的开发，采用FastAPI与单页HTML，直接对接Neo4j、Qdrant和文件系统，独立于主API（端口18000），即使主API未启动亦可使用。功能包括浏览、搜索、查看详情、单条及整cube删除、备份导出。为实现cube的彻底删除，用户同步清理Neo4j节点、Qdrant集合和文件系统目录，并加入二次确认、干跑预览和自动备份的三重保护，确保安全且不受单源故障影响。验证显示系统中共4688条节点，发现部分无后缀的脏数据，可通过该GUI清理。

## 关联

- 上级 → [[2026-07-19-验证结果与脏数据发现]]
- 上级 → [[2026-07-19-三重删除保护机制]]
- 上级 → [[2026-07-19-cube彻底删除三处清理]]
- 被后续 ← [[2026-07-19-cube彻底删除三处清理]]
- 被相关 ← [[2026-07-19-cube彻底删除三处清理]]
- 被相关 ← [[2026-07-11-全链路验证通过]]
- 被后续 ← [[2026-07-11-全链路验证通过]]

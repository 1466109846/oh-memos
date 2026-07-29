# oh-memos 记忆管理 GUI

一个**独立于主 API** 的 Web 管理面板,用于查询各 cube 的记忆、删除单条记忆、以及**彻底删除整个 cube**(同时清理 Neo4j、Qdrant、cube 目录三处数据)。

即使主 API(端口 18000)未启动也能使用 —— 本工具直连数据库。

## 为什么需要它

oh-memos 会不断新建 cube,但此前没有「删除 cube 及其全部数据」的能力。一个 cube 的数据分散在三处:

| 数据源 | 分区方式 | 位置 |
|--------|---------|------|
| Neo4j 图 | 所有 cube 共享一个库,靠节点属性 `user_name = cube_id` 区分,label 为 `Memory` | `bolt://localhost:7687` |
| Qdrant 向量 | 每个 cube 一个 collection,命名 `{cube_id}_graph` | `localhost:16333` |
| 文件系统 | 每个 cube 一个目录 + `config.json` | `MEMOS_CUBES_DIR` |

「彻底删除一个 cube」= 三处一起清。本工具把这件事做成一个带防护的操作。

## 功能

- **cube 总览**:列出所有 cube 及其 Neo4j 节点数、Qdrant 向量数、目录是否存在;标记「孤儿 cube」(数据只残留在部分数据源)。
- **记忆浏览**:按 cube 查看记忆,支持关键词搜索与分页;查看单条记忆的完整元数据与关联边。
- **导出**:一键导出某 cube 的全部节点(含 embedding)与关系为 JSON。
- **删除单条记忆**:同时从 Neo4j 与 Qdrant 删除。
- **彻底删除 cube**:清 Neo4j 节点 + 删 Qdrant collection + 删 cube 目录。
- **批量删除 cube**:勾选多个 cube(支持全选)一次性彻底删除,输入 `Y` 确认,每个 cube 各自自动备份。
- **备份管理**:在「📦 备份管理」视图查看 / 下载 / 删除 `backups/` 里的备份文件(删除仅删备份文件,不影响数据库中的现有数据)。

### 三重删除保护

1. **二次确认** —— 删除 cube 必须手动输入 cube 名称才能执行。
2. **干跑预览** —— 删除前先展示「将删除 N 个节点 / collection X / 目录 Y」,确认后才执行。
3. **删前自动备份** —— 实删前自动把数据导出为 JSON 存入 `backups/`,可回溯。

## 启动

依赖(`fastapi` / `uvicorn` / `neo4j` / `qdrant-client`)项目已包含,无需额外安装。

```bash
# 项目根目录下
.venv/bin/python tools/memory-admin/run.py          # Linux / WSL
# 或 Windows:
.venv\Scripts\python tools\memory-admin\run.py
```

启动后浏览器打开 <http://127.0.0.1:18010>。

连接参数自动从项目根 `.env` 读取(`NEO4J_URI/USER/PASSWORD/DB_NAME`、`QDRANT_HOST/PORT`、`MEMOS_CUBES_DIR`)。可用环境变量 `MEMORY_ADMIN_HOST` / `MEMORY_ADMIN_PORT` 覆盖服务地址。

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 三个数据源连通性 |
| GET | `/api/cubes` | cube 列表 + 三源统计 |
| GET | `/api/cubes/{cube}/memories?q=&limit=&offset=` | 记忆列表(搜索/分页) |
| GET | `/api/cubes/{cube}/memories/{id}` | 单条详情 |
| GET | `/api/cubes/{cube}/export` | 导出 JSON |
| POST | `/api/cubes/{cube}/delete-preview` | cube 删除干跑 |
| DELETE | `/api/cubes/{cube}?confirm={cube}` | 彻底删除 cube(校验 confirm) |
| POST | `/api/cubes/batch-delete-preview` | 批量删除干跑(逐个预览 + 合计影响) |
| POST | `/api/cubes/batch-delete` | 批量彻底删除(body `confirm` 须为 `Y`) |
| GET | `/api/backups` | 备份文件列表 |
| GET | `/api/backups/{name}/download` | 下载某个备份 |
| DELETE | `/api/backups/{name}` | 删除某个备份文件(含路径穿越防护) |
| POST | `/api/cubes/{cube}/memories/{id}/delete-preview` | 单条删除干跑 |
| DELETE | `/api/cubes/{cube}/memories/{id}` | 删除单条记忆 |

## 安全说明

- 服务默认只绑定 `127.0.0.1`,不把删除能力暴露到网络。
- `backups/` 可能含敏感记忆内容,已在 `.gitignore` 中排除。
- 当前实现针对 Neo4j **单库 + user_name 隔离**架构(`MOS_NEO4J_SHARED_DB=false`)。若切换到 multi-db(每 cube 一个 database),需将 `db_admin.delete_cube` 的 Neo4j 步骤改为 drop database(代码中已留判断分支 `NEO4J_USE_MULTI_DB`)。

## 文件结构

```
tools/memory-admin/
├── config.py          # 从 .env 读取连接配置(零依赖解析)
├── db_admin.py        # 核心:直连 Neo4j/Qdrant/文件系统的查询与删除
├── app.py             # FastAPI 端点(同步 def,避免阻塞事件循环)
├── static/index.html  # 单页 GUI(原生 JS,无外部依赖)
├── run.py             # 启动脚本
└── backups/           # 删除前自动导出的 JSON(git 忽略)
```

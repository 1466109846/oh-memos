# Wiki 往返回灌与对标 memsearch 的能力补齐

> 2026-08-16 · 状态：Phase 1-5 的最小生产闭环已实现；关系原地更新、完整 SQLite Lite 后端和自动 Skill 安装仍待排期

## 背景

[zilliztech/memsearch](https://github.com/zilliztech/memsearch) 与 oh-memos 处在同一赛道
（AI 编程助手的持久记忆层），但设计取向相反：

| 维度 | memsearch | oh-memos |
|---|---|---|
| 记什么 | 插件钩子自动捕获每轮对话，LLM 摘要后追加到每日 `.md` | agent 主动 `memos_save`，带显式类型 |
| 真相源 | Markdown 文件，Milvus 只是可重建的影子索引 | Qdrant + Neo4j，Markdown 仅是单向导出产物 |
| 接入 | 每平台一个插件 + CLI，无 MCP | MCP 原生，13 个工具 |
| 检索 | 稠密 + BM25 稀疏 + RRF，三层渐进召回 | 语义召回 + Neo4j 关系图谱（路径、影响分析） |
| 部署 | pip 装、Milvus Lite 单文件、本地 ONNX embedding | Docker Compose 三容器，需配模型凭据 |

结论是互补大于竞争：memsearch 是「会话档案馆」，不依赖 agent 自觉但噪音大、无结构；
oh-memos 是「项目知识库」，质量高、可推理但依赖调用纪律、门槛高。
MCP 通用性、图推理、类型化记忆和任务画布是 oh-memos 的护城河，
memsearch 的平文件架构短期补不上。

反过来，memsearch 有五个点值得吸收，本文按投入产出排序并分期。

## Phase 1：Wiki 往返回灌（已实现）

### 问题

`memos_export_wiki` 是单向的。导出的 Markdown 只能读，人工修正无法回到记忆库；
记忆一旦写错，唯一的修复手段是删除重写。这是 memsearch「Markdown 即真相源」
最直接的收益点：记忆可 diff、可手工纠正、可 review。

### 设计

新增 `memos_import_wiki`，与导出器构成闭环。之所以选择往返而不是照搬
「Markdown 为真相源」，是因为后者要重写整个存储层，而往返在现有架构下就能
拿到「可审阅、可修复」的核心价值。

关键前提（探索现有代码后确认）：

1. 导出页的 front-matter 已经带 `id`，页与记忆一一对应，无需另建映射；
2. `core.py` 已有 `MOS_TYPED_SAVE_FAST` 快速路径——`memory_content` 匹配
   `^\[([A-Z_]{3,24})\]\s` 时原文直存、跳过 LLM 抽取。导出时被剥掉的
   `[TYPE] ` 前缀在导入时补回，正好命中这条路径，回灌既不失真也不烧 token；
3. **`MOSCore.update` 对 `tree_text` 后端是 no-op**（只打警告），
   所以「编辑后原地更新」在现有 API 下走不通，必须降级为另存版本。

按页 `id` 比对，四种结果：

| 页状态 | 处理 |
|---|---|
| id 不在 cube 中 | `POST /memories` 写入，命中免 LLM 快速路径 |
| 内容一致 | 跳过，零 embedding 调用 |
| 内容被编辑 | 默认跳过并报告；`on_edit="version"` 另存新版本，旧记忆保留 |
| `status` 非 activated | 跳过，计入归档统计 |

### 幂等性

版本化路径有个陷阱：编辑后的页 front-matter 里仍是旧记忆 id，
若不记账，每次重复导入都会再版本化一次，记忆无限翻倍。

解法是 `docs/memory-wiki/.wiki-import-ledger.json`——页 id → 内容 SHA-256 的台账。
已版本化过的编辑内容再次导入时识别为「此前已版本化」并跳过。
台账写失败会在报告里显式告警（否则静默失败会导致下次翻倍）。
导出器的 `cleanGenerated()` 相应跳过点文件，台账不再被误报为「非生成文件」。

### 外来文件与畸形页的区分

解析失败分两类，混在一起会让报告失去意义：用户自己在 `pages/` 下放的笔记
（无 front-matter 或别的工具生成）属于正常情况，应当静默忽略；
而带导出标记但缺 `id`、类型非法、正文为空的页是真正的问题，必须报出来。

解析结果因此带类型化的 `foreign` 标志，而不是让 handler 去匹配错误消息文本——
消息措辞一改，分类就会静默失效。

### 安全边界

- 只读 `pages/` 下 front-matter 带 `generator: oh-memos-wiki-export` 的文件，
  外来 `.md` 计数忽略；**导入路径不删除任何文件**（删除仍归 `memos_delete`，默认关闭）。
- 类型正则 `^[A-Z][A-Z_]{2,23}$` 比服务端快速路径严一格，
  防止畸形类型静默退化成 LLM 抽取路径。
- 写入内容仍走 `start_api.py` 的凭据脱敏，与 `memos_save` 同一边界。
- `dry_run=true` 只出差异预览。

### 落地文件

| 文件 | 职责 |
|---|---|
| `mcp-server-node/src/wiki-import-format.ts` | 页解析，`renderPage()` 的逆运算；纯函数无 IO 以便测试 |
| `mcp-server-node/src/wiki-import-format.test.ts` | 13 用例：完整页/最小页/中文/转义 tag/缺 id/非法类型/空正文/无 front-matter/前缀往返恒等 |
| `mcp-server-node/src/handlers/wiki-import.ts` | 扫描、比对、回灌、台账、报告 |

解析器与 handler 分离的理由和 `canvas-format` / `canvas-store` 一致：
格式规则能被字节级单测锁住，文件 IO 和 HTTP 留在 handler。

### 遗留

- `tags`、`confidence`、`created` 与关联边不回灌——`POST /memories` 没有对应字段。
- 原地更新缺失，见 Phase 2。

### Phase 1a：写入 ID 与元数据闭环（已实现）

本次实现把 `POST /memories` 从只有 message 的写入接口升级为兼容的写入合同：

- `MemoryCreate` 接受并校验 `memory_type`、`tags`、`confidence`、`status`、`created_at`、`updated_at`、`source`、`session_id`、`source_ref`；旧请求字段不变；
- `MOSCore.add()` 返回 tree_text 已创建的长期记忆 ID 列表，旧调用方忽略返回值仍兼容；
- `POST /memories` 返回 `data.memory_ids` 与 `data.warnings`，旧 API 返回 `data=null` 时 Node 客户端按空 ID 兼容；
- typed fast path 透传 tags/confidence/status/source/timestamps，仍保持免 LLM 原文保存；
- Wiki 回灌把 front-matter 元数据发送到 API，并在 `.wiki-import-ledger.json` 保存内容 SHA-256、新 memory IDs 和导入时间；旧 ledger 的 `id -> hash` 格式仍可读取；
- 关系 wikilinks 暂不创建图边，因为当前 API 没有关系写入合同，仍在导入报告中保留。

迁移时不需要重建 cube。升级 API 后重新导出或重新导入即可获得新字段；旧版本 Node MCP
仍能调用新 API，只是忽略返回的 `data`。



`MOSCore.update` 需要在 `tree_text` 后端补齐实现（改写节点内容 + 重算 embedding +
保留 id 与既有边），Python 侧同时需要一个能接收 `tags` / `confidence` /
`created` 的写入路径。之后 `memos_import_wiki` 增加 `on_edit="update"`：
编辑页原地覆盖，不再产生版本堆积，台账也可以退化为纯校验用途。

工作量集中在 Python 记忆内核，属于独立一期。

## 已实现的后续最小闭环

### 自动捕获

`project-memory/hooks/node/oh_memos_auto_capture.js` 已接入 PreCompact，但默认关闭。
开启 `MEMOS_AUTO_CAPTURE=true` 后，hook 只读取有界 checkpoint 字段，不抓取每次工具输出，
以 `PROGRESS` + `auto-capture` tag + 低 confidence 写入既有 `/memories` API。
API 继续负责凭据脱敏；session/event/content hash marker 提供跨进程幂等；任何输入错误或 API
不可用都 fail-open，不阻断客户端。`MEMOS_MODE=lite` 强制关闭捕获。

### 检索质量层

底层已有 vector/BM25/full-text/graph 召回，本次在 Node MCP 结果层增加统一质量评分：
semantic relativity、confidence、freshness、status、PROGRESS 和 auto-capture 都参与排序。
结果标注 `quality_score`/`freshness`，跨 cube 合并排序；Lite 默认过滤 auto-capture，显式
搜索 session/auto-capture 时才放开。这样不会改变 Python API 的底层召回合同。

### Lite 运行策略

Lite 不是第二套 SQLite 存储：仓库已有 Qdrant local/embedded 能力，但引入第二套持久化会造成
数据分叉。本次 Lite 复用同一 API/cube，设置 `MEMOS_MODE=lite` 后限制搜索上限、降低上下文噪音、
关闭自动捕获。后续若需要真正离线/零依赖 Lite，应另立迁移协议和存储一致性设计。

### Skill 候选

`memos_distill_skill` 只在项目下写 `skill-candidates/*.md`，候选带来源 memory IDs、生成时间和
`status: candidate`，`memos_list_skill_candidates` 只读列出。没有自动安装入口，正式 skill 目录
不会被隐式修改。



现状完全依赖 agent 主动 `memos_save`，漏存即永久丢失——这是 oh-memos 相对
memsearch 最实质的短板。`project-memory/hooks/` 已有 `oh_memos_auto_save.js`
和 `oh_memos_pre_compact.js`，但两者只发建议消息、不落库。

方向是「自动捕获 + 显式精选」双层：钩子在 PreCompact 与会话结束时写入低置信度的
会话摘要（独立类型如 `SESSION`，或复用现有类型但标注来源），
精选记忆仍由 agent 显式保存。要解决的核心问题是噪音控制——
自动记忆若与精选记忆同权重进入检索，会拉低召回质量，
因此需要检索侧的分层与衰减策略，不能只是「多写一些」。

## Phase 4：本地零配置 embedding

memsearch 默认本地 ONNX bge-m3（约 558 MB，CPU，免 API key），
上手门槛比 oh-memos「必须先配 chat + embedding 凭据」低一个量级，
对试用转化影响明显。oh-memos 已有 Ollama 可选 profile，
但仍需用户自行拉模型、改配置。

可做的是提供一个「零凭据快速启动」路径：默认 embedding 走容器内置的本地模型，
chat 模型缺失时降级为不做 LLM 抽取（类型化保存本来就不需要 LLM）。
这样 `docker compose up` 之后无需任何 key 即可保存和检索类型化记忆，
配 key 只是解锁查询理解与关系抽取。

## 不打算做的

- **改为 Markdown 真相源**：要重写存储层，且会牺牲图推理能力。Phase 1 的往返
  已经拿到「可审阅、可修复」的主要价值。
- **三层渐进召回的第三层（回原始会话记录）**：oh-memos 不存原始会话，
  这层依赖 Phase 3 落地后才有意义。
- **Skills from Memory**：从重复出现的模式蒸馏 skill 是个好想法，
  与 `project-memory/` skill 生态契合（可做成 `memos_distill`），
  但收益依赖记忆库积累到一定规模，优先级低于上述四期。

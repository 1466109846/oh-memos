# Changelog

All notable changes to the MemOS project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.1.1] - 2026-08-22

仅 MCP server（npm `oh-memos-mcp`）。Python 包与容器镜像无改动，仍为 3.1.0。
<!-- en: MCP server only (npm `oh-memos-mcp`). Python package and container image unchanged at 3.1.0. -->

### 🐛 修复：`memos_context_resume` 每条记忆成对出现
<!-- en: 🐛 Fix: memos_context_resume showed every memory twice -->

3.1.0 装好后 `memos_search` 与 `memos_list_v2` 都已正确隐藏 `WorkingMemory` 短期副本，
但 `memos_context_resume` 仍成对显示（10 条 = 5 对，内容逐字相同、UUID 不同）。
<!-- en: After 3.1.0, memos_search and memos_list_v2 correctly hid WorkingMemory copies,
     but memos_context_resume still showed pairs (10 items = 5 pairs, identical content, different UUIDs). -->

**根因不止是漏接一条路径。** temporal 查询的 Cypher 不返回 `memory_type`，
构造出的 metadata 只有 `relativity`/`temporal_rank`/`source` —— 于是分层判定永远
读到 undefined 并判为可见，**下游任何过滤对 temporal 记忆都是空转**。
<!-- en: Root cause was deeper than one missed call site: the temporal Cypher never
     returned memory_type, so tier checks always read undefined and any downstream
     filter was a no-op for temporal memories. -->

受影响的是四个调用点，不只是 `memos_context_resume`：
<!-- en: Four call sites were affected, not just memos_context_resume: -->

| 路径 | 3.1.0 的状态 |
|---|---|
| `memos_context_resume` | 成对显示（用户实测发现） |
| `memos_search` temporal intent（两处） | 有过滤代码，但读不到字段 |
| `memos_think` | 同上 |

后三处一直漏着且不易察觉 —— 过滤代码存在且看起来合理，只是作用对象缺字段。
<!-- en: The latter three were silently affected: the filter code exists and looks
     correct; the objects it filtered simply lacked the field. -->

修法：在 Cypher 里排除 `WorkingMemory` 并返回 `memory_type`。这是唯一对四处
都成立的做法，且 `LIMIT` 在过滤之后 —— 要 N 条就得 N 条真记忆，无需超额取数。
`memos_context_resume` 的 API 回退路径由服务端施加 limit，无法先过滤，故超额取 3 倍。
<!-- en: Fix: exclude WorkingMemory in the Cypher and return memory_type. This is the
     only fix that covers all four sites, and LIMIT applies after the filter — N rows
     means N real memories. The API fallback path over-fetches 3× since its limit is
     server-side. -->

逃生开关 `MEMOS_SHOW_WORKING_MEMORY=true` 仍然有效：为真时不加排除条件，
但仍返回 `memory_type` —— 开关只关过滤，不关可观测性。
<!-- en: The MEMOS_SHOW_WORKING_MEMORY=true escape hatch still works: it drops the
     exclusion but still returns memory_type — the switch gates filtering, not visibility. -->

### 🧪 测试
<!-- en: 🧪 Tests -->

新增 `src/context-resume.test.ts`（22 项），**9 个变异全部被捕获**，
其中 W1「API 路径不过滤」即回到本次报告的原缺陷。
<!-- en: New src/context-resume.test.ts (22 cases); all 9 mutations caught, including
     W1 "API path does not filter" which reproduces the reported defect. -->

新增 `npm run test:host-env-smoke`：用 MCP host 配置里的**原样环境**驱动 server，
且不继承外层环境变量。已有的 spread smoke 自带硬编码 Neo4j 凭据兜底，
因此「host 读不到凭据」这一失败形态它测不出来 —— 实测该形态下检索照常返回记忆、
但联想标注为 0，属静默降级。
<!-- en: New npm run test:host-env-smoke drives the server with the MCP host's verbatim
     env and does not inherit the outer environment. The existing spread smoke supplies
     hardcoded Neo4j credentials, so it cannot detect "the host cannot read credentials" —
     a silent degradation where retrieval still returns memories but spreading is absent. -->

门禁：vitest 416/416、tsc、pack 契约、schema budget +0.0%、semantic 快照 17 工具、
protocol v2、lite smoke、spread smoke、host-env smoke。
<!-- en: Gates: vitest 416/416, tsc, pack contract, schema budget +0.0%, semantic
     snapshot 17 tools, protocol v2, lite smoke, spread smoke, host-env smoke. -->

## [3.1.0] - 2026-08-22

### 🧠 检索排序：衰减、强化、分档去重与图扩散联想
<!-- en: 🧠 Retrieval ranking: decay, reinforcement, tiered dedupe, spreading activation -->

本轮源自一次「LLM agent 能否像人脑那样记忆」的文献调研与随后的实现审计。结论不是
「该换成全息架构」——全息叠加的容量与干扰是硬约束（arXiv 2606.24948），且**做不到
删除单条记忆**——而是把 localist 路线该有的机制补全。设计文档
`docs/design/memory-retrieval-optimization.md`（831 行，含全部实测数据与修正记录）。

#### 衰减与强化

旧的 `freshness` 是 `max(0.55, 1 - age/3650)`：**十年才掉 45% 且永不归零**，
一年的时间差在总分里只值 0.0027，实际等于不衰减。实测后果是 400 天的 PROGRESS
压过全新的 GOTCHA。

改为按 `memory_type` 分档的指数衰减 `0.5^(age/halfLife)`：PROGRESS 14 天、
CONFIG 180、BUGFIX·ERROR_PATTERN 365、FEATURE·MILESTONE 540、
DECISION·GOTCHA·CODE_PATTERN·SYNTHESIS 1095，floor 从 0.55 降到 0.05。

新增访问强化（ACT-R base-level activation 的简化形式）：有效年龄取
`min(距上次更新, 距上次访问)`，强化项对数饱和、20 次达满。写入方是**本地侧车日志**
`<cube>/access-log.jsonl`——不碰记忆存储，Full/Lite 行为一致，只追加不与
`withLock` 交互。**只在 `memos_get` 记账、不在 search 记账**：否则形成
「高分→更常返回→更多计数→分数更高」的正反馈，新记忆永远追不上。

权重：semantic .50 / confidence .15 / freshness .14 / reinforcement .06 /
三个惩罚各 .05，和为 1.0。**惩罚项刻意不动**——它们编码产品策略
（auto-capture 不可信、archived 已退役），不应因新增信号被稀释。

#### 近重复折叠（按类型分档）

原有去重只在 Python 侧按 `memory` 文本**精确匹配**，措辞略异的同义记忆全部返回、
挤占 top_k。新增字符 4-gram Jaccard 折叠，在 node 层 quality policy 内做，
一次覆盖全部检索路径。

**用字符 n-gram 而非分词是 CJK 的关键**：中文没有词边界，按空格分词会退化成
「整段一个 token」，Jaccard 恒为 0 或 1。

阈值按类型分档：PROGRESS 0.70（进度汇报本就重复）、MILESTONE·FEATURE 0.78、
BUGFIX·ERROR_PATTERN·CONFIG 0.82、DECISION·GOTCHA·CODE_PATTERN·SYNTHESIS 0.88
（原理性内容差一个字可能差很多）。不跨 `memory_type` 折叠；被折叠 id 记入
`duplicates_folded`，信息不丢。

#### 一跳图扩散联想（`MEMOS_SPREAD_ACTIVATION`，默认关闭）

命中后沿 `CAUSE`/`CONDITION`/`RELATE` 边扩散一跳，把强关联记忆并入候选集。
这是 localist 存储实现「联想」的方式——避开叠加容量瓶颈，同时保留逐条删除能力。

实现前量过五项（jincaizhaopin_cube，6534 节点 / 9133 条 typed 边）：边覆盖 98.4%、
一跳候选中位 10 / p90 33、跨业务类型边 28%、**邻居专属率 72%**、最强 hub 仅被
61/3039 源共享。随机抽 6 个 fact 邻居集**完全零重叠**——否决了实现前的 hub 稀释担忧。

上界 12（覆盖中位到 p90 之间）、边类型优先级 `CAUSE` > `CONDITION` > `RELATE`、
同类型内按度数升序（低度数更专属）。扩散节点带 `spread_via` / `spread_from` 标记，
不参与二次扩散。仅 Full 模式（Lite 无图）。

**「联想绝不压过直接命中」在排序层强制，而非靠压低 relativity。** 后者做不到：
`quality_score` 是六项加权和，联想节点 `updated_at` 来自邻居、可能是今天，
freshness 拿满分就能反超陈旧命中（实测 0.8400 > 0.7030）。修法是排序时先按
「是否扩散」分层、组内再按分数。

#### 记忆层级：`WorkingMemory` 默认隐藏

API 每条记忆写**两个节点**：`LongTermMemory` 图节点 + 内容逐字相同的
`WorkingMemory` 短期副本（scheduler FIFO 淘汰）。两者都必需，但同时呈现会让
`memos_list_v2` 看起来每条记忆出现两次。

检索与 list 路径现在隐藏 `WorkingMemory`（`MEMOS_SHOW_WORKING_MEMORY=true` 可开）。
**这是分层泄漏而非双写**——按「去重」去修会删掉短期记忆整层。
`handlers/wiki-export.ts` 早已做同样过滤，本次只是铺到 search 与 list。

缺 `memory_type` 视为可见（Lite 不写该字段，误判会清空整个 cube）；
全是 `WorkingMemory` 时原样返回而非返回空。

#### 检索期注解

quality policy 算出的信号此前**算完就丢**——`duplicates_folded` 写了却无人读，
文档声称的「可用 `memos_get` 展开」是假的。现在 ID 行按需附加：
`access_count N` / `stale` / `expired` / `folded N: ids` / `via CAUSE from xxx`。
干净且未被读过的记忆无任何附加。compact 模式（>15 条时）同样带出——
它走 `toMinimal`，而那里原本丢掉整个 metadata。

#### graph schema 四处缺陷修复

`memos_graph(mode="schema")` 报 `Avg Connections 0.00 / Max 0 / Orphan 0`，
而同一 cube 实测 25781 条边、6430 个带边节点；健康评估同时输出「连接良好」与
「平均连接过低」，自相矛盾。

- `avg_connections` / `max_connections` / `orphan_nodes` / `memory_types` /
  `time_range` 从初始化的 0 起**从未被赋值**——不是算错，是根本没算；
- 查询是裸 `MATCH (n:Memory)`，**不按 cube 过滤** → 返回全库合计
  （某 cube 6534 节点却报 7878）；
- `/product/graph/schema` 调用不存在的 `handle_get_graph_schema`，**恒返回 500**；
- `start_api.py` 与 `graph_handler.py` 各有一份逐行重复的实现，两份**各自**漏掉
  同样的东西——已收敛为 handler 层一份（110 行 → 10 行委托）。

MCP 侧另有**五个字段名读错**（`avg_connections_per_node` 等），读不到就 `?? 0`
静默兜零；`total_nodes` / `max_connections` 恰好同名，**部分正确正是它难被发现的
原因**。修复后实测 6534 / 6.83 / 151 / 104，与真值吻合，健康评估改为
「连接良好 + 关系丰富」。

#### 新增配置

| 变量 | 默认 | 说明 |
|------|------|------|
| `MEMOS_SPREAD_ACTIVATION` | `false` | 一跳图扩散联想（仅 Full 模式） |
| `MEMOS_SHOW_WORKING_MEMORY` | `false` | 显示 scheduler 管理的短期层（调试用） |

新增 `docker/docker-compose.dev.yml`：把 `src/` 以 `:ro` 挂进容器，
改 Python 只需 `restart` 而非 rebuild。放 override 而非主 compose——
生产从 GHCR 拉镜像时挂宿主源码是错的。

#### 测试

新增 `memory-quality-baseline.test.ts`（60）、`access-tracker.test.ts`（19）、
`memory-tier.test.ts`（18）、`spreading-activation.test.ts`（40）、
`formatters.test.ts`（16）、`schema-report.test.ts`（15）、
`list-memories.test.ts`（8）、`tests/test_graph_schema_stats.py`（18）。
新增 `scripts/spread-smoke-test.mjs`（8 项，打真实 Neo4j）。

全量 **vitest 394 / pytest 98**，每一处逻辑都做过变异验证——含「回到原缺陷状态」
形态的变异，确认守卫真的守住了修掉的 bug。


### 🔁 新增 `memos_import_wiki`：Markdown Wiki 往返回灌
<!-- en: 🔁 New `memos_import_wiki`: round-trip Markdown wiki back into memory -->

此前 `memos_export_wiki` 是单向的——导出的 Markdown 只能读，人工修正无法回到记忆库，
记忆一旦写错就只能删除重写。本次补上反方向，导出目录成为可编辑、可 review、可回灌的镜像。

#### 新增文件

| 文件 | 说明 |
|------|------|
| `mcp-server-node/src/wiki-import-format.ts` | Wiki 页解析器，导出格式 `renderPage()` 的逆运算：front-matter 字段、H1 标题、正文、`## 关联` 段落分离；纯函数无 IO |
| `mcp-server-node/src/wiki-import-format.test.ts` | 15 个用例，覆盖完整页/最小页/中文/转义 tag/缺 id/非法类型/空正文/无 front-matter、外来文件与畸形页的分类，以及 `[TYPE]` 前缀往返恒等性 |
| `mcp-server-node/src/handlers/wiki-import.ts` | `memos_import_wiki` 处理器：扫描 `pages/`、逐页与 cube 比对、按策略回灌、生成统计报告 |

#### 回灌语义

按页 front-matter 里的 `id` 与 cube 比对，四种结果：

- **id 不存在** → 以 `[TYPE] 内容` 写入 `POST /memories`，命中 `core.py` 的 `MOS_TYPED_SAVE_FAST`
  快速路径，原文直存、不触发 LLM 抽取；
- **内容一致** → 跳过，不产生 embedding 调用（基于 id 的持久去重，区别于 `memos_save` 的 60 秒内存去重）；
- **内容被编辑** → 默认跳过并报告；`on_edit="version"` 时另存为新版本，旧记忆保留；
- **`status` 非 activated** → 跳过并计入归档统计。

`dry_run=true` 只输出差异预览，不写任何东西。

#### 安全与幂等

- 只读取 `pages/` 下 front-matter 带 `generator: oh-memos-wiki-export` 标记的文件；
  外来 `.md` 计数忽略，**任何情况下都不删除文件**。
- 已版本化的页记入 `docs/memory-wiki/.wiki-import-ledger.json`（页 id → 内容 SHA-256），
  避免重复导入把同一次编辑反复版本化；台账写失败会在报告中显式告警。
- 类型必须匹配 `^[A-Z][A-Z_]{2,23}$`，比服务端快速路径的正则严一格，
  防止畸形类型退化成 LLM 抽取路径。
- 解析结果带类型化的 `foreign` 标志，把「用户自己的笔记」（静默忽略）与
  「带导出标记但畸形的页」（报出明细）分开，不靠匹配错误消息文本判断归属。
- 写入内容仍走 `start_api.py` 的凭据脱敏，与 `memos_save` 同一边界。

#### 已知限制

- `tree_text` 后端不支持原地更新（`MOSCore.update` 对该后端只打警告不执行），
  因此编辑页只能另存版本，无法覆盖原记忆。原地更新需先在 Python 侧补齐更新路径。
- `tags`、`confidence`、`created` 与关联边不回灌，当前 `POST /memories` 没有对应字段。

#### 配套改动

- `wiki-export.ts`：`cleanGenerated()` 跳过点文件（台账不再被报为「非生成文件」）；
  `index.md` 的「只读镜像」提示改为往返说明。
- `schema-baseline.json` 重新冻结：12 → 13 个工具，14820 B（≈4631 tokens）。
- 设计方案与后续分期见 `docs/plans/2026-08-16-wiki-round-trip-and-memsearch-gap.md`。

### 🧭 架构感知图谱与 Graphify 适配层
<!-- en: 🧭 Architecture-aware graph and Graphify adapter layer -->

- 新增统一 provenance 合同：`EXTRACTED / INFERRED / AMBIGUOUS / UNKNOWN`、置信度、证据引用、源码文件和位置。
- `memos_graph` 的 related/path/impact 输出现在解释关系或节点证据；新增 `mode="import"`，严格校验 Graphify node-link JSON 并生成无写入 dry-run 计划。
- 新增稳定代码节点 ID、重复节点/悬空边/危险路径/超限输入检查；代码结构图与长期记忆图保持独立命名空间。
- README、中文 README、架构说明和本 Changelog 使用同一份受测试保护的分层拓扑：

<!-- architecture-aware-memory:start -->
```mermaid
flowchart LR
    CLIENT["AI Clients<br/>Claude · Codex · DSH"]
    MCP["Node MCP Server<br/>memos_* · stdio"]

    subgraph CODE_LAYER["Code structure layer / 代码结构层"]
        REPO["Source Repository<br/>code · docs · git diff"]
        ADAPTER["Graphify Adapter<br/>validate · stable ID · dry-run"]
        CODE_GRAPH[("Code Graph<br/>FILE · SYMBOL · CALLS")]
    end

    subgraph MEMORY_LAYER["Project memory layer / 项目记忆层"]
        API["FastAPI<br/>HTTP JSON · :18000"]
        CORE["MOS / MOSCore<br/>project Cube orchestration"]
        QDRANT[("Qdrant<br/>semantic memory")]
        MEMORY_GRAPH[("Neo4j Memory Graph<br/>DECISION · BUGFIX · CAUSE")]
        FILES[("Cube Files<br/>config · Canvas · Wiki")]
    end

    CLIENT -->|"MCP / stdio"| MCP
    MCP -->|"HTTP / JSON"| API
    API -->|"memory operations"| CORE
    CORE -->|"embedding + recall"| QDRANT
    CORE -->|"typed relations"| MEMORY_GRAPH
    CORE -->|"durable state"| FILES

    REPO -. "Graphify graph.json" .-> ADAPTER
    MCP -. "memos_graph import" .-> ADAPTER
    ADAPTER -->|"validated symbols"| CODE_GRAPH
    CODE_GRAPH -->|"RELATED_TO + provenance"| MEMORY_GRAPH
```
<!-- architecture-aware-memory:end -->

### 🧠 自动捕获、检索质量层、Lite 策略与 Skill 候选
<!-- en: 🧠 Auto-capture, retrieval quality layer, Lite policy, and skill candidates -->

- 新增默认关闭的 `oh_memos_auto_capture.js`：PreCompact 有界 checkpoint、低置信度、服务端脱敏、失败开放、session/event 哈希去重；`MEMOS_MODE=lite` 强制关闭。
- 搜索保留现有向量/BM25/全文/图谱召回，在 MCP 结果层增加 freshness、confidence、source 和 lifecycle 质量评分；自动捕获降权，Lite 默认过滤，跨 cube 统一排序。
- `MEMOS_MODE=full|lite` 作为运行策略加入 Node MCP：Lite 不分叉存储，不改变现有 cube，只限制检索上限并减少噪音。
- 新增 `memos_distill_skill` / `memos_list_skill_candidates`：候选只写入项目 `skill-candidates/`，带来源 memory IDs，必须人工 review，不自动安装。
- Wiki parser 归一化 Windows CRLF，并拒绝未知 lifecycle status。

### 🧾 写入 ID 与元数据闭环
<!-- en: 🧾 Write-back contract: created IDs and metadata round-trip -->

- `POST /memories` 现在返回 `data.memory_ids` 与 `data.warnings`，旧客户端可继续忽略新增 data。
- 写入请求支持并校验 `memory_type`、`tags`、`confidence`、`status`、`created_at`、`updated_at`、`source`、`session_id` 和 `source_ref`。
- `MOSCore.add()` 汇总 tree_text 已创建的长期记忆 ID；typed fast path 继续免 LLM，并透传 Wiki 元数据。
- Wiki ledger 保存内容哈希、导入时间和新 ID；旧 ledger 格式仍可读取。

### 🛡️ 一致性与部署硬化
<!-- en: 🛡️ Consistency and deployment hardening -->

- `POST /memories` 详细结果现在包含 `created_ids`、`queued`、`backend`、`warnings`；非 tree 或无法确认 ID 时明确报告 `ids_unavailable`，async 不再伪装成已持久化。
- Wiki 回灌增加 duplicate ID 预检、损坏 ledger 拒绝、跨进程锁、原子 ledger 替换、递归总量上限和 uncertain write 保护，并传播 API warnings。
- 自动捕获支持 `PreCompact`、`Stop`、`SessionEnd`，过滤未知事件和 Stop 重入，解析 API JSON envelope 后才创建去重 marker；canonical/deploy hooks 与 settings 同步。
- Skill 候选改为原子创建，拒绝覆盖已有候选和 symlink，列表只显示合法 generator/status 文件。

### ✅ 审核生命周期与能力边界硬化
<!-- en: ✅ Review lifecycle and capability-boundary hardening -->

- Skill 候选现在支持显式 approve/reject/install 状态机；安装仅写项目 `.claude/skills/<slug>/SKILL.md`，拒绝覆盖、symlink 和未审批候选。
- tree_text update 对外显式失败（`TREE_TEXT_UPDATE_UNSUPPORTED`），避免静默成功；待 ID-preserving 图/向量事务合同后再实现。
- 自动发现的 `.env` 不再覆盖继承环境变量；`MEMOS_ENV_FILE` 显式指定的文件仍为权威配置源。

### 🗂️ True Lite provider
<!-- en: 🗂️ True Lite provider -->

- `MEMOS_PROVIDER=local` 或 `MEMOS_MODE=lite` 现在可在没有 Python API 的情况下运行 Node JSONL provider。
- 每个 cube 写入 `memories.jsonl` 与 `manifest.json`，支持 fsync append、跨进程锁、typed metadata、get/list/recent 和确定性词法 search。
- Lite 下 graph/think/wiki/admin/delete 返回 `LOCAL_PROVIDER_UNSUPPORTED`，不冒充有图谱后端；迁移边界是导出的 Wiki Markdown，不读取 Python cube 内部。

### 🔗 Wiki 关系边回灌
<!-- en: 🔗 Wiki relation edges written back to the graph -->

- Wiki `## 关联` wikilinks 现在在导入时写入 Neo4j 图谱边，不再仅作报告。
- 新增 `POST /product/graph/relation`（Python API）与纯函数 wiki-relations（Node），支持 `CAUSE`、`CONDITION`、`RELATE`、`CONFLICT`、`FOLLOWS`、`PARENT`。
- 关系类型在 Pydantic `Literal`、MOSCore `ALLOWED_RELATION_TYPES` 和 Neo4j 驱动层三处校验，防止 Cypher 注入（类型直接插值进 MERGE 语句）。
- 写入前校验两端 memory 存在于同一 cube/user，拒绝自环；未解析/失败的 wikilinks 显示到导入报告。
- 边标签统一在 `wiki-relations.ts EDGE_LABELS`，export 和 import 共用，避免标签漂移。

### 🧠 Lite 本地语义检索
<!-- en: 🧠 Local semantic retrieval for Lite -->

- Lite provider 支持可选语义排序：本地 Ollama `/api/embeddings` 提供 embedding，无新增 npm 依赖。
- embedding 随 JSONL 记录持久化，但永不离开 provider（get/list/search 返回前剥离）；写入时 embedding 失败不阻塞保存。
- 检索为混合排序：语义余弦（截断到 [0,1]）0.6 + 词法 0.4；维度不匹配的存量记录按词法参与；Ollama 不可用时自动回退纯词法。
- 配置：`MEMOS_LITE_EMBED_URL`（默认 `http://127.0.0.1:11434`）、`MEMOS_LITE_EMBED_MODEL`（默认 `bge-m3`）、`MEMOS_LITE_EMBED=off` 显式关闭。

## [3.0.1] - 2026-08-19

### 🩹 修复 3.0.0 打包出的多余依赖与失效仓库链接

3.0.0 的 npm 包声明了两个与运行时无关的依赖，并且 npm 页面上的仓库链接全部指向一个不存在的仓库。
功能没有受影响，但每个用户都要多下载约 17 MB，且 issue/homepage 链接是死链。

#### 修复

- **移除 `ci@^2.3.0` 与 `npm@^11.19.0`**。两者都不被 `dist/` 里的任何代码 import，属纯安装期膨胀：
  `npm` 是完整的 npm CLI（16 MB），`ci` 是无关的第三方工具（17 KB）。安装体积从约 30 MB 回到约 13 MB。
  根因是发布前工作区里未提交的依赖漂移被打进了 tarball；仓库提交本身一直只有三个依赖。
- **`repository` / `bugs` / `homepage` 从 `github.com/xigou/oh-memos` 改为 `github.com/lsg1103275794/oh-memos`**。
  前者返回 404，导致 npm 页面上的仓库、issue 和主页链接全部失效。`mcp-server-node/README.md`
  里的 clone 命令与仓库链接同步修正。

#### 不变

运行时行为、工具名、输入 schema、协议协商和持久化格式与 3.0.0 完全一致，仅包元数据与依赖清单变化。
从 3.0.0 升级只需重新安装，无需任何迁移。

## [3.0.0] - 2026-08-19

### 💥 BREAKING — Node MCP 升级到 SDK v2 与双时代协议，运行时最低 Node.js 20

本次发布把此前分叉的版本号统一：npm `oh-memos-mcp`、`pyproject.toml` / `src/oh_memos/__init__.py`、
GHCR 镜像 tag 与 git tag 从本版起同为 `3.0.0`。
（注意：本文件早期的 `[3.0.0] - 2026-08-02` 属于旧的「仅文档」编号线，与本条不是同一次发布。）

#### 破坏性变更

- **Node.js 20 是新的最低运行时**。仍在 Node 18 的用户请固定 `npx -y oh-memos-mcp@2`，升级运行时后再切回 `latest`。入口在动态加载 SDK/config 之前先检查 Node 主版本，以退出码 1 输出可执行的升级提示，而不是抛出难以定位的模块错误。
- MCP 运行时从单体 `@modelcontextprotocol/sdk` v1 + Zod 3 换为角色拆分的 `@modelcontextprotocol/server@2` + Zod 4。

#### 新增

- **同一个 stdio 包同时服务两个协议时代**：通过 `serveStdio(..., { legacy: "serve" })`，既接受 legacy 2025-era 的 initialize 客户端，也接受固定到 MCP `2026-07-28` 的客户端。
- 字符串化的 `tools/call` arguments 在时代分类和 schema 校验之前归一化，保留既有客户端兼容路径。
- 发布门禁扩展为协议、生命周期、语义 schema 与包边界四类，覆盖 legacy/auto/modern 客户端、Full 与 Lite provider、16/17 工具面、大请求、probe 回退和进程优雅关闭。

#### 迁移与兼容

- **不需要数据迁移**。记忆、cube 与 Lite JSONL 的格式、工具名和输入 schema 全部不变，Agent 配置只需把包引用改成 `npx -y oh-memos-mcp`（或固定 `oh-memos-mcp@3.0.0`）。
- 仍协商 2025-era 的客户端无需任何改动即可继续工作；采用 3.0 不要求客户端先迁移协议。
- `2.x` 仍可从 npm 安装，本次发布不 unpublish、不 deprecate。

#### 回滚

- 把 Agent 配置固定回 `npx -y oh-memos-mcp@2.1.0` 即可；持久化格式未变，无需回滚数据。
- 镜像可回退到 `ghcr.io/lsg1103275794/oh-memos:2.1.0`。

## [3.2.0] - 2026-08-15

### 🐳 Docker 化、GHCR 镜像发布与 Windows→Docker 全量数据迁移

#### 运行架构变更

oh-memos 的**生产部署方式从 Windows 进程切换为 Docker 容器**。迁移前后功能完全等同，所有第三方接入（MCP server、API 调用）继续使用 `localhost:18000`，无需改动。

Windows 进程部署方式**保留**，但定位调整为开发/调试备用，不再是推荐的运行方式。详见 `README_CN.md` 中的「Windows 侧部署」章节。

---

#### 🆕 新增文件

**Docker 镜像**

| 文件 | 说明 |
|------|------|
| `docker/Dockerfile` | 生产 CPU 镜像，基于 `python:3.11-slim-bookworm`，正确入口 `oh_memos.api.start_api:app:18000`，非 root uid 10001，read-only 根文件系统 |
| `docker/requirements.txt` | API + tree_text + Qdrant 运行依赖；torch 从 PyTorch CPU index 单独安装，避免 PyPI 拉入 CUDA wheel |
| `docker/entrypoint.sh` | 首次启动时仅当 dev_cube 缺失时创建，绝不覆盖已有 cube；cube 名白名单校验（只允许 `[A-Za-z0-9_-]`，防止 sed 渲染被 `&` 等字符破坏） |
| `docker/dev_cube.config.template` | 无凭证 seed 模板，仅含 placeholder；`apply_env_overrides()` 在加载时以环境变量覆盖 |

**Compose 与配置**

| 文件 | 说明 |
|------|------|
| `docker/docker-compose.yml` | 生产栈：API + Neo4j 5.26.4 + Qdrant v1.16.3，真实健康检查，端口默认绑定 `127.0.0.1` |
| `docker/docker-compose.host-db.yml` | 叠加覆盖：让容器 API 直连 Windows 宿主 Neo4j/Qdrant，迁移过渡期使用 |
| `docker/docker-compose.migration.yml` | 迁移专用覆盖：Neo4j 固定同版本（5.15.0→已升级至 5.26.4），防止迁移与 store 升级同时发生 |
| `docker/.env.docker.example` | 标准部署配置模板 |
| `docker/.env.host-db.example` | 宿主数据库直连模式配置模板 |
| `docker/.env.migration.example` | 迁移专用配置模板 |

**GHCR 发布**

| 文件 | 说明 |
|------|------|
| `.github/workflows/docker-publish.yml` | 公开镜像发布到 `ghcr.io/lsg1103275794/oh-memos`，PR 只构建，`main` push 发 `edge`，`v*.*.*` tag 发完整 semver + `latest`，含 SBOM/provenance，8 个 Action SHA 固定验证 |
| `.dockerignore` | 排除 `.env`、`data/`、`.venv`、`src/bin`、`node_modules` 等；`COPY src ./src` 曾把 1.9 GB src/bin 带进构建上下文，已改为 `COPY src/oh_memos ./src/oh_memos` |

**迁移工具**

| 文件 | 说明 |
|------|------|
| `scripts/migrate/migrate_win_to_docker.ps1` | 分阶段迁移编排：`preflight` / `backup` / `restore` / `verify` / `cleanup`，默认不删数据，`cleanup` 需 `-ConfirmWindowsPurge` |
| `scripts/migrate/build_migration_env.ps1` | 从 `src/.env` 自动生成 `docker/.env.migration`，`localhost:XXXX` 自动改为 `host.docker.internal:XXXX` |
| `scripts/migrate/verify_migration.ps1` | 迁移验证：对账 Neo4j 节点/关系数、Qdrant collection 列表、SQLite 用户/cube/关联数 |
| `scripts/local/start_api_no_bg.bat` | Windows 侧双运行时安全启动脚本：禁用后台归档/重组任务，让 `POST /archive/run` 返回 409，防止双侧并发写入 |

---

#### 🔧 修改

**功能修复**

- `docker/docker-compose.yml` Qdrant 版本 `v1.15.3` → `v1.16.3`（与 Windows 源版本一致；Qdrant 不保证旧版本能打开新版本 storage）
- `src/oh_memos/api/start_api.py` 新增 `MEMOS_DISABLE_BACKGROUND_WRITERS` 开关：在 `load_dotenv(override=True)` 之后强制置 `MEMOS_AUTO_ARCHIVE=false` 和 `MOS_ENABLE_REORGANIZE=false`，解决 `src/.env` 会覆盖 bat 里 `set` 命令的问题

**安全**

- 修复 Neo4j healthcheck 把密码插值进 shell 命令的问题（特殊字符密码会破坏命令边界）：改为通过 `$$OH_MEMOS_HC_PASSWORD` 延迟到容器 shell 展开
- `.env.docker.example` 的 `NEO4J_PASSWORD` 改为留空（原来的占位值是可直接运行的已知弱密码）
- workflow `if: always() && needs.version-check.result != 'failure'` 改为只允许 `success/skipped`，防止 cancelled/超时时仍发布
- CPU torch 检查从 `torch.cuda.is_available()`（无 GPU runner 上 CUDA wheel 也返回 False）改为 `torch.version.cuda is None`

**文档**

- `README_CN.md` 新增「Docker 部署（推荐）」章节：标准启动、host-db 模式、迁移期直连、端口冲突排查
- `README_CN.md` 保留「Windows 侧部署」章节，注明需自行配置 `.env`

---

#### 📦 数据迁移记录（2026-08-15）

从 Windows 进程迁移至 Docker 容器，迁移结果（verify 两次通过）：

| 数据 | 量 | 方法 |
|------|----|------|
| Neo4j 图谱 | 7708 节点 / 25781 关系 | `neo4j-admin database dump/load`（5.15.0 → 5.15.0 同版本，再升级至 5.26.4） |
| Qdrant 向量 | 17 collection / 9517 向量点 | 离线 storage 目录复制（1.16.3 → 1.16.3） |
| SQLite 注册表 | 3 用户 / 69 cube / 82 关联 | 文件复制至 runtime volume 的 `/data/runtime/.memos/memos_users.db` |
| cube/canvas | 19 文件 | 文件复制，路径回归原有 `data/oh-memos_cubes/` |

Windows 源数据已永久删除，备份保留在 `D:\oh-memos-migration\`。

---



### ✨ 新增 `memos_canvas` —— 符号化短期任务记忆

此前所有记忆都是**跨会话**的长期事实，会话**内部**的任务状态无人管：上下文一压缩，「我做到哪一步了」就只能靠翻历史重建。`memos_canvas` 补的是这一层。

一个画布是一个 Mermaid 文件（`{cube}/canvas/{NNN}-{slug}.mmd`），节点带可 grep 的 id（`000-N1`）和一个指向证据的 `ref`：

| ref 形式 | 指向 | 打开方式 |
|---------|------|---------|
| `mem:<memory_id>` | Neo4j 图谱里的一条记忆 | `memos_get(memory_id=...)` |
| `file:<path>` | 任意文件（含 harness 卸载的大工具结果） | Read |
| `note:<text>` | 内联短说明 | — |

`memos_canvas(action=open/update/show/list)`。`memos_context_resume` 现在会先列出**未完成**的画布（仅标题+计数，几十 token），压缩后第一眼看到的是待办任务而非记忆流水。

**灵感来自 [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) 的「符号化记忆」，但刻意没有照搬**，因为两个实测约束让照搬无从下手：

1. **Claude Code 的 PostToolUse hook 不能改写工具输出** —— 只能追加 `additionalContext`。腾讯的 −61% token 依赖 OpenClaw 的 `after-tool-call` patch 拦截并替换工具结果；官方 hooks 文档确认 PreToolUse 有 `updatedInput` 可改写**输入**，PostToolUse 无任何改写**输出**的字段。
2. **harness 本身已在做卸载** —— 超阈值的工具结果自动落盘 `<session>/tool-results/*.json` 并只返回路径。

**所以本功能不承诺 token 节省**，那个数字复制不了。它承诺的是跨压缩的任务状态存续，以及从摘要回到证据的可追证路径。

三个设计决策（均有测试钉住）：

- **node_id 与 canvas prefix 只 max+1，绝不填补空洞** —— 删掉的 `000-N2` 可能仍被 commit message、记忆正文或另一个节点的 ref 引用，复用该 id 会静默重指向所有这些引用。id 很便宜，花掉而不回收。
- **`ref` 必须带 scheme** —— 这是相对腾讯设计的改进：他们的 `result_ref` 只能指向本地 `refs/*.md`，我们的 `mem:` 能指进知识图谱（他们没有这一层）。不校验存在性（`mem:` id 在图里不在盘上，`file:` 可能下一刻才写）。
- **`parseCanvas` 永不抛异常** —— 画布是在「模型刚丢失上下文」这一刻被读取的，那是最不该收到异常的时刻。损坏的 header 只丢 goal，损坏的行只丢那一行。

**画布不进 Neo4j/Qdrant**：它一小时内改数次，为一次 `doing→done` 付 embedding 往返不合理。长期事实仍走 `memos_save`，画布用 `mem:` 指过去。

安全：`canvasPath` 是唯一把调用方文本变成文件路径的地方，用**白名单** `[a-z0-9-]` 而非危险字符黑名单（黑名单总会漏一个）。`.` 不在白名单内，故 `..` 结构上无法存活——遍历是不可能而非「被检查到」；之外还有 resolve 后的 containment 二次校验。`cube_id` 同样视为不可信输入（它由调用方给的 `project_path` 推导）。

### 🧪 首次引入测试基础设施

`mcp-server-node` 此前**零测试**（无 test script、无 `*.test.ts`）。新增 vitest 3.2.4 + `vitest.config.ts` + `npm test`，本轮 65 个单测覆盖 parse/render 往返、node_id 分配、Mermaid 注入转义、路径遍历拒绝、原子写。

`tsconfig.json` 加 `exclude: src/**/*.test.ts` —— 否则测试文件会编入 `dist` 并被 `npm publish` 一起发出去。

另有 `scripts/canvas-e2e.mjs`：18 项检查跑在**真实 MCP stdio** 上（含遍历拒绝、schemeless ref 拒绝、`node_id` 就地编辑不产生新 id、文件确实落盘为 Mermaid），而非 mock。

### 🐛 图谱时间字段序列化（双向）

- **`_parse_node()` 只转换 `created_at` / `updated_at` 两个字段**（`030bc42`）。任何后加的时间属性仍是驱动对象，出站时炸在序列化：`400 Unable to serialize unknown type: <class 'neo4j.time.DateTime'>`。`archived_at` 正是这样一个字段——**任何含已归档记忆的 cube，`GET /memories` 一律 400**（测试 cube 中 6392 节点里有 7 个），而同数据上 `POST /search` 正常，因为它不走这条路径。状态码来自全局 ValueError handler，日志里没有任何一行指向序列化。改为**按能力判断**而非名字白名单，新增时间字段无法再复现此问题；三个后端（neo4j、neo4j_community、polardb）同时修复——`neo4j_community` 是文档默认后端，带有完全相同的潜在 bug。
- **`update_node()` 的写入方向同病**（`a09c6c9`）：只有 `created_at` / `updated_at` 被包进 Cypher 的 `datetime()`，其他时间字段以纯字符串落库，对 datetime 范围比较完全不可见。改为按 `_at` 后缀判断。**既有数据未受影响**——`archived_at` 由 `archiver.py` 经 Cypher 端 `datetime()` 写入，从不走 `update_node`，故 32 个已归档节点本就是原生 DateTime；此修复关闭潜在路径而非修补存量行。

### 🐛 PPR 种子查询未按图投影过滤

`search_by_ppr()` 用 scope/status/user_name 构建节点过滤器投影内存图，却用裸 `MATCH (n:Memory) WHERE n.id IN $seed_ids` 解析种子 id（`1a53d01`）。任何落在过滤器之外的种子——不同 `memory_type`、非 activated 节点、共享库多租户下别的 cube 命名空间——都不在投影里，`gds.pageRank.stream` 直接拒绝整次调用：

```
sourceNodes nodes do not exist in the in-memory graph: [7371]
```

而 except 块把它吞掉返回 `[]`，**PPR 静默退化为「没有联想结果」而非显式失败**：检索质量下降，除一行日志外毫无痕迹。现对种子查询施加同样三个条件，且改用参数化而非字符串插值。

### 🐛 Windows 原生下 cube 路径被改写成 /mnt

`toLocalPath()` 无条件把 `G:/...` 转成 `/mnt/g/...`（`d658b42`）。该映射只在 WSL 内成立；原生 Windows Node 下 `/mnt/g/...` 不是绝对路径，会相对当前驱动器解析，于是**每一次 cube 写入都落进幻影目录树**（`C:\mnt\g\...` 或 `G:\mnto\g\...`，取决于 cwd），而 API 仍在读真实路径。

实际后果：`C:\mnt` 与 `G:\mnt` 下 6 个 `text_mem` 为空的 stub `config.json`，时间戳比真身更新；当 server 由 cwd 不在项目根的客户端启动时，`listAvailableCubes()` 返回 0 个 cube。注册报告成功（`POST /mem_cubes` 200），随后 `/search` 与 `/memories` 400——因为载入的 cube 没有记忆后端。win32 下原样返回路径。Python 版 server 从无此转换。

### ✨ `MEMOS_ENV_FILE`：显式指定 .env 位置

两个 server 此前只靠位置猜测 `.env`：cwd、包上两级、dotenv 向上搜索（`f4a61d3`）。从 checkout 运行时有效，**经 npx 安装时永远无效**——包根在 npm 缓存里，所有候选路径全部落空，一个变量都加载不到。cube 构建随即死在第一个必填变量上（`MOS_CHAT_MODEL is required to build a fallback cube config`），对用户表现为「注册成功但立刻自报未注册」，因为目录压根没被创建。

新增 `MEMOS_ENV_FILE`（Node server 另有 `--memos-env-file`）作为最高优先级来源。**路径不存在时在 stderr 告警而非静默穿透**——那里的拼写错误否则看起来与它要修的故障一模一样。变量未设时位置回退逻辑不变。

**验证:** 65 单测全绿；`tsc` 干净；schema budget 12488 B → 13680 B（+9.5%，超 +5% 阈值，已 `--write` 重新冻结——新增工具的正常成本，非描述漂移；描述已从 1333 B 压到 1192 B）；`scripts/canvas-e2e.mjs` 18 项全过；真实客户端跑通 `open → update×3 → show → list → context_resume`，`mem:` ref 经 `memos_get` 解引用回原记忆；`dist/` 确认无 `*.test.js` 泄漏。图谱三项修复各自的验证见对应 commit message（6392 节点零残留时间对象、archived_at 往返被 datetime 范围谓词命中、36 个 cube 在 cwd 外被正确发现）。

### 📖 文档：清掉整条已删除的 Python 路线

`mcp-server/memos_mcp_server.py` **早已不在仓库里**，但文档仍在全面教用户配置它：

- **`docs/MCP_GUIDE.md`（1231 行）整份都指向那个不存在的文件** —— 6 个平台配置、WSL wrapper 脚本、`conda_venv/python.exe`、旧的 `data/memos_cubes` 路径，以及一份含 1.x 已移除工具（`memos_list`、`memos_get_graph`）的工具参考。而 README_CN 正把它作为「完整配置导航」推荐给用户。**照这份文档操作的用户，没有一条路能走通。** 已按 npx 路线重写为 296 行：平台段落收敛成一张「配置文件位置」表（配置内容只有一份，不再六份各自漂移），新增故障排查表、cube 路由说明、画布说明。
- **README_CN 的配置示例**同样是 Python 路线，已改为 npx。
- **删除 `docs/images/architecture-mindmap.png`（1.5 MB）** —— 它不只是大，内容也已过期：标题写着旧项目名 `MemOSLocal-SM`，模式名写 `general_text`（实为 `naive_text`），工具列 1.x 的 `memos_get_graph`。它本就是一张思维导图，改用 Mermaid `mindmap` 内联渲染，可随代码一起 diff。`docs/images/` 从 2.3 MB 降到 816 K。

### 🐛 文档中的失效配置

- **`mcp-server-node/README.md` 的 `alwaysAllow` 列表有两处实际错误**：`memos_search` 重复出现；以及 `memos_admin(action=list_cubes)` 这类**调用形式**条目——`alwaysAllow` 匹配的是**工具名**，这些条目永远匹配不上任何东西，用户以为已免确认，实际每次仍会被拦。已改为裸工具名，并去掉 `memos_delete`（该示例同时设了 `MEMOS_ENABLE_DELETE=true`，等于默许无提示删除记忆）。
- 该 README 的 `.env` 提示仍称「工作目录下的 .env 自动以最高优先级加载」，在 `npx` 场景下是错的（包根在 npm 缓存里，位置猜测全部落空）。已补 `MEMOS_ENV_FILE` 行与说明。
- 三份文档的 `alwaysAllow` 与工具表补上 `memos_canvas`。

> 仍有遗留：`.env*.example`、`docs/DEPLOY_*.md`、`docs/DB/*.md`、`VENV_scripts/README.md` 等文件里还有 `conda_venv` / 旧 `data/memos_cubes` 之类的陈旧引用。本轮未处理——其中部分涉及 Python **后端**（那是 API，不是 MCP），需要分开判断。

**Commits:** `d658b42` · `1a53d01` · `f4a61d3` · `030bc42` · `a09c6c9`（+ 本轮 canvas 与文档提交）

## [3.0.0] - 2026-08-02

### 💥 BREAKING — MCP 工具面 18 → 10，分发统一走 npx

`oh-memos-mcp` 发布 **2.0.0**。上一轮把 11 个工具合并进 3 个派发工具，**没有兼容层**——MCP SDK 只派发已注册的工具，旧名一律返回 `Unknown tool`。若你的客户端配置里锁了工具名（如 Claude Code 的 `alwaysAllow`），升级前必须先改。

| 1.x 工具 | 2.0 替代 |
|---------|---------|
| `memos_search_context` | `memos_search`，传 `context` 数组 |
| `memos_get_graph` / `memos_trace_path` / `memos_impact` / `memos_export_schema` | `memos_graph(mode=related/path/impact/schema)` |
| `memos_list_cubes` / `memos_register_cube` / `memos_create_user` / `memos_validate_cubes` / `memos_get_stats` / `memos_calendar` | `memos_admin(action=list_cubes/register_cube/create_user/validate_cubes/stats/calendar)` |

不变：`memos_context_resume`、`memos_search`、`memos_save`、`memos_list_v2`、`memos_get`、`memos_suggest`、`memos_delete`。

- **版本号从 1.0.1 提到 2.0.0** — 此前以 patch 号躺在盘上，发出去会让所有 `npx -y oh-memos-mcp` 用户在无感知的情况下被打断
- **新增 `mcp-server-node/CHANGELOG.md`** — 完整迁移表（旧工具名从 registry 上的 1.0.0 tarball 实读，非凭记忆）

### 🔀 分发路线冲突修复

两份 README 全篇宣传 `npx -y oh-memos-mcp`，而 `scripts/bundle/configure_mcp.*` 生成的配置指向 `$BUNDLE_ROOT/mcp-server-node/dist/index.js`——一个没有任何 bundle 脚本会构建、打包或校验的路径，且 `command: "node"` 无 PATH 检查。同时 npm 上的 latest 仍是 3-04 的 1.0.0，早于 `memos_think` / `memos_export_wiki` / 合并后的 `memos_graph`、`memos_admin`。**两条路各缺最后一块，哪条都走不通。**

- `configure_mcp.sh/.bat` 改为生成 `command:"npx", args:["-y","oh-memos-mcp"]`，`MEMOS_CUBES_DIR` 仍指 BUNDLE_ROOT（数据留在 bundle 内），并前置探测 npx 而非等到 MCP 启动才失败
- `config/mcp-config.template.json` **此前仍是已废弃的 Python 路线**（`memoslocal` / `.venv/Scripts/python.exe` / `mcp-server/memos_mcp_server.py` / 旧的 `data/memos_cubes`），改为 npx 路线
- 被跟踪的模板是死路线、可用的 Node 版反被 `.gitignore` 的通配 `*.json` 挡在外面未跟踪——已对调，并把硬编码的 `G:/test/oh-memos` 换成 `${BUNDLE_ROOT}` 占位符
- **`mcp-server-node/schema-baseline.json` 纳入版本控制** — 它是 `npm run schema:budget --check` 的对比基线，不入库则该 token 预算纪律只在作者本机成立

### 🪝 Hooks 配置全链路失效修复

- **`settings-template.json` 的 9 条 hook 路径全部指向不存在的文件** — 脚本实名 `oh_memos_*.js`，模板写的是 `memos_*.js`。CLAUDE.md 正是让用户照此配置，等于所有按文档操作的用户 hook 从来就是坏的
- **删除 `project-memory/hooks/bash/`** — 内含 4 个 `.sh`，其 shebang 却是 `#!/usr/bin/env node`，即放在 `bash/` 目录里的 JavaScript，`bash -n` 必然失败；且是 `node/` 版的陈旧副本（`user_prompt` 13 行 vs node 版 145 行）
- **删除 node/ bash/ powershell/ 三个 `settings.json`** — 硬编码 `/mnt/g/test/MemOS`、`G:/test/MemOS`（旧项目名，目录已不存在），且同样缺 `oh_` 前缀。它们从未被 git 跟踪（`*.json` 通配），而旧 `hooks/README.md` 却在教用户 `cp` 这些仓库里根本没有的文件。现统一以 `settings-template.json` 为唯一入口
- 重写 `hooks/README.md`（原标题仍为 "MemOS Hooks"，目录树写每目录 4 个文件而 node/ 实有 10 个）
- 修正 CLAUDE.md 与 README.md 共 12 处 `oh-memos_*.js` 连字符误写（实名为下划线）

### 🔧 行尾规范化

`scripts/bundle/*.sh` 与 `evaluation/scripts/*.sh` 共 11 个文件**以 CRLF 提交入库**，在 Linux/macOS 上完全无法执行：bash 把 `\r` 并进 token，`BUNDLE_ROOT` 解析成 `scripts/bundle\r/../..`，heredoc 结束标记变 `EOF\r` 永不匹配，最终在文件末行报 `syntax error: unexpected end of file`——而真正的原因在开头。`bash -n` 对 11 个文件全部失败。

仓库既无 `.gitattributes` 也未设 `core.autocrlf`，CRLF 原样存储并落到每一个 Unix 检出。**整条 Unix bundle 安装路径从来没能跑起来。**

- 新增 `.gitattributes`：`*.sh` 锁 LF，`*.bat`/`*.cmd`/`*.ps1` 锁 CRLF，二进制不转换
- `memory-admin.bat` 由 LF 改回 CRLF

### 🐛 其他

- **MCP `serverInfo` 硬编码** — `server.ts` 写死 `{name:"memos-memory", version:"1.0.1"}`，名字与包名 `oh-memos-mcp`、客户端 server key `oh-memos` 三者皆不一致，且版本随发版静默漂移（2.0.0 发布后握手仍自报 1.0.1）。改为启动时从 `package.json` 读取。发布为 **2.0.1**

**验证:** tsc 干净；schema budget 12488 B（+0.0% vs 基线）；`npm pack` 产出 48 文件；`configure_mcp.sh` 实跑生成可解析 JSON；npx 探测两分支均实测；对已发布包执行 stdio `initialize` + `tools/list` 返回正好 10 个工具，`memos_delete` 正确隐藏。

**Commits:**
- `98450d8` - chore: normalize line endings and add .gitattributes
- `81982aa` - feat(mcp)!: release 2.0.0 and unify distribution on npx
- `5ff1572` - fix(hooks): repair hook paths and drop the stale bash/ variant
- `5918579` - fix(mcp): read serverInfo from package.json instead of hardcoding it

## [2.9.0] - 2026-08-01

### 🧠 memos_think — 证据包 + 缺口分析

只读工具。`/search` 语义检索与最近 72h 时序召回双路去重，输出编号证据（`[n]` + id + 类型 + 日期 + 700 字符截断）、证据间图关系、矛盾/演进候选、过期候选、缺口分析，以及回灌为 `SYNTHESIS` 的指引。

**合成刻意留给调用方模型，服务端不产散文**——这是与 GBrain `think` 的关键差异决策。矛盾检测为查询时规则级，不依赖 `CONFLICT` 边（那些边只由默认关闭的 reorganizer 创建）。

### 📖 memos_export_wiki — 导出互链 markdown wiki

`/product/graph/data` 分页拉全量 → 过滤 WorkingMemory 层级与非 activated → 每条记忆一页（YAML frontmatter 含 generator 标记 / id / type / tags / confidence）+ `[[wikilink]]` 关联段 + `index.md` + `graph.md`（mermaid，>80 节点跳过）。默认输出 `<project_path>/docs/memory-wiki`。

**安全:** 仅删除带 generator 标记的文件，外来文件保留并告警。文件 IO 必须在 Node 侧——Python API 跑在 Windows 解释不了 WSL 路径。

### ✂️ MCP 工具面 token 优化：19 → 10

`tools/list` payload 22.9 KB（≈5850 tokens）→ 11.2 KB（≈2856 tokens），**降 51%**。schema budget 基线由 27078 B 重冻结为 12488 B（-53.9%）。

- **合并** — `memos_search_context` 并入 `memos_search`（传 `context` 即走原上下文感知路径）；graph 四件套 → `memos_graph(mode=...)`；admin 六件套 → `memos_admin(action=...)`。派发在 `handlers/index.ts` 就地 switch，原 handler 函数一个没动
- **参数去重** — `project_path`/`cube_id` 短版描述用于除 `save`/`search` 外全部工具，完整路由说明只讲一次
- **`memos_admin` 的 `cube_id` 去掉 default** — 否则 `register_cube` 漏传会静默注册 default cube
- **运行时文案同步** — handler 错误提示里的旧工具名全部改为新调用形式，否则模型会照提示调用已不存在的工具

### 🆕 新增 memory_type: SYNTHESIS

用于从检索证据合成的答案。Node 侧 7 处改动；Python 不校验类型故零改动。

### 🔒 记忆写入侧凭证脱敏（运行期）

承接 `c47eefa` 的提交期拦截，这次是运行期。

- `src/oh_memos/security/redact.py` — 13 条模式，按结构前缀锚定（`AKIA` / `sk-` / `sk-ant-` / `ghp_` / `github_pat_` / `eyJ` / `xox.` / `AIza` / `BEGIN PRIVATE KEY` 等）而非熵值，避免误伤普通代码与散文。顺序敏感：`sk-ant-` 必须在裸 `sk-` 之前
- `start_api.py` 接入两条写路径：`POST /memories` 与 `PUT /memories/{cube}/{id}`（后者此前完全没覆盖）
- 日志只记录凭证**种类**不记录值，否则告警本身就是泄漏
- `tests/test_redact.py` — 63 项，含检测、模式顺序、误报防护、幂等、开关
- 开关 `MEMOS_REDACT_SECRETS=false`

端到端验证：LLM 提炼出的正文只写「以 `sk-pro` 开头的密钥」，证明模型自始至终未见明文——脱敏确实发生在提炼与向量化之前。

**范围:** 仅覆盖写入侧，存量旧记忆不做读取侧脱敏或扫描清洗。

**Commits:**
- `1321e89` - feat(security): runtime credential redaction on memory write paths
- `f468b54` - feat(mcp): memos_think + wiki export + SYNTHESIS; consolidate tool surface 19→10
- `3e3c004` - chore: dogfood memory-wiki export of oh_memos_cube (82 pages)

## [2.8.0] - 2026-07-29

### 🖥️ Memory Admin GUI

FastAPI + 单页 UI，直连 Neo4j/Qdrant/文件系统，**主 API(18000) 宕掉也能用**。

- 浏览/搜索记忆、单条删除、整 cube 删除（三个存储一并清理）、批量删除、备份管理
- 三重删除防护：键入确认、dry-run 预览、自动备份
- 入口 `memory-admin.bat`

### 🐛 MCP 读写路径审计修复

**正确性:**
- `mem_reader` 兜底键写作 `memory_list` 而读取方用 `memory list`，导致 LLM 解析失败时记忆被静默丢弃而非存储
- MCP 时序查询按 `MEMOS_USER` 过滤，但节点存的是 `user_name = cube_id`，`context_resume` 的 24h 召回**永远为空**
- 关系检测器把含 `<think>` 推理的 LLM 原始输出直接存为记忆（清理了 1847 个被污染节点）
- `list_v2` 按类型过滤时拉取整个 cube 且渲染未截断结果，`limit=5` 的请求能撑到约 180 万 tokens

**一致性/泄漏:**
- `remove_oldest_memory` 删 Neo4j 节点却不删对应 Qdrant 向量，泄漏的孤儿仍占用 search top_k
- `add_node` 在图写入失败时回滚其向量
- `add_node`/`add_nodes_batch` 按内容去重（DB 级幂等）

**性能:**
- `_parse_node` 不认 `include_embedding` 标志，逐节点一次请求拉向量（N+1，在 Windows 上耗尽套接字：WinError 10022）

### 🔐 提交期密钥与运行产物拦截

`.gitignore` 只能防止误 `git add`，挡不住 `git add -f`，也认不出新起的文件名。新增 pre-commit 钩子检查**实际暂存内容**并拒绝：

- env 文件及其备份、`data/*_cubes/` 下的 cube 数据、`*/backups/` 下的 GUI 导出、密钥材料（`.pem`/`.key`/`id_rsa`）
- 粘进普通文件的凭证内容（`sk-*`、`github_pat_*`、`ghp_*`、`AKIA*`、`API_KEY/SECRET/TOKEN/PASSWORD = ...`）

拦截信息中的密钥本身会被脱敏，否则告警自身就会把它泄漏进终端与 CI 日志。示例/模板文件豁免。启用：`git config core.hooksPath .githooks`

同时会在 remote URL 内嵌 token 时告警。

**Commits:**
- `82e65b1` - feat: memory admin GUI + MCP read/write hardening
- `c47eefa` - chore: block secrets and runtime artifacts at commit time

## [2.7.2] - 2026-05-09

### 🐛 LLM 瞬时连接错误恢复 (WinError 10053)

Windows 上被上游代理/VPN 静默关闭的 keep-alive TCP 连接，在复用时抛 WinError 10053。OpenAI SDK 将其呈现为 `APIConnectionError`，而 `_safe_generate` 只对子串 `bad_response_status_code` 重试，**单次 socket abort 就会让整个 mem_reader 调用失败**。

- `_safe_generate` 改为对 `APIConnectionError` / `APITimeoutError` / `RateLimitError` / `InternalServerError` 以及 WinError 10053/10054 字符串重试；重试次数 2 → 3，指数退避
- `OpenAILLM` 注入 `httpx.Client`（`keepalive_expiry=10s` + 显式超时），SDK `max_retries` 提到 3，以便在复用前淘汰陈旧套接字

**Commits:**
- `458d50c` - fix(llm): recover from transient APIConnectionError (WinError 10053)

## [2.7.1] - 2026-03-14

### ⚡ 启动性能：cube 按需注册

此前 `startup_auto_register` 顺序加载**全部** cube（11+），每个都要初始化 Neo4j driver、Qdrant collection、LLM 客户端与 embedder，API 启动极慢。

现在启动时只注册 default cube，其余在 MCP server 调用 `/mem_cubes` 时按需注册。新增 `MEMOS_STARTUP_CUBES`：空/未设 = 仅 default（快速启动），`"cube1,cube2"` = 指定，`"all"` = 旧行为。并加入 per-cube 计时日志。

### 🐛 启动与运行时阻塞修复

- **事件循环阻塞** — 记忆 CRUD 与搜索端点由 `async def` 改为 `def`，交由 FastAPI 线程池执行。此前 `register_mem_cube` 与 `mos_instance.add/search` 会阻塞事件循环，冻结整个 API（含 `/health`）
- **HuggingFace tokenizer 下载阻塞启动** — 文本分块的 gpt2 HF tokenizer 换成 chonkie 内置 `character` 模式，流式处理的 `AutoTokenizer.from_pretrained` 换成 tiktoken，消除 hf-mirror.com 超时导致的启动延迟

### 🐛 cube 自动注册

- 移除 `ensure_cube_registered` 中过早的模板 cube 检查（Python 与 Node 两侧），让 `_build_fallback_cube_config` 能从环境变量创建 cube
- `handle_memos_register_cube` 支持自动创建
- 访问未注册 cube 此前返回 500；现在 API 从 default cube 模板自动创建目录并按需注册，仍失败才返回 404
- `startup_auto_register` 加入 Neo4j 就绪检查以免阻塞；降低启动期 Neo4j 连接拒绝与 Nacos 缺配置的日志噪音

**Commits:**
- `4d3afac` - fix: cube auto-registration without template and startup resilience
- `c9437f3` - perf: only register default cube at startup, others on-demand
- `bdf3bab` - fix: auto-register cubes on-demand across all API endpoints with 404 error handling
- `8a12568` - fix: use sync handlers for memory endpoints to prevent event loop blocking
- `c211336` - fix: remove HuggingFace tokenizer downloads that block startup

## [2.7.0] - 2026-03-04

### 📦 oh-memos-mcp — Node.js MCP Server on npm

发布独立 npm 包，彻底消除 Python 环境依赖。

- **`oh-memos-mcp@1.0.0`** 发布至 [npm registry](https://www.npmjs.com/package/oh-memos-mcp)
  - 纯 Node.js 实现，18 个工具，与 Python MCP server 功能对等
  - 任意环境通过 `npx -y oh-memos-mcp` 直接启动，无需安装步骤
  - **`.env` 加载优先级修复** (`mcp-server-node/src/config.ts`)
    - 旧逻辑: 从 `__dirname/../..` 查找（npx 时指向 npm 缓存目录，必然失败）
    - 新逻辑: `process.cwd()/.env` → 包目录 `.env` → dotenv 默认搜索
  - **`package.json` 补全元数据**: `repository`, `bugs`, `homepage`, `.env.example` 加入 `files`
  - **新增 `.env.example`**: 列出所有必需/可选环境变量及默认值注释

- **Claude Code 配置迁移**
  - `~/.claude/settings.json` 两处 `oh-memos` MCP 配置从 `bash run_mcp.sh` 替换为 `npx -y oh-memos-mcp`
  - `~/.codex/config.toml` 同步更新为 npx 方式 + TOML `[env]` 子节
  - `alwaysAllow` 新增 `memos_delete`（`MEMOS_ENABLE_DELETE=true` 时激活）

**Commits:**
- `f483bd5` - feat: publish oh-memos-mcp npm package and rename memos → oh_memos

### 🔄 项目重命名: memos → oh_memos

全面将内部模块名从 `memos` 更名为 `oh_memos`，避免与上游 MemOS 混淆。

- **`src/memos/` → `src/oh_memos/`** — 所有核心模块完整迁移
- **Hooks 重命名** — `memos_*.sh/js/ps1` → `oh_memos_*.sh/js/ps1`（`.claude/hooks/` 及 `project-memory/hooks/` 两处）
- **CLI & Deploy 目录** — `memos-cli/` → `oh-memos-cli/`，`memos-deploy/` → `oh-memos-deploy/`
- **MCP Server 文件** — `memos_mcp_server.py` → `oh_memos_mcp_server.py`

### 🐛 start.bat 热重载循环修复

- **问题**: `start.bat` 先将 `.env` 复制到 `src\.env`，WatchFiles 检测到文件变化立即触发 reload，worker 不断重启导致 API 永远不可用
- **修复**: 移除 `copy /y ".env" "src\.env"` 操作；移除 `--reload` 标志（生产环境不需要热重载）

### 📝 文档更新

- **`README.md` MCP 配置章节**
  - 内嵌完整 `npx oh-memos-mcp` JSON 配置示例（含 `alwaysAllow`）
  - 新增三平台路径折叠表（Linux/macOS · Windows · WSL2）
  - MCP Tools 表格工具名从 `oh-memos_*` 更正为实际的 `memos_*`，补全全部 18 个工具
- **`mcp-server-node/README.md`** — 全新编写：Prerequisites、Quick Start、四平台配置示例、env 变量完整说明、`.env` 加载原理
- **文档项目名全量替换**: `MemOSLocal-SM` → `oh-memos`（6 个文件，10 处）
- **README 乱码修复** — 重命名收尾，同时清理残留的 `oh-memosLocal-SM` 写法

**Commits:**
- `e90199e` - docs: rename MemOSLocal-SM → oh-memos across all documentation
- `f42fec6` - fix: repair garbled chars and rename oh-memosLocal-SM in README



### 🔍 Knowledge Graph Intelligence — Fixed & Supercharged

This release fixes **three silently broken graph tools** and adds new graph intelligence capabilities.

**Root Cause**: The `tree_text` LLM extractor strips `[TYPE]` prefixes from memory text during processing, but the MCP layer was reading type from memory text only — causing all 942+ memories to appear as PROGRESS. Similarly, `memos_get_graph` used full multi-word query strings for Neo4j `CONTAINS` matching (never matches Chinese), and `memos_trace_path` had wrong API path and field names.

- **`extract_mcp_type()` — Unified Type Detection Engine** (`mcp-server/query_processing.py`)
  - Four-level detection: memory prefix → sources parsing (double-JSON decode) → reasoning node → PROGRESS
  - Used by all tools: stats, list, get, search — single source of truth
  - Correctly identifies BUGFIX/DECISION/MILESTONE etc. from `sources[0].content`

- **`INFERRED` Type** (`mcp-server/models.py`)
  - Neo4j auto-generated reasoning nodes (`type: reasoning`, `key: InferredFact:CAUSE`) now classified as `INFERRED` (🔗)
  - No longer pollute PROGRESS statistics
  - Enum, icon map, and stats health report updated

- **`memos_get_graph` Fix** (`mcp-server/handlers/graph.py`)
  - **Bug**: Cypher `CONTAINS $keyword` with full multi-word query never matches
  - **Fix**: Uses MemOS vector search IDs to query Neo4j neighbor edges (language-agnostic)
  - Now correctly returns CAUSE/RELATE/CONDITION/FOLLOWS relationships

- **`memos_trace_path` Fix** (`mcp-server/handlers/graph.py`)
  - **Bug**: Wrong API endpoint (`/graph/` → `/product/graph/`), wrong field name (`found` → `path_found`)
  - **Fix**: Correct endpoint + field + fallback to direct Neo4j `shortestPath` when API returns empty nodes

- **`memos_get_stats` Fix** (`mcp-server/handlers/memory.py`)
  - **Bug**: All memories displayed as PROGRESS (100%)
  - **Fix**: Reads type from `metadata.sources` with double-JSON decode fallback
  - New: Per-type emoji icons (🐛🎯✨📋), INFERRED vs PROGRESS distinction, user-typed count

- **`memos_list_v2` Filter Fix** (`mcp-server/handlers/memory.py`)
  - **Bug**: `memory_type=BUGFIX` filter ignored (API filters by MemOS internal type)
  - **Fix**: Client-side filtering using `extract_mcp_type()` after fetching all memories

**Commits:**
- `60627ef` - fix: fix memory type classification and add stop/unregister scripts
- `07a1aea` - fix: fix memos_get_graph and memos_trace_path broken queries

### 🧠 PreToolUse Auto Memory Injection (GitNexus-Inspired)

Inspired by [GitNexus](https://github.com/abhigyanpatwari/GitNexus)'s PreToolUse hook pattern.

- **`memos_context_inject.js`** (`project-memory/hooks/node/`)
  - Intercepts Grep/Glob/Read/Edit/Write tool calls
  - Extracts meaningful search keyword from tool input (regex cleaning for Grep, extension filtering for Glob, filename extraction for Read/Edit/Write)
  - Searches MemOS API, formats top 3 results as concise `additionalContext` (max 800 chars)
  - Derives cube_id from CWD automatically (same routing as MCP server)
  - Graceful failure: if API down or no results, silently suppresses (never blocks tool execution)
  - 4-second timeout, well within Claude Code's 5-second hook limit

- **Settings template updated** (`project-memory/hooks/settings-template.json`)
  - New PreToolUse matcher: `Grep|Glob|Read|Edit|Write` → `memos_context_inject.js`

**Commit:** `ec08ec3` - feat: add PreToolUse hook for automatic memory context injection

### ⚡ RRF Local Reranker

Eliminates dependency on external HTTP reranker API (SiliconFlow BGE).

- **`RRFReranker`** (`src/memos/reranker/rrf.py`)
  - Implements Reciprocal Rank Fusion (Cormack, Clarke & Buettcher, 2009)
  - Formula: `score(d) = 1 / (k + rank)`, k=60 (standard literature value)
  - Same approach used by Elasticsearch, Pinecone, and GitNexus
  - Zero HTTP calls, pure Python math (<1ms vs 200-400ms for HTTP reranker)
  - Implements `BaseReranker` interface, uses `@timed` decorator

- **Factory registration** (`src/memos/reranker/factory.py`)
  - New backend: `"rrf"` with configurable `k` parameter

- **Default config updated** (`data/memos_cubes/dev_cube/config.json`, `audiocraft_studio_cube/config.json`)
  - Changed from `"backend": "http_bge"` to `"backend": "rrf"`

**Commit:** `c2a9cfb` - feat: add RRF local reranker to eliminate HTTP reranker dependency

### 💥 `memos_impact` — Forward Blast Radius Analysis

New MCP tool for understanding the downstream impact of a memory.

- **`memos_impact`** (`mcp-server/tools_registry.py`, `handlers/graph.py`)
  - Input: `memory_id` + optional `max_depth` (1-6, default 3)
  - Traverses CAUSE and FOLLOWS edges forward from source node
  - Groups results by hop depth: Direct Impact (1 hop) → Indirect (2 hops) → Downstream (3+)
  - Shows blast radius summary: "N downstream memories across M hops"
  - Caps display at 8 items per depth group
  - Uses Neo4j `shortestPath` for accurate hop calculation

**Commit:** `8768f41` - feat: add memos_impact tool for forward blast radius analysis

### 🛠️ Windows Scripts

- **`stop.bat`** (`scripts/local/`) — One-click stop for API + Qdrant + Neo4j
- **`unregister_autostart.bat`** (`scripts/local/`) — Remove autostart scheduled task with UAC self-elevation
- **`register_autostart.bat`** — Fixed: added UAC self-elevation (was flashing on double-click)

### 🗜️ Context Compression (Phase 1 - Beads Inspired)

借鉴 [beads](https://github.com/steveyegge/beads) 项目的上下文工程模式，实现 Token 高效使用。

- **分层内存模型** (`mcp-server/models.py`)
  - `MemoryMinimal`: 列表视图 (~80% token 减少)，仅包含 id、type、summary
  - `MemoryBrief`: 标准搜索结果，包含 key、tags、relevance
  - `MemoryFull`: 完整详情 (仅 memos_get 返回)
  - `CompactedSearchResult`: 大结果集包装器，返回预览 + 摘要

- **自动压缩逻辑** (`mcp-server/handlers/memory.py`, `search.py`)
  - **阈值**: 结果 >15 条时自动压缩
  - **预览**: 显示 Top 5 条 (id + type + 摘要)
  - **提示**: 引导使用 `memos_get(memory_id="<id>")` 获取完整详情
  - **Token 节省**: 560 条记忆从 ~10,000 tokens → ~300 tokens (~97% 减少)

- **新增 MCP 工具: `memos_get`** (`mcp-server/handlers/memory.py`, `tools_registry.py`)
  - 通过 ID 获取单条记忆的完整详情
  - 与压缩结果配合使用，实现渐进式详情检索
  - 使用直接 API 端点: `GET /memories/{cube_id}/{memory_id}`

- **API 修复** (`src/memos/api/start_api.py`)
  - 修复 `/memories/{cube_id}/{memory_id}` 端点返回 Pydantic 验证错误
  - 问题: 返回 `TextualMemoryItem` 对象而非字典
  - 解决: 调用 `model_dump()` 转换为字典

- **工具清理**
  - 移除已废弃的 `memos_list` (v1)，统一使用 `memos_list_v2`
  - 添加 `compact` 参数到 `memos_search` 和 `memos_list_v2` (默认 true)

- **Skill 更新** (`.claude/skills/project-memory/SKILL.md`)
  - 添加 `memos_get` 工具说明
  - 添加上下文压缩功能文档
  - 更新工作流图

**Commits:**
- `733ba99` - feat(mcp): add context compression for efficient token usage
- `aeac160` - fix(mcp): use direct API for memos_get instead of search
- `bbeeac1` - fix(api): convert TextualMemoryItem to dict in /memories/{cube_id}/{memory_id}
- `d1ad465` - docs(skill): add memos_get tool and context compression feature

### 🏥 Health Check & Observability

- **`/health` 健康检查端点** (`src/memos/api/start_api.py`)
  - **Feature**: 返回服务整体状态 (`up` / `degraded` / `down`)
  - **组件检查**: Neo4j (核心), Qdrant (核心), Ollama (非核心)
  - **状态逻辑**:
    - 所有核心组件 healthy → `up`
    - 核心组件均可用但有非核心组件失败 → `degraded`
    - 任一核心组件失败 → `down`
  - **无需认证**: 便于监控系统 (Prometheus/Kubernetes) 调用

- **`/health/detail` 详细健康检查端点** (`src/memos/api/start_api.py`)
  - **Feature**: 返回每个组件的详细状态、响应时间、错误信息
  - **超时控制**: 每个组件独立 5 秒超时
  - **响应模型**: `HealthResponse`, `HealthDetailResponse`, `ComponentHealth` (`product_models.py`)

- **Health Handler 备份实现** (`src/memos/api/handlers/health_handler.py`)
  - 用于 `server_router.py` 的健康检查处理器类
  - 组件状态检测方法 (`_check_neo4j`, `_check_qdrant`, `_check_ollama`)

### 🛡️ Unified MCP Error Handling

- **标准化错误码** (`mcp-server/handlers/utils.py`)
  - 10 个错误码: `API_UNREACHABLE`, `API_ERROR`, `CUBE_NOT_FOUND`, `CUBE_REGISTRATION_FAILED`, `PARAM_MISSING`, `PARAM_INVALID`, `MEMORY_SAVE_FAILED`, `MEMORY_DELETE_FAILED`, `SEARCH_FAILED`, `GRAPH_QUERY_FAILED`
  - **统一错误格式**:
    ```
    ❌ [ERROR_CODE] Error message

    💡 Suggestions:
    - actionable suggestion 1
    - actionable suggestion 2
    ```
  - **辅助函数**: `cube_registration_error()`, `api_error_response()`

- **Handler 更新** (`mcp-server/handlers/`)
  - `memory.py`: 保存/删除错误使用 `MEMORY_SAVE_FAILED` / `MEMORY_DELETE_FAILED`
  - `search.py`: 搜索错误使用 `SEARCH_FAILED`
  - `graph.py`: 图查询错误使用 `GRAPH_QUERY_FAILED`
  - `admin.py`: Cube 操作错误使用 `CUBE_NOT_FOUND` / `CUBE_REGISTRATION_FAILED`

- **顶层异常处理** (`mcp-server/memos_mcp_server.py`)
  - 全局 try-catch 返回统一格式错误
  - 区分 API 不可达 vs 其他异常

### 🗄️ PROGRESS Auto-Archive

- **归档配置** (`.env.example`)
  - `MEMOS_AUTO_ARCHIVE=true` - 启用自动归档
  - `MEMOS_ARCHIVE_TTL_DAYS=7` - 归档阈值 (天)
  - `MEMOS_ARCHIVE_INTERVAL=3600` - 扫描间隔 (秒)
  - `MEMOS_ARCHIVE_TYPES=PROGRESS` - 需要归档的类型 (逗号分隔)

- **归档逻辑模块** (`src/memos/mem_scheduler/archiver.py`)
  - `archive_expired_memories_sync()` - 将过期记忆状态改为 `archived`
  - `get_archive_stats_sync()` - 获取各状态记忆数量统计
  - `restore_archived_memory_sync()` - 恢复被归档的记忆
  - `periodic_archive_task()` - 后台定期归档任务

- **归档 API 端点** (`src/memos/api/start_api.py`)
  - `POST /archive/run` - 手动触发归档
  - `GET /archive/stats` - 查询归档统计
  - `POST /archive/restore/{memory_id}` - 恢复被归档记忆

- **后台任务** (`src/memos/api/start_api.py`)
  - API 启动时自动创建后台归档任务
  - 默认 1 小时扫描一次
  - 支持通过环境变量配置

- **设计文档**
  - `docs/design/phase1_health_check.md` - 健康检查详细设计
  - `docs/design/phase3_auto_archive.md` - 自动归档详细设计

### 🚀 Technical Evolution (Paper-Inspired)

We have introduced significant architectural upgrades inspired by the latest 2025-2026 RAG and Memory research papers (EverMemOS, MAGMA, HippoRAG 2).

- **🔍 Multi-Graph View Routing (Inspired by MAGMA)** (`query_processing.py`, `handlers/search.py`)
  - **Feature**: Automatically detects query intent (causal, temporal, conflict, related) and routes the search to specific sub-graphs in Neo4j.
  - **Impact**: Reduces token consumption and significantly improves precision by filtering irrelevant relationship types (e.g., "Why" queries only traverse `CAUSE` and `CONDITION` edges).
  - **Mapping**:
    - `causal` → `CAUSE`, `CONDITION`
    - `temporal` → `FOLLOWS`
    - `conflict` → `CONFLICT`
    - `related` → `RELATE`

- **🧠 HippoRAG 2 PPR Retrieval (Inspired by HippoRAG 2)** (`src/memos/storage/graph_db/neo4j.py`, `recall.py`)
  - **Feature**: Integrated **Personalized PageRank (PPR)** algorithm via Neo4j GDS plugin.
  - **Impact**: Beyond simple vector similarity, it allows the AI to discover multi-hop causal chains (e.g., tracing from "Java not installed" to "API timeout").
  - **Workflow**: Vector search finds "seed nodes" → PPR propagates scores along relationship edges → Returns top-ranked contextual memories.

- **📅 Temporal Graph Enhancement (Inspired by MAGMA)** (`mcp-server/handlers/graph.py`)
  - **Feature**: Direct Neo4j temporal queries via MCP, supporting natural language time windows (e.g., "recently", "today", "this week").
  - **Impact**: Efficiently retrieves chronologically linked memories using the `FOLLOWS` relationship.

### ⚠️ BREAKING CHANGES

- **🚨 `memos_save` 强制要求 `memory_type` 参数** (`mcp-server/tools_registry.py`, `handlers/memory.py`)
  - `memory_type` 从可选参数变为**必填参数**
  - 移除 `default: "PROGRESS"` 默认值
  - 不带 `memory_type` 的保存请求会被立即拒绝，并返回类型选择决策树
  - 移除自动检测降级逻辑（`detect_memory_type` 不再作为保存时的 fallback）
  - **迁移指南**：
    ```python
    # ❌ 旧用法（不再支持）
    memos_save(content="修复了登录问题")

    # ✅ 新用法（必须指定类型）
    memos_save(content="修复了登录问题", memory_type="BUGFIX")
    ```
  - **背景**：历史数据中 532 条记忆全部为 PROGRESS 类型（100%），导致知识图谱语义分类缺失。此变更从 Schema 层和 Handler 层双重强制分类，防止无效记忆堆积

### Added

- **🪝 Claude Code Hooks 增强** (`.claude/hooks/`)
  - `memos_auto_save.js/sh` (新增): PostToolUse 智能保存建议
    - 检测配置文件编辑 → 建议 CONFIG
    - 检测项目文件更新 → 建议 MILESTONE
    - 检测命令失败 → 建议搜索 ERROR_PATTERN
    - 检测依赖安装 → 建议 CONFIG
  - `memos_block_sensitive.js/sh` (增强): 四级敏感度检测
    - 🚨 CRITICAL: SSH 密钥、证书、云凭证
    - ⚠️ HIGH: .env、密码、secrets
    - ⚙️ MEDIUM: 配置文件（带保存提醒）
    - 📦 LOW: 自动生成文件（覆盖警告）
  - Hooks 全局部署：WSL `~/.claude/hooks/node/` + Windows `AppData/Roaming/Claude/hooks/node/`

- **📄 README.md 重构** (主页)
  - 从 1400+ 行精简至 ~210 行
  - 添加架构思维导图、特性展示等可视化图片 (`docs/images/`)
  - 详细内容链接至 docs/ 目录

### Changed

- **📄 CLAUDE.md 精简 + SKILL.md 增强** (架构优化)
  - **CLAUDE.md**: 372 行 → 122 行 (减少 67%)
    - 保留：项目概述、核心记忆规则（简化版）、项目配置、服务端口表、API Endpoints
    - 移除重复内容：决策树、错误/正确示范、详细触发规则、Graph Tools 说明
    - 新增指向 `/project-memory` skill 的引用
  - **SKILL.md**: 365 行 → 524 行 (增加 44%)
    - 新增：置信度机制说明、健康检查说明
    - 新增：Auto-Registration & Auto-Creation 说明
    - 新增：完整的 MCP Server Environment Variables 表
  - **职责划分**：
    - `CLAUDE.md`: 项目配置兜底 (~100行)，快速上下文
    - `SKILL.md`: MCP 操作规则详解 (~500行)，按需加载
  - **收益**：随着项目发展，CLAUDE.md 可继续添加项目规则而不会因 MCP 操作规则过多导致模型"迷失"

- **📝 README_CN.md 重构** (project-memory/)
  - 新增：Skill 安装方式（从 MemOS 项目复制 vs 独立安装）
  - 新增：CLAUDE.md 配合使用说明
  - 新增：MCP 模式 vs Skill 模式对比
  - 更新：目录结构反映当前架构

### Added

- **🔄 Embedder 自动降级方案** (`src/memos/embedders/fallback.py`)
  - 当云端嵌入服务(SiliconFlow/OpenAI)失败时，自动回退到本地 Ollama
  - **错误分类**: `classify_error()` 区分瞬态错误(timeout/429/503)和永久错误(401/404)
  - **重试策略**: `RetryPolicy` 实现指数退避 + 随机抖动 (可配置 max_retries, initial_delay, backoff_multiplier)
  - **维度适配**: `DimensionAdapter` 支持三种策略处理主备 embedder 维度不匹配
    - `error`: 报错 (默认，保证数据一致性)
    - `warn_and_continue`: 警告但继续
    - `pad_or_truncate`: 填充或截断
  - **FallbackEmbedder**: 装饰器模式无侵入包装主 embedder
  - **新增异常类型** (`src/memos/exceptions.py`):
    - `TransientEmbedderError`: 可重试错误 (timeout, 429, 500-504)
    - `PermanentEmbedderError`: 立即降级错误 (401, 403, 404)
    - `EmbeddingDimensionMismatchError`: 维度不匹配错误
  - **新增配置类** (`src/memos/configs/embedder.py`): `FallbackConfig`
  - **新增环境变量** (`src/memos/configs/env_loader.py`): 11 个 fallback 相关配置
  - **启用方式**:
    ```bash
    MOS_EMBEDDER_FALLBACK_ENABLED=true
    MOS_EMBEDDER_FALLBACK_MODEL=nomic-embed-text:latest
    ollama pull nomic-embed-text:latest
    ```
  - **重试时序示例**:
    ```
    T=0ms:    Try 1 → 失败 (timeout)
    T=1000ms: Try 2 → 失败 (delay 1s)
    T=3000ms: Try 3 → 失败 (delay 2s)
    T=7000ms: Fallback to Ollama → 成功
    ```

- **🛡️ MCP Fallback Tools for Isolated Projects** (`mcp-server/memos_mcp_server.py`)
  - `memos_register_cube`: Manual cube registration when auto-registration fails
    - Parameters: `cube_id` (required), `cube_path` (optional, auto-detected from MEMOS_CUBES_DIR)
    - Use case: "Cube not found" or "Cube not registered" errors
  - `memos_create_user`: Create user account for "user does not exist" errors
    - Parameters: `user_id` (required), `user_name` (optional, defaults to user_id)
    - Use case: "User 'xxx' does not exist" errors
  - Updated SKILL.md Troubleshooting section with MCP-only recovery steps (no Bash/curl required)
  - Added Quick Recovery Flowchart for common error scenarios
  - **Impact**: Models in completely isolated projects can now self-recover from errors using only MCP tools

- **🔍 Keyword Query Enhancement Module** (`mcp-server/keyword_enhancer.py`)
  - **Extended Stopwords Library**: 1300+ stopwords (816 English + 484 Chinese)
    - Programming terms: function, class, import, return, module, etc.
    - Chinese stopwords from Baidu, HIT, SCU comprehensive lists
  - **Fuzzy Matching**: Levenshtein distance algorithm for typo tolerance
    - Example: "configration" matches "configuration" (92% similarity)
    - Example: "databse" matches "database" (88% similarity)
    - Configurable threshold (default: 0.75)
  - **Structured Field Weighting**: Prioritize matches in metadata fields
    - `key` field match: +5.0 score
    - `tags` match: +3.0 score
    - Text exact match: +2.5 score
    - Text substring: +1.5 score
    - Fuzzy match: +1.0 × similarity
  - **Smart Cube Detection**: Auto-derive cube_id from project path
    - `/mnt/g/test/MemOS` → `memos_cube`
    - `C:\Projects\WebApp` → `webapp_cube`
    - Cross-platform support (Windows/Linux/WSL)

- **🧪 Keyword Enhancer Tests** (`tests/test_keyword_enhancer.py`)
  - Stopwords library validation (1300+ words)
  - Keyword extraction with stopword filtering
  - Levenshtein distance calculation
  - Fuzzy match finding
  - Structured field scoring
  - Smart cube detection (Unix and Windows paths)

- **📋 Keyword Optimization Planning Docs** (`docs/plans/`)
  - `keyword-query-optimization.md` - Task plan with phases
  - `keyword-optimization-findings.md` - Technical research
  - `keyword-optimization-progress.md` - Progress tracking

### Changed

- **⚡ Enhanced MCP Keyword Processing** (`mcp-server/memos_mcp_server.py`)
  - `extract_keywords()` - Now uses extended stopwords library when available
  - `keyword_match_score()` - Added metadata field weighting and fuzzy matching
  - `apply_keyword_rerank()` - Now passes metadata for structured scoring
  - `get_default_cube_id()` - Uses enhanced path detection
  - Backward compatible: Falls back to basic implementation if enhancer unavailable

### Technical Details

**Keyword Scoring Algorithm:**
```
Final Score = base_relativity + keyword_bonus

Where keyword_bonus =
  + 5.0 × (matches in key field)
  + 3.0 × (matches in tags)
  + 2.5 × (exact word boundary matches)
  + 1.5 × (substring matches)
  + 1.0 × similarity (fuzzy matches above threshold)
  + 1.5 × (matched_count / total_keywords)
```

**Fuzzy Matching Example:**
```
Query: "configration error"
Text: "Configuration error in database"

Levenshtein distance("configration", "configuration") = 1
Similarity = 1 - (1/13) = 0.92 > 0.75 threshold
→ Match found with 0.92 score bonus
```

### Fixed

- **🔧 Import Error: parse_json_result and detect_lang** (`mem_reader/utils.py`, `retrieve_utils.py`)
  - **Issue**: `ImportError: cannot import name 'parse_json_result' from 'memos.mem_reader.utils'`
  - **Root Cause**: Functions were defined in `read_multi_modal/utils.py` but imported from parent modules
  - **Fix**: Added re-exports in `memos/mem_reader/utils.py` and `retrieve/retrieve_utils.py`
  - **Impact**: API startup and all memory operations now work correctly

---

### Added

- **🔗 Graph API Endpoints** (start_api.py)
  - **`/graph/trace_path`**: Trace causality paths between two memory nodes (supports max_depth up to 10 hops)
  - **`/graph/schema`**: Export knowledge graph statistics including node/edge counts, relationship distribution, tag frequency, health metrics
  - **`/search` enhancement**: Added `enable_context_analysis` and `chat_history` parameters for LLM-powered context-aware search

- **🧠 New MCP Tools** (memos_mcp_server.py)
  - **`memos_export_schema`**: Export graph structure with health assessment (orphan ratio, connectivity)
  - **`memos_search_context`**: Context-aware search using conversation history for smarter results
  - **`memos_trace_path`**: Trace reasoning paths between memories to understand causality chains

- **🔒 智能项目感知 (Smart Project Awareness)** (project-memory/SKILL.md, memos_mcp_server.py)
  - **Auto-Derivation**: Claude skills now automatically derive `cube_id` from the project directory name (e.g., `MemOS` -> `memos_cube`).
  - **Zero-Config Isolation**: Users only need to copy the skill to `.claude/skills/` to enable isolated memory space for any project.
  - **Mandatory Triggers**: Updated `SKILL.md` with strict rules for when AI MUST use `memos_search` or `memos_get_graph`.
  - **Deployment Docs**: Added step-by-step guides for deploying Claude skills in both English and Chinese READMEs.

- **📊 Enhanced MCP Server Tools** (memos_mcp_server.py)
  - **Mermaid Graph Support**: `memos_get_graph` now generates Mermaid diagrams for visual relationship exploration.
  - **Smart Filtering**: `memos_list` now supports `memory_type` filtering (e.g., list only DECISIONS or ERRORS).
  - **Memory Statistics**: New tool `memos_get_stats` to show memory distribution by type in a cube.
  - **Improved Display**: Search results are now grouped by memory type with automatic code block detection.
  - **Robust Registration**: Enhanced auto-registration logic with forced retry on tool call failure.

### Fixed

- **🔧 Neo4j Cypher Query Syntax** (neo4j.py)
  - **Issue**: `get_schema_statistics()` generated invalid Cypher with duplicate WHERE clauses
  - **Root Cause**: When `user_clause` existed, queries like tag_query and time_query had `WHERE ... WHERE ...`
  - **Fix**: Use conditional WHERE/AND logic to avoid duplicate WHERE clauses
  - **Impact**: `memos_export_schema` now works correctly for multi-tenant mode

- **🔧 MCP Server Robustness & Save Failures** (memos_mcp_server.py)
  - **Issue**: Encountered 502 (Bad Gateway) and 400 (Cube not loaded) errors during memory saving.
  - **Path Healing**: Optimized `ensure_cube_registered` to correctly resolve physical paths for default cubes (e.g., `dev_cube`).
  - **Aggressive Retry**: Implemented automatic cache clearing and re-registration retry logic for `memos_search`, `memos_get_stats`, and `memos_get_graph`.
  - **Reliability**: Server now automatically recovers from backend restarts or cube unloads without user intervention.

- **🔧 MCP Search Result ID Truncation** (memos_mcp_server.py)
  - **Root Cause**: Search results showed truncated IDs (`4a7ddcf7...`) but Neo4j requires full UUID for deletion
  - **Fix**: `format_memories_for_display()` and `memos_get_graph` now return complete UUIDs
  - **Impact**: `memos_delete` can now correctly delete memories using IDs from search results
  - Collaboration: Claude Opus + Gemini (API endpoint fix + multi-DB sync verification)

- **🔧 WSL Environment Variable Passing** (run_mcp.sh, memos_mcp_server.py)
  - **Issue**: Claude Code's `env` config doesn't pass through to Windows Python via WSL bash
  - **Fix**: Added CLI argument parsing (`--memos-enable-delete`, etc.) as fallback
  - **Default**: `MEMOS_ENABLE_DELETE=true` for dev environment in run_mcp.sh
  - All timeout and config variables now support both env vars and CLI args

- **📊 README Architecture Diagrams Update** (README.md)
  - Updated main architecture diagram with complete `tree_text` mode data flow
  - Added **Memory Save Flow**: LLM Extraction → Neo4j + Qdrant → Reorganizer (async)
  - Added **Memory Search Flow**: Qdrant semantic + Neo4j graph traverse → merged results
  - Added **LLM Usage Summary**: Dual LLM use (extraction + relationship detection)
  - Updated Privacy Architecture to include Neo4j local storage
  - Updated MCP tools table: 8 tools (added `memos_list_v2`, `memos_get_stats`, `memos_delete`)

- **🗑️ Memory Deletion & Synchronization Optimization**
  - **API Correction**: Fixed memory deletion endpoint format to `/memories/{mem_cube_id}/{memory_id}` to resolve 500 errors.
  - **Multi-DB Sync**: Verified end-to-end deletion sync across MemCube list, Qdrant (Vector DB), and Neo4j (Graph DB).
  - **Graph Integrity**: Confirmed Neo4j `DETACH DELETE` logic correctly removes nodes and all associated relationships/edges.
  - **Verification Suite**: Developed `verify_mems.py` for automated cross-database deletion verification.
  - **MCP Tool Safety**: Validated `memos_delete` tool with `MEMOS_ENABLE_DELETE` safety flag and batch deletion (`memory_ids`) support.

- **🔗 Knowledge Graph Relationship Query** (NEW - memos_get_graph)
  - New MCP tool `memos_get_graph` for querying memory relationships
  - Returns CAUSE, RELATE, CONFLICT, CONDITION relationships from Neo4j
  - Direct Neo4j HTTP API integration for relationship queries
  - Example: Query "Neo4j" shows `[Java 17 required] ──CAUSE──> [Neo4j startup failed]`
  - Updated SKILL.md with trigger rules for dependency queries
  - Triggers: "依赖关系", "root cause", "为什么失败", "冲突", "关联"

- **📝 MCP Configuration Examples** (README.md)
  - Added `alwaysAllow` array examples for automatic tool invocation
  - Includes all 5 MCP tools: `memos_search`, `memos_save`, `memos_list`, `memos_suggest`, `memos_get_graph`
  - Added examples for both WSL and pure Windows environments
  - Added Chinese MCP configuration section with full example

- **📄 CLAUDE.md Project Context** (NEW)
  - Created `CLAUDE.md` for project-specific Claude Code context
  - Includes: Memory system behaviors, memory types, configuration, key files
  - Claude reads this at conversation start for better context awareness
  - Added documentation links in README

- **🪝 Claude Code Hooks System** (NEW)
  - Created `.claude/hooks/` directory with 4 hook scripts:
    - `memos_user_prompt.sh` - Confirms memory system active on user input
    - `memos_block_sensitive.sh` - Warns when editing .env/credentials
    - `memos_log_commands.sh` - Logs bash commands to history file
    - `memos_notify_milestone.sh` - Suggests saving milestones for important files
  - Added `.claude/settings.json` with hooks configuration
  - Added `.claude/hooks/README.md` with usage documentation

- **🎬 Cross-Project Memory Demo** (README.md)
  - Added "Scenario 3: Cross-Project Memory Retrieval" with real demo
  - Shows AI searching MemOS memories from different project (DDSP-SVC)
  - Screenshots archived at `docs/ScreenShot/`

- **📊 Optimization Plan v2.0** (`.memos/优化方案.md`)
  - Updated with verification results
  - Architecture evolution diagram (v0.1 → v0.4)
  - Success metrics and next steps

- **🔒 Privacy-First Architecture Section** (README.md)
  - Added visual architecture diagram showing data flow
  - Highlights that original text stays local (Ollama embedding)
  - Only numerical vectors uploaded to Qdrant Cloud
  - Comparison table: "What Stays Local" vs "What Goes to Cloud"
  - Added corresponding Chinese version in 中文文档 section

- **🧠 Neo4j Knowledge Graph Memory Mode** (v0.4.0 preview)
  - Upgraded from `general_text` to `tree_text` memory backend
  - Added Neo4j Community Edition support for graph storage
  - Memory nodes now include: key, memory, background, tags, confidence
  - Dual storage: WorkingMemory + LongTermMemory
  - LLM-powered memory extraction (auto tags, key extraction)
  - Visual graph exploration via Neo4j Browser
  - Configuration: `dev_cube/config.json` with `tree_text` backend

### Fixed

- **🔧 MCP Cube Registration LLM Trigger** (reorganizer.py)
  - Fixed unnecessary LLM calls when loading existing cube
  - Changed `_reorganize_needed` initial value from `True` to `False`
  - Reorganizer now only triggers when new memories are actually added
  - Before: Every `init_from_dir()` → immediate LLM cluster/summarize call
  - After: LLM only called after `handle_add()` processes new nodes
  - Significantly reduces API costs and startup time

- **🔧 Relationship Detection Parser**
  - Fixed `_parse_relation_result()` to extract only first word from LLM response
  - LLM returns `RELATE\n\n**Reasoning:**...` but parser expected single word
  - Now correctly detects CAUSE, RELATE, CONFLICT, CONDITION relationships

- **🔧 Neo4j SourceMessage Serialization**
  - Fixed `build_summary_parent_node()` returning `SourceMessage` objects
  - Neo4j packstream doesn't support custom Python objects
  - Changed to return serializable dicts instead

- **🔧 Neo4jCommunityGraphDB Compatibility**
  - Added missing `status` and `user_name_flag` parameters to `get_by_metadata()`
  - Fixed search API 500 error when using tree_text mode with Neo4j Community Edition

### Changed

- **⚙️ Reorganizer Configuration**
  - Added `MOS_REORGANIZE_MIN_GROUP` env var (default: 10, was hardcoded 20)
  - Added `MOS_REORGANIZE_TIMEOUT` env var (default: 1800s for slow LLM APIs)
  - Allows relationship detection to trigger with fewer candidate nodes

- **📝 SKILL.md Updates**
  - Added `memos_get_graph` to Quick Reference table
  - Added "When to Get Graph" trigger rules section
  - Updated workflow diagram with dependency checking flows

- **📝 README.md Major Update**
  - Added "Two Memory Modes" comparison table
  - Updated architecture diagram showing Neo4j + Qdrant dual storage
  - Added "Knowledge Graph Memory Mode" section with setup guide
  - Added "Enhance with CLAUDE.md" section
  - Updated Requirements table with Neo4j
  - Added Neo4j badge and related link
  - Updated Chinese documentation section

- **📝 Enhanced .env Documentation**
  - Added detailed comments explaining LLM usage in tree_text mode
  - LLM is used for: memory extraction (key, tags, background), confidence scoring, memory categorization
  - Updated `docker/.env.example` with tree_text mode documentation

## [0.3.2] - 2026-01-26

### Changed

- **📝 Simplified SKILL.md** - Refactored from 769 lines to 237 lines
  - Now focuses on **MCP tool usage** instead of script execution
  - Removed detailed CLI script documentation (kept as "Legacy Scripts")
  - Added quick reference table for MCP tools
  - Added clear workflow diagram for MCP-based memory management
  - Kept memory type format templates (ERROR_PATTERN, DECISION, etc.)

- **📦 Archived Legacy Scripts** - Moved to `scripts/legacy/`
  - `memos_init_project.py` → Replaced by MCP auto-registration
  - `memos_save.py` → Replaced by `memos_save` MCP tool
  - `memos_search.py` → Replaced by `memos_search` MCP tool
  - Kept `memos_utils.py` in main scripts folder (utility functions)
  - Added `legacy/README.md` explaining archive reason

### Technical Details

**Old Architecture (Script-based):**
```
User → /project-memory → SKILL.md → Execute Python scripts → API
```

**New Architecture (MCP-powered):**
```
User → /project-memory → SKILL.md → Guide to use MCP tools → MCP Server → API
```

**New Directory Structure:**
```
.claude/skills/project-memory/
├── SKILL.md              # MCP usage guide (237 lines)
└── scripts/
    ├── memos_utils.py    # Utility functions (kept)
    └── legacy/           # Archived scripts
        ├── README.md
        ├── memos_init_project.py
        ├── memos_save.py
        └── memos_search.py
```

**Benefits:**
- Unified interface: MCP handles all memory operations
- Auto-registration: No need to run init scripts
- Simpler maintenance: One codebase (MCP Server) instead of two
- Better UX: AI uses tools directly without shell execution

---

## [0.3.1] - 2026-01-26

### Added

- **🔄 Auto-Register Cube** (`mcp-server/memos_mcp_server.py`)
  - MCP tools now automatically register cubes on first use
  - No more manual `curl` commands needed to create cubes
  - Added `ensure_cube_registered()` unified function
  - Added `_registered_cubes` cache to avoid repeated registration attempts

- **New Environment Variable** `MEMOS_CUBES_DIR`
  - Configurable cube storage directory
  - Default: `G:/test/MemOS/data/memos_cubes`
  - Used for auto-registration path

### Changed

- **Simplified `memos_save`** - Removed duplicate registration logic, now uses shared function
- **Updated `run_mcp.sh`** - Added `MEMOS_CUBES_DIR` export

---

## [0.3.0] - 2026-01-26

### Added

- **🚀 MCP Server for Proactive Memory** (`mcp-server/`)
  - New MCP (Model Context Protocol) Server enabling Claude Code to **proactively** use memory functions
  - No longer need to wait for user to manually call `/project-memory` commands
  - AI can now automatically search memories when encountering errors or making decisions

- **MCP Tools** (`mcp-server/memos_mcp_server.py`)
  - `memos_search` - Search project memories with intelligent triggers
    - Auto-triggers when: encountering errors, user says "之前/上次", modifying code
    - Searches: `ERROR_PATTERN`, `DECISION`, `GOTCHA`, `CODE_PATTERN`, `CONFIG`
  - `memos_save` - Save memories with auto-type detection
    - Auto-triggers when: solving bugs, making decisions, completing tasks
    - Detects memory type from content keywords
  - `memos_list` - List all memories in a project cube
  - `memos_suggest` - Get smart search suggestions based on context

- **MCP Configuration Guide** (`docs/MCP_GUIDE.md`)
  - Complete setup instructions for Claude Code integration
  - Tool reference with parameters and examples
  - Troubleshooting guide
  - Architecture diagram

- **MCP Installation Tools** (`mcp-server/`)
  - `install.py` - Auto-configure Claude Code settings.json
  - `test_server.py` - Verify MCP server functionality
  - `pyproject.toml` - Package configuration for pip install
  - **`run_mcp.sh`** - WSL wrapper script for path translation

### Changed

- **Architecture**: Project now supports two integration modes
  - **Skill Mode (Passive)**: User manually calls `/project-memory` commands
  - **MCP Mode (Proactive)**: AI automatically uses memory tools when appropriate

- **Documentation Structure**: Updated to include MCP documentation
  - Added MCP Guide link to main README
  - Updated Quick Navigation table

### Fixed

- **🐛 WSL MCP Startup Failure** - Critical fix for MCP server not starting in WSL environment
  - **Problem**: Windows Python couldn't process WSL paths (`/mnt/g/...` → `G:\mnt\g\...`)
  - **Solution**: Added `run_mcp.sh` wrapper script that:
    - Uses WSL path to invoke Windows Python: `/mnt/g/.../python.exe`
    - Passes Windows-format path to script: `G:/test/.../script.py`
  - **Config Change**: Use `bash` as command with wrapper script as argument
    ```json
    "command": "bash",
    "args": ["/mnt/g/test/MemOS/mcp-server/run_mcp.sh"]
    ```

### Technical Details

**MCP Server Architecture:**
```
User Input -> Claude Code -> Context Analysis -> MCP Tool Decision
                                                       |
                            +-------------+------------+
                            |                          |
                            v                          v
                  memos_search (proactive)   memos_save (proactive)
                            |                          |
                            v                          v
                       MemOS API (:18000)         MemOS API
                            |                          |
                            v                          v
                  Embedding + Qdrant            Embedding + Qdrant
```

**WSL Path Translation (run_mcp.sh):**
```
Claude Code (WSL bash)
        | runs
        v
    run_mcp.sh
        | invokes (WSL path)
        v
    /mnt/g/.../python.exe
        | with (Windows path)
        v
    G:/test/.../memos_mcp_server.py
        | connects
        v
    MemOS API (localhost:18000)
```

**Proactive Trigger Scenarios:**

| Scenario | Tool Called | Search/Save Type |
|----------|-------------|------------------|
| Error encountered | `memos_search` | `ERROR_PATTERN {type}` |
| User says "之前" | `memos_search` | Related history |
| Code modification | `memos_search` | `GOTCHA`, `CODE_PATTERN` |
| Bug solved | `memos_save` | `ERROR_PATTERN` |
| Decision made | `memos_save` | `DECISION` |
| Task completed | `memos_save` | `MILESTONE` |

---

## [0.2.0] - 2026-01-26

### Added

- **Environment variable priority for cube configs** (`src/memos/mem_cube/utils.py`, `general.py`)
  - New `apply_env_overrides()` function that applies .env settings to cube configs
  - Ensures .env takes priority over hardcoded config.json values
  - Supports all key configurations:
    - Qdrant: `QDRANT_URL`, `QDRANT_HOST`, `QDRANT_PORT`, `QDRANT_API_KEY`, `QDRANT_PATH`
    - Embedder: `MOS_EMBEDDER_BACKEND`, `MOS_EMBEDDER_MODEL`, `OLLAMA_API_BASE`
    - LLM: `MOS_CHAT_MODEL`, `OPENAI_API_KEY`, `OPENAI_API_BASE`, `MOS_CHAT_TEMPERATURE`
  - Logs all overrides for debugging: `[ENV Override] Qdrant URL: xxx -> yyy`

- **Cube ID resolution and caching** (`.claude/skills/project-memory/scripts/memos_utils.py`)
  - `resolve_cube_id()` - Maps project names to full cube paths automatically
  - `load_cube_cache()`, `save_cube_cache()`, `update_cube_cache()` - Persistent cache management
  - `get_registered_cubes()` - Query API for all registered cubes
  - Cache stored at `~/.memos_cube_cache.json`

- **Comprehensive troubleshooting guide** (`.claude/skills/project-memory/SKILL.md`)
  - Cube ID format issues and solutions
  - WSL path recognition problems
  - API connection errors
  - HuggingFace clone errors
  - Qdrant connection priority
  - Debug mode instructions

- **Cross-platform path utilities** (`src/memos/mem_cube/utils.py`)
  - `is_valid_huggingface_repo()` - Validates HuggingFace repository name format
  - `normalize_path()` - Normalizes paths across Windows/Linux/WSL
  - `path_exists()` - Cross-platform path existence check
  - `looks_like_local_path()` - Detects if string looks like a file path
  - `get_wsl_distro_name()` - Detects current WSL distribution name

- **WSL to Windows UNC path conversion**
  - `/home/user/...` paths now convert to `\\wsl$\Ubuntu\home\user\...` on Windows
  - Automatically tries common distro names (Ubuntu-24.04, Ubuntu-22.04, etc.)

- **Enhanced error messages** for cube registration failures
  - Clear distinction between local path errors and HuggingFace repo errors
  - Specific guidance for WSL path issues when running MemOS on Windows
  - Helpful suggestions for resolving common issues

- **Error pattern documentation** (`docs/ERROR_PATTERN_2026-01-25_HuggingFace_Qdrant_WSL.md`)
  - Detailed bug analysis and solutions for future reference

### Changed

- **Unified configuration via .env** - All infrastructure configs now use environment variables
  - Config priority: `.env` > `config.json` > code defaults
  - Single source of truth for Qdrant, Embedder, LLM settings

- **Improved project-memory skill scripts** (`.claude/skills/project-memory/scripts/`)
  - `memos_save.py`: Now auto-resolves cube names to full paths before API calls
  - `memos_search.py`: Now auto-resolves cube names to full paths before API calls
  - `memos_init_project.py`: Caches cube ID mapping after successful registration
  - All scripts now provide better error messages and hints
  - Default embedder model updated to `nomic-embed-text-v2-moe:latest`

- **Improved cube registration logic** (`core.py`, `product.py`)
  - No longer incorrectly treats local paths as HuggingFace repository names
  - WSL paths (`/mnt/c/...`) now properly converted to Windows paths when needed
  - Windows paths (`C:\...`) now properly converted to WSL paths when needed

### Fixed

- **Critical Bug**: Cube registration no longer attempts `git clone` for invalid inputs
  - Previously: Any non-existent path would trigger a HuggingFace clone attempt
  - Now: Only valid `username/repo-name` format triggers remote clone
  - Example: `DDSP-SVC-6.3` no longer becomes `https://huggingface.co/datasets/DDSP-SVC-6.3`

- **WSL Path Handling**: Fixed path recognition in WSL environment
  - `/mnt/g/test/project` now correctly detected as local path on Windows
  - Automatic path format conversion between WSL and Windows

- **Qdrant Cloud Priority Bug**: Fixed config loading when both local and cloud settings exist
  - Previously: `QDRANT_HOST=localhost` would override `QDRANT_URL` in some code paths
  - Now: If `QDRANT_URL` is set, `host` and `port` are automatically set to `None`
  - This ensures cloud database is used when configured

- **Cube ID Format Issue**: Scripts now auto-resolve project names to full paths
  - Previously: Had to manually use full paths like `G:/test/MemOS/data/memos_cubes/dev_cube`
  - Now: Just use `dev_cube` and it auto-resolves

- **Embedder Backend Validation**: Fixed env override applying wrong fields to Ollama backend
  - Only applies `api_base` for Ollama
  - Only applies `base_url`, `api_key`, `provider` for universal_api

- **Pydantic Serialization Warning**: Fixed type annotation in `ParserConfigFactory`
  - `config` field now correctly typed as `Union[dict, BaseParserConfig]`
  - Eliminates `PydanticSerializationUnexpectedValue` warning

- **Startup Warnings**: Suppressed harmless warnings during API startup
  - PyTorch/TensorFlow not found (not needed when using Ollama)
  - Pydantic serialization warnings for known edge cases

### Security

- Added validation to prevent arbitrary git clone commands from untrusted input

---

## Version History

### Path Handling Fix (2026-01-25)

**Problem:**
When registering a memory cube, the system would incorrectly interpret:
1. Simple names like `DDSP-SVC-6.3` as HuggingFace repos
2. WSL paths like `/mnt/f/CyberAI/SVC/project` as HuggingFace repos

This caused `git clone` failures with cryptic error messages.

**Root Cause:**
```python
# OLD CODE (problematic)
if os.path.exists(mem_cube_name_or_path):
    # Load from local
else:
    # ALWAYS try HuggingFace - even for invalid inputs!
    GeneralMemCube.init_from_remote_repo(mem_cube_name_or_path)
```

**Solution:**
```python
# NEW CODE (robust)
if actual_path_exists:
    # Load from local (with cross-platform normalization)
elif is_valid_huggingface_repo(name):
    # Only clone if valid HF format: username/repo-name
elif looks_like_local_path(name):
    raise FileNotFoundError("Path does not exist...")
else:
    raise ValueError("Not a valid path or HF repo...")
```

**Files Modified:**
- `src/memos/mem_cube/utils.py` - Added path utilities
- `src/memos/mem_os/core.py` - Updated registration logic
- `src/memos/mem_os/product.py` - Updated registration logic

---

## Contributing

When adding entries to this changelog:
1. Add under `[Unreleased]` section
2. Use categories: Added, Changed, Deprecated, Removed, Fixed, Security
3. Include file paths when relevant
4. Explain the "why" not just the "what"

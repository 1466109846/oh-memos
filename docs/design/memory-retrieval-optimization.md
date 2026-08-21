# 记忆质量与检索优化设计

> 状态：设计 + P0/P1 已实施
> 日期：2026-08-21
> 范围：`mcp-server-node/src/memory-quality.ts` 检索排序、衰减与巩固机制

---

## 1. 背景

本文档源自一次针对「LLM agent 能否像人脑那样记忆」的文献调研，以及随后对 oh-memos
现有实现的对照审计。调研结论与本项目的直接相关点：

- **注意力机制本身等价于全息联想检索**（Ramsauer et al., *Hopfield Networks is All
  You Need*）。现代 Hopfield 网络的更新规则与 Transformer 注意力等价，能存指数级模式、
  一次更新完成检索。所以「自动联想」能力在 LLM 里并不缺失。
- **全息叠加的瓶颈是容量与干扰**（arXiv 2606.24948）。把记忆叠加进单一向量时，
  多跳组合会失败，且干扰在单跳时就已存在；改 cleanup 机制救不回来。
- **因此主流 agent 记忆系统选择局部化（localist）存储 + 显式检索**，代价是不够「像大脑」，
  收益是容量可控、可删除、可审计。oh-memos 走的正是这条路（Qdrant + Neo4j，一条记忆一条
  record，`memos_delete` 可精确删除）。全息架构无法实现「删掉这一条记忆」。
- **前沿方向是双系统**（Complementary Learning Systems）：慢的一半固化为参数，
  快的一半保持显式检索。参见 UniMem（arXiv 2607.26017）的 episodic→parametric 自路由、
  eMEM（arXiv 2606.03374）的海马-新皮层巩固流程。

本项目的可优化空间不在「换成全息架构」，而在**把 localist 路线该有的机制补全**：
衰减、强化、语义级去重、巩固。

---

## 2. 现状盘点

审计基于 jCodemunch 索引（6298 符号 / 623 文件）与主工作树实读，已排除
`.claude/worktrees/` 下的历史副本。

### 2.1 已落地（无需重做）

| 机制 | 位置 | 说明 |
|---|---|---|
| TTL 自动归档 | `src/oh_memos/mem_scheduler/archiver.py`（243 行） | `archive_expired_memories_sync` / `get_archive_stats_sync` / `restore_archived_memory_sync` / `periodic_archive_task`，已由 `start_api.py:329 startup_archiver()` 接入 |
| 归档配置 | `.env.example:42-44`、`docker/.env.docker.example`、`docker/.env.host-db.example` | `MEMOS_ARCHIVE_TTL_DAYS=7` / `MEMOS_ARCHIVE_INTERVAL=3600` / `MEMOS_ARCHIVE_TYPES=PROGRESS` |
| status 过滤 | `memory-quality.ts:37` | 非 `activated` 记忆打 0.25 惩罚 |
| RRF 融合 | `src/oh_memos/reranker/rrf.py` | 标准 `1/(k+rank)` |
| 文本级去重 | `searcher.py:711 _deduplicate_results` | 按 `item.memory` 精确匹配 |
| 图去重/合并 | `neo4j.py:1677 deduplicate_nodes` / `1692 merge_nodes`（nebular/polardb 同构） | |
| LLM 记忆合并 | `templates/mem_reader_prompts.py MEMORY_MERGE_PROMPT_EN` | |
| MinHash 语义去重 | `prefer_text_memory/utils.py:50 deduplicate_preferences` | **仅用于 preference，未用于主检索** |
| 证据包 + 缺口分析 | `mcp-server-node/src/handlers/think.ts` | `memos_think` 已标记矛盾/过期候选 |
| 评测脚手架 | `evaluation/scripts/locomo/`、`evaluation/scripts/longmemeval/` | **存在但未用于 `memoryQualityScore`** |

### 2.2 确认缺失

全主工作树 grep（`src/` + `mcp-server-node/src/`，排除测试）：

- `decay|half_life|halflife|forget|evict` → **仅 1 处命中**，是
  `monitor_event_utils.py:39` 注释里的 "fire-and-forget"，与记忆衰减无关。
- `access_count|last_accessed|usage_count|hit_count` → **0 命中**。

---

## 3. 核心问题：freshness 几乎不衰减

`memory-quality.ts:30-44` 是全部排序逻辑：

```ts
const semantic   = clamp01(m.relativity ?? 0.5);
const confidence = m.confidence === undefined ? 0.7 : clamp01(m.confidence);
const freshness  = age === null ? 1 : Math.max(0.55, 1 - age / 3650);
const baseScore  = semantic * 0.55 + confidence * 0.2 + freshness * 0.1
                 + progressPenalty * 0.05 + autoPenalty * 0.05 + statusPenalty * 0.05;
```

三个独立缺陷：

**缺陷 A — 衰减曲线形同虚设。** `1 - age/3650` 下限 0.55，意味着**十年才衰减 45%，
且永不归零**。又因 freshness 只占 0.1 权重，一年的时间差在总分里只值 **0.0027**
（1/3650 × 0.1 × 365）。远小于 `confidence` 字段的一次抖动。实际效果等于不衰减。

**缺陷 B — 所有 memory_type 共用一条曲线。** `CONFIG` 记忆（配置会变，半年前的
端口号可能已失效）与 `DECISION`/`GOTCHA`（原理性，多年有效）以同一速率衰减。
这是明显的建模不足。

**缺陷 C — 无访问强化。** 检索命中不改变任何状态。一条被反复命中的高价值记忆
与一条从未被用过的记忆，排序上完全等价。ACT-R 的 base-level activation
（`ln Σ tᵢ^-d`）正是为解决这个问题设计的，而 DSHM（Dynamically Structured
Holographic Memory）这条认知架构脉络就建立在 ACT-R 之上。

**次要问题 — `semantic` 的 0.5 默认值有风险。** 当 `relativity` 缺失时，
一条完全不相关的记忆拿到中位分（0.5 × 0.55 = 0.275），靠 confidence 默认 0.7
就能凑到 0.415 进入 top_k。缺失应当是惩罚而非中性。

---

## 4. 优先级与理由

| 级别 | 项目 | 理由 | 状态 |
|---|---|---|---|
| **P0** | 建立 `memoryQualityScore` 评测基准 | 所有后续调参的前提。当前 4 项测试全是行为断言，无一验证权重组合本身，改权重等于盲改 | 已实施 |
| **P1** | 按类型分档的指数衰减 + 访问强化 | 记忆库随使用单调增长，不衰减 → 检索质量确定性劣化。这是当前架构下唯一会随时间恶化的部分 | 衰减已实施；强化已接入但休眠（见 6.4） |
| **P1.5** | access_count 写入方 | 强化项的前置条件；不做则 0.06 权重是死重 | 已实施（本地侧车） |
| **P2** | 近重复折叠替换文本精确去重 | 措辞略异的同义记忆会全部返回、挤占 top_k 预算 | 已实施 |
| **P3** | 离线巩固 pipeline | 见第 8 节 —— 按原设想做交付不了声称的价值 | 已撤回 |
| **P4** | 图扩散联想（spreading activation） | 需先量化 Neo4j 边精度，依赖跑起来的实例 | 阻塞 |

P0 必须先于 P1：没有基准，衰减曲线的参数选择无法验证。

---

## 5. P0 — 评测基准

### 目标

让权重与衰减参数的修改可测量，而非依赖直觉。

### 方案

新增 `mcp-server-node/src/memory-quality-baseline.test.ts`，包含三类断言：

1. **固定语料的期望排序**。构造覆盖各 `memory_type`、各年龄段、各 confidence
   区间的记忆集合，断言关键的成对顺序关系（`expectRankedBefore(a, b)`）而非
   完整序列 —— 后者过脆，任何权重微调都会破坏。

2. **权重敏感度（mutation 验证）**。断言当某一维度单独变化时，排序**必须**改变。
   这能捕获「某项权重实际未生效」的静默失效 —— 正是项目记忆里 hooks matcher
   那类缺陷的同构问题。

3. **不变量**。分数恒在 `[0, 1]`；过期记忆恒排在同等条件的未过期记忆之后；
   `activated` 恒优于 `archived`。

### 验收

- [x] 基准测试独立于 `memory-quality.test.ts`，不修改既有 4 项断言
- [x] 每条衰减/权重断言都做过 mutation 验证（改坏实现 → 精确失败预期项数）
- [x] 全量 vitest 通过

### 实施结果

新增 `mcp-server-node/src/memory-quality-baseline.test.ts`，19 项（P1 后扩到 36 项）。

**mutation 验证记录**（改坏实现 → 精确失败项）：

| 变异 | 失败项 |
|---|---|
| `semantic * 0.55` → `* 0.50` | 1 —— 权重和守卫 |
| `freshness` 恒为 1 | 2 —— 时间敏感度、created_at 回退 |
| 撤销 NaN 守卫 | 1 —— 脏输入不产生 NaN |
| auto-capture 惩罚失效 | 1 —— 人工记忆优于 auto-capture |

### P0 顺带发现的缺陷：clamp 不防 NaN

原实现 `Math.max(0, Math.min(1, Number(x)))` **不防 NaN** ——
`Math.min(1, NaN)` 是 `NaN`，`Math.max(0, NaN)` 还是 `NaN`。
后果：`confidence` 传成非数值字符串时 `quality_score` 变为 `NaN`，排序行为不可预测
（`NaN` 参与比较恒为 false，节点位置取决于原始数组顺序）。

已修为显式 `Number.isFinite` 守卫 + fallback。这个缺陷是基准测试建起来后立刻暴露的，
属于 P0 的直接收益。

---

## 6. P1 — 指数衰减与访问强化

### 6.1 按类型分档的半衰期

替换 `1 - age/3650` 为指数衰减 `0.5^(age/halfLife)`，半衰期按类型分档：

| memory_type | 半衰期 | 理由 |
|---|---|---|
| `PROGRESS` | 14 天 | 纯进度汇报，时效性最强；已有 7 天 TTL 归档兜底 |
| `CONFIG` | 180 天 | 配置会变，端口/路径/版本号会过时 |
| `ERROR_PATTERN` / `BUGFIX` | 365 天 | 与代码版本绑定，代码演进后可能不再适用 |
| `FEATURE` / `MILESTONE` | 540 天 | 事实性记录，但会被后续里程碑取代 |
| `DECISION` / `GOTCHA` / `CODE_PATTERN` | 1095 天 | 原理性知识，衰减最慢 |
| `SYNTHESIS` | 1095 天 | 巩固产物，与原理性知识同档 |
| 未知/缺失 | 365 天 | 中位保守值 |

设 floor 0.05 而非 0.55 —— 允许充分衰减，但不归零（保留被强化唤回的可能）。

同时把 freshness 权重从 0.1 提到 0.14，让衰减真正影响排序。

### 6.2 访问强化

新增两个可选 metadata 字段，缺失时行为与现在完全一致（向后兼容）：

- `access_count: number` — 被检索命中的累计次数
- `last_accessed_at: string` — 最近一次命中的 ISO 时间

强化项采用对数饱和，避免高频记忆垄断：

```
reinforcement = min(1, ln(1 + access_count) / ln(1 + 20))
```

20 次命中达到满值。取 0.06 权重，从 `progressPenalty`/`autoPenalty`/`statusPenalty`
三项中各让出一部分（这三项本质是惩罚开关，0.05 的权重偏高）。

**last_accessed_at 参与衰减计算**：age 取 `min(ageSinceUpdate, ageSinceAccess)`，
即近期被访问过的记忆按访问时间算「新鲜度」。这是 ACT-R base-level activation
的简化形式，也是「用则强化，不用则衰减」的直接实现。

### 6.3 semantic 缺失改为惩罚

`relativity` 缺失时从 0.5 降到 0.35。保守调整 —— 直接降到 0 会让缺字段的
历史记忆全部沉底，属于破坏性变更。

### 6.4 访问强化：本地侧车（P1.5，已实施）

`mcp-server-node/src/access-tracker.ts`。

**绕开了「必须回写记忆存储」这个前提。** 下面列的四个顾虑全部源自那个前提，
一旦改成本地侧车日志就同时消失：

| 原顾虑 | 侧车方案下 |
|---|---|
| 检索从只读变读写 | 不碰记忆存储；记账发生在 `memos_get`，且 fire-and-forget |
| Full 模式需要不存在的后端端点 | 侧车是本机文件，Full / Lite 行为一致 |
| Lite 模式要重写 JSONL、与 `withLock` 抢锁 | 只追加不读改写，不与锁交互 |
| 写放大 | 单次 append 载荷 < 4 KB（POSIX 与 Windows 均为原子写），无需加锁 |

语义上也更诚实：**访问次数是本机使用度，不是全局真相。** 同一条记忆在别的机器上
被读过多少次，与本机排序无关。

#### 只在 memos_get 记账，不在 search 记账

若「出现在检索结果里」就记账，会形成**正反馈回路**：高分记忆更常被返回 →
拿到更多计数 → 分数更高 → 更常被返回。富者愈富，新记忆永远追不上。

`memos_get(memory_id=...)` 是**明确的选择性读取** —— agent 从候选里挑了这一条看全文。
它不参与排序输入，因此不构成回路。信号更稀疏但无偏。

#### 存储格式

`<cubesDir>/<cubeId>/access-log.jsonl`，两种行：

```
{"t":"<iso>","ids":["a","b"]}                  一次访问事件
{"t":"<iso>","snapshot":{"a":[3,"<iso>"]}}     压实后的快照
```

超过 500 行压实成单行快照（写 `.tmp` 再 `rename`，同文件系统内原子），
把增长界定在**去重记忆数**而非累计访问数。两个进程同时压实时后者胜出，
可能丢几条刚追加的访问 —— 对软数据可接受，换来日志大小有界。

坏行**静默跳过**：并发追加理论上可能撕裂一行，跳过让日志自愈；
抛异常会让一个坏字节永久废掉整份使用度数据。

#### 优先级与可观测性

记录里已有的 `access_count` **优先于侧车** —— 后端将来若自行提供该字段，
它比本机侧车更权威。

检索期注解统一由 `formatters.ts` 的 `memoryAnnotations()` 生成，
附在 ID 行后。详见第 9.5 节 —— 它同时修掉了 P2 遗留的一个缺陷。

#### 接线点

`handlers/search.ts` 的 `qualityOptions(cubeId, query)` 集中构造策略选项，
四条检索路径（Lite / Full / context-search / fallback）共用。
此前是同一段选项表达式复制四遍，改一处漏三处的风险很高。

`handlers/memory.ts` 的 `handleMemosGet` 在两条路径（local / API）各记一次账，
且**只在确实取到记忆后**记 —— 未命中的 id 不构成使用度信号。

#### 变异验证暴露的覆盖漏洞

单测无法触达 handler 层。变异确认：切断
`qualityOptions` 里的 `accessStats`（W3）或 `memos_get` 的 `recordAccess`（W4）后，
**全部 289 项 vitest 依然通过**。

补在 lite smoke 上（它驱动真实 MCP server 走 JSON-RPC），新增 5 项检查。
**第一版 smoke 断言是空的**：写成
`/access_count/.test(out) || out.includes("Lite mode persists")`，
第二个条件恒真 → W3 照样通过。收紧成只认 `access_count 1` 后两条变异都被抓住。

**教训：`||` 兜底的断言里，只要有一个分支恒真，整条断言就是装饰。**

### 实际权重表

| 维度 | 旧 | 新 | 说明 |
|---|---|---|---|
| semantic | 0.55 | 0.50 | 仍是最强信号 |
| confidence | 0.20 | 0.15 | LLM 赋值的主观信号，噪声高于客观量，让权更多 |
| freshness | 0.10 | **0.14** | 提权，让衰减真正影响排序 |
| reinforcement | — | **0.06** | 新增 |
| progressPenalty | 0.05 | 0.05 | **不动** |
| autoPenalty | 0.05 | 0.05 | **不动** |
| statusPenalty | 0.05 | 0.05 | **不动** |
| **合计** | 1.000 | **1.000** | 由「权重和守卫」断言（满分节点得分恰为 1.0） |

**惩罚项刻意不动。** 初版实现从三个惩罚项挪走了 0.05（0.15→0.10），
等于把 auto-capture 降权削弱了 33% —— 这是没被标出的静默行为变化。
惩罚项编码的是产品策略（auto-capture 不可信、archived 已退役），
不应因为新增信号而被稀释。已改为从 semantic 与 confidence 让出预算，
并新增三条「惩罚项强度守卫」断言把强度钉死。

另：权重和为 1 但浮点累加会得到 `1.0000000000000002`，越出 `[0,1]` 契约，
已在返回处加最终夹取。

`freshness` 的 floor 从 0.55 降到 0.05；`relativity` 缺失回退从 0.5 降到 0.35。

`freshness` **标签**（fresh/stale/expired）仍按 `updated_at` 判定，不计访问时间 ——
标签描述的是记录本身的年龄，与用于排序的有效年龄是两个概念。

### 验收

- [x] 新权重和为 1.0（满分节点得分恰为 1.0，含 `access_count: 20`）
- [x] 所有字段缺失时排序与旧实现一致（向后兼容）
- [x] 衰减曲线为指数形，连续三段落差比值均为 2（排除线性实现触底造成的假通过）
- [x] 各类型半衰期相对次序正确：PROGRESS > CONFIG > BUGFIX > MILESTONE > DECISION
- [x] 未知类型走 365 天保守默认档
- [x] 极老记忆触底但不归零，且衰减在总分里付出 ≥ 0.1 的实际代价
- [x] 旧 PROGRESS 不再压过新 GOTCHA
- [x] 访问强化对数饱和，20 次达满值，脏值不产生 NaN
- [x] 全量 vitest 236/236 通过；`tsc --noEmit` 干净
- [x] schema budget +0.0%，semantic snapshot 17 工具匹配
- [ ] access_count 写入方（P1.5，未定夺）

### 实施结果

**mutation 验证记录**：

| 变异 | 失败项 |
|---|---|
| 退回旧线性衰减 | 6 |
| 所有类型共用一条曲线 | 5 |
| 强化改为线性（去对数饱和） | 1 |
| 忽略 `last_accessed_at` | 1 |
| `relativity` 缺失回到中性 0.5 | 1 |
| 强化权重归零 | 3（含权重和守卫） |

写测试时有两项**假通过**，已修正后才进入实施：旧线性实现的 0.55 floor 在两个
半衰期处恰好凑出比值 2；floor 也让两个极老值相等。**只检验「触底」不足以
证明衰减有效** —— 必须同时要求衰减付出可观测的分数代价。

---

## 7. P2 — 近重复折叠

### 实施位置：node 层而非 Python searcher

`searcher.py:711` 的去重按 `item.memory` **精确匹配**，措辞略异的同义记忆
会全部返回、挤占 `top_k` 预算。

选择在 `applyMemoryQualityPolicy` 内部实现，而不是改 `searcher.py`：

- 该函数在 `handlers/search.ts` 有 **4 个调用点**（Lite / Full / context-search /
  fallback），选项完全相同 → 一处实现覆盖全部检索路径。
- `searcher.py` 只覆盖 Full 模式。
- node 层不需要起后端即可测试。

### 相似度用字符 n-gram，不用分词

**这是 CJK 场景的关键决定。** 本项目记忆以中文为主，中文没有词边界，
按空格分词会退化成「整段算一个 token」，Jaccard 恒为 0 或 1。
字符 4-gram 对中英文同时成立。

实测（`docs` 无法体现，见测试用例）：一条中文记忆的加粗/行内代码/全角空格/
大小写变体，归一化后 Jaccard 为 **1.0000**；去掉小写化则掉到 **0.4737**。
这说明归一化不是装饰，是判定能否成立的前提。

规模上不需要 MinHash：折叠在排序后对 top_k 量级的列表做，复杂度 O(n·k)。
`deduplicate_preferences` 的 MinHash 是为大批量准备的，这里用不上。

### 安全边界

| 规则 | 理由 |
|---|---|
| 阈值**按 memory_type 分档** | 见下表。维护者决定（2026-08-21）：不同类型对「措辞略异」的容忍度本质不同 |
| 不跨 `memory_type` 折叠 | 同一件事的 BUGFIX 与 DECISION 是不同产物 |
| 空正文永不参与折叠 | 否则所有缺 `memory` 字段的节点会被合成一条 |
| 短于 12 字符改用精确匹配 | n-gram 在极短串上不稳定，会把「端口 18000」和「端口 18010」判成近重复 |
| 折叠项 id 写入 `duplicates_folded` | 信息不丢，可用 `memos_get` 展开 |
| 无折叠时不写额外 metadata 键 | 不给每条结果塞噪声字段 |
| `dedupe: false` 可整体关闭 | |

### 阈值分档（`DEDUPE_THRESHOLD_BY_TYPE`）

| 阈值 | 类型 | 理由 |
|---|---|---|
| **0.70** 激进 | `PROGRESS` | 进度汇报本就重复，同一件事没必要都占 top_k |
| **0.78** 中等 | `MILESTONE` / `FEATURE` | 事实性记录 |
| **0.82** 现状 | `BUGFIX` / `ERROR_PATTERN` / `CONFIG` | 与代码/环境绑定，中间偏保守 |
| **0.88** 保守 | `DECISION` / `GOTCHA` / `CODE_PATTERN` / `SYNTHESIS` | 原理性内容差一个字可能差很多 |
| 0.82 兜底 | 未知/缺失类型 | 与改动前的单一阈值一致 |

实现上阈值从 `isNearDuplicate` 的必填参数改成 `override?`，按 `a.type` 取分档。
**安全的前提是该函数第一行就排除跨类型比较**，所以取 a 或 b 无差别。
`dedupeThreshold` 选项仍可覆盖全部分档，供调参与测试。

分档不会让任何类型比改动前更激进（除 `PROGRESS`）：`GOTCHA` 从 0.82 升到 0.88
是更保守，未知类型兜底值不变。

**保守仍是刻意的。** "seven days" vs "7 days" 的 Jaccard 约 0.79 —— 在
`DECISION`（0.88）下不折叠，在 `PROGRESS`（0.70）下折叠。这正是分档想要的
差别行为，测试用实测的三个 Jaccard 值（0.7547 / 0.8431 / 0.9400）钉住了各档边界。

### 验收

- [x] 近重复折叠，保留得分更高者（依赖折叠发生在排序之后）
- [x] 折叠 id 与计数写入 metadata；无折叠时不写
- [x] 不跨 `memory_type`；空正文与短文本按上表处理
- [x] 归一化覆盖 markdown / 空白（含全角）/ 标点 / 大小写
- [x] 折叠不改变保留项的 `quality_score`
- [x] 中文与英文近逐字重复都能折叠；改述不折叠
- [x] **分档生效**：同一对文本（J≈0.7547）标 `PROGRESS` 折叠、标 `DECISION` 不折叠
- [x] 11 个去重变异 + 5 个分档变异全部被捕获（含「退回单一阈值」）
- [x] 全量 394/394、两个 smoke 通过、schema budget +0.0%

---

## 8. P3 — 离线巩固 pipeline（按原设想撤回）

原设想对应 CLS 双系统与 eMEM 的海马-新皮层巩固流程：周期性扫记忆 → 聚类 →
LLM 提炼上位模式 → 写为 `SYNTHESIS`。

### 撤回理由：举的例子恰好证伪了方案

原文声称项目记忆里三条讲的是同一上位模式的不同侧面 —— CRLF 行尾坑、
hooks matcher 静默失效、批量替换改坏 URL，共同模式是
「**Windows 环境 + 批量文本操作 = 静默破坏**」。

**但这三条几乎没有共享词汇。** 它们分别谈 `sed`/行尾、正则/工具名匹配、
URL/域名，词法重叠接近于零。那个上位模式是**读出来的**，靠的是语义理解，
不是任何相似度指标能算出来的。

也就是说：本文档自己举的最有说服力的例子，正是词法聚类**找不到**的那一类。
按原方案实现，产出会是「同类型 + 词法相近」的近重复报告 ——
那已经由 P2 覆盖，且价值远低于声称的「发现上位模式」。

### 什么条件下值得重启

- 有真实的嵌入向量可用于聚类（Full 模式的 Qdrant 有，Lite 没有），且
- 先量化过「聚类结果与人工判断的一致率」，而不是假定聚类有效

在此之前，`memos_think` 已经提供了证据包 + 缺口分析 ——
**语义综合交给 agent 做，服务端只做检索与缺口标记**，这与
`memos_distill_skill` 的 inert candidate 设计是一致的，也更诚实。

---

## 9. P4 — 图扩散联想（已实施）

*The Library Theorem*（arXiv 2603.21272）证明索引化外部记忆相对顺序扫描有
指数级检索优势。现有 Neo4j 主要服务 `memos_graph` 的显式查询，检索路径仍以
向量相似度 + rerank 为主。

可做：命中节点后沿边扩散一跳，把强关联节点带进候选集。这是 localist 存储
实现「联想」的方式 —— 不需要全息叠加，因而没有第 1 节所述的容量瓶颈，
同时保留逐条删除能力。

前置条件：先量化 Neo4j 边的精度。边质量不足时扩散会放大噪声。

### 前置测量结果（jincaizhaopin_cube，6534 节点 / 9133 条 typed 边）

| 指标 | 实测 | 判断 |
|---|---|---|
| 边覆盖 | 6430/6534 = **98.4%** | 扩散不会大面积空转 |
| 一跳候选规模 | 中位 **10**、p90 33、最大 75 | 可用，但需上界 |
| 跨业务类型边 | 2581/9133 = **28%** | 带回新种类信息，非同类堆叠 |
| 邻居专属率 | **72%** 只被 1 个源共享 | **不需要 hub 抑制** |
| 最强 hub | 仅被 61/3039 源共享（2%），无 100+ 档 | 无强 hub |
| 邻居性质 | topic 22314 / fact 15352 / reasoning 3495 | 多为真实用户记忆 |

度数分层：`topic` avg 21.47（枢纽性质）、`fact` avg 8.36。104 个孤立节点全是
`fact` 且都是新存的 —— 边由 reorganizer 异步建。

**决定性一项**：随机抽 6 个度数 5-20 的 `fact`，**邻居集完全零重叠**。
从不同记忆扩散带回的是不同的东西，不是同一批噪声。这一条否决了实现前的
hub 稀释担忧 —— 那个担忧是合理的，但被数据证伪了。

### 实现

`mcp-server-node/src/spreading-activation.ts`。

| 取舍 | 值 | 依据 |
|---|---|---|
| 扩散深度 | **一跳** | 两跳候选集爆炸（中位 10 → 100 量级）；2606.24948 的多跳负面结果同样适用于相关性衰减 |
| 上界 | **12** | 覆盖实测中位 10 到 p90 33 之间；388 个 31+ 度节点必须截断 |
| 边类型 | `CAUSE` > `CONDITION` > `RELATE` | 因果与条件比泛关联更可能是 agent 想要的；截断时先保留前者 |
| 排除的边 | `FOLLOWS` / `PARENT` / `MERGED_TO` / `CONFLICT` | 结构性边，不是语义关联 |
| 同类型内排序 | 度数**升序** | 低度数邻居更专属；主要用于压制那 388 个高度数节点 |
| 扩散节点排序 | **排序层分层** | 直接命中恒在联想之前。见下方「为什么不能靠 relativity」 |
| 扩散节点 relativity | 动态：最低直接命中 − 0.01，地板 0.05 | 只决定联想**组内**顺序，不承担分层职责 |
| 可解释标记 | `spread_via` / `spread_from` | agent 应看得出哪条是联想带回的、经由什么边 |
| 生效范围 | 仅 Full 模式 | Lite 无图；`NEO4J_HTTP_URL` 缺失时静默跳过 |

Cypher 侧的约束：排除种子自身（否则把已命中的记忆当"联想"重复带回）、
同 cube 收敛（9.6 节的教训）、排除 `WorkingMemory` 层与 `reasoning` 推断节点、
无向匹配（联想不分方向，只算出边会漏一半）。

### 为什么这是那条讨论的落点

全息表示（HRR）天然支持联想检索，但两个代价致命：**叠加容量与干扰**
（2606.24948 证明多跳组合失败，干扰单跳时就已存在），以及**无法删除单条记忆**。

图扩散是 localist 存储实现联想的方式 —— 既避开容量瓶颈，又保留逐条删除能力。
`memos_delete` 在全息架构里根本无法实现，在图上是一次 `DETACH DELETE`。

### 活体验证

用 3 个真实 `fact` 作种子（度数 6-15），实测：

- 一跳原始邻居 10 个，边类型 `RELATE` 8 / `CAUSE` 2，邻居度数 9-43
- 排序后 `CAUSE` 两条居首，其余按度数升序
- 从「admin-web 有 5 处 `import @recruit/shared`」扩散，带回其他 admin-web 工作
  （CRUD 完成、CORS 问题、admin-web 观察）—— **语义上真的相关**
- 约束自证全通过：种子未被当邻居返回、边类型合规、未超上界、优先级有序、
  种子未被覆盖、id 无重复

### 为什么「绝不压过直接命中」不能靠 relativity

维护者决定（2026-08-21）：联想**绝不**压过直接命中，理由是「弱匹配也是匹配，
联想不是」。

第一版实现是压低扩散节点的 `relativity`（动态取最低直接命中减 0.01）。
**那个实现不满足这条决定。** 实测反例：

```
spreadRelativity(hits) = 0.89          ← 函数本身完全正确
陈旧直接命中  score = 0.7030            (relativity 0.9, PROGRESS, 400 天)
新鲜联想节点  score = 0.8400            (relativity 0.89, 今天)
→ 联想排到了前面
```

原因是**约束错了对象**。排序用的是 `quality_score`，它是六项加权和
（semantic 0.50 + confidence 0.15 + freshness 0.14 + reinforce 0.06 + 三个惩罚）。
压低 `relativity` 只影响 semantic 那一项；联想节点的 `updated_at` 来自邻居、
可能是今天，于是 freshness 拿满分反超了陈旧的直接命中。

**决定说的是「最终排序」，第一版实现的是「排序的一个输入」。** 不等价。

修法是在排序层强制分层：

```ts
const spreadA = isSpreadNode(a) ? 1 : 0;
const spreadB = isSpreadNode(b) ? 1 : 0;
if (spreadA !== spreadB) return spreadA - spreadB;  // 直接命中恒在前
return scoreB - scoreA;                            // 组内按分数
```

实测确认修复后：分数仍是 0.8400 > 0.7030，但顺序变成
`[命中 0.8700] [命中 0.7030] [联想 0.8400]`。**分数没变、顺序对了** ——
这说明约束点选对了：无论其他权重怎么调都成立。

`spreadRelativity` 保留，但职责收窄为「决定联想组内顺序」。这个分离也让
「接线处忘传 relativity」从覆盖漏洞变成无关问题 —— 传什么值顺序都对。

**这个缺陷是我实现完、测试全绿之后才发现的。** 39 项测试没抓住它，因为
它们测的是 `spreadRelativity()` 函数（输入数组、输出一个数），没有一项断言
排序后的相对位置。**测函数，没测决定关心的性质。**

### 验收

- [x] 40 项单测，**16 个扩散变异 + 4 个分层变异全部被捕获**
      （含「去掉分层」= 回到上述反例状态、放宽上界、颠倒优先级、改两跳）
- [x] 排序不变量：联想 relativity 设成 0.99、直接命中 0.1 时顺序仍正确
- [x] `Number(null) === 0` 的边界：relativity 为 0 的直接命中仍是命中，
      联想落到地板值
- [x] 真实图数据端到端验证，语义相关性人工确认
- [x] **已接入 `handlers/search.ts`** 三条 Full 路径（Lite 无图不接）
- [x] spread smoke 8/8，已加入 `npm run test:spread-smoke`
- [x] 全量 vitest 394/394、pytest 98/98、`tsc` clean、lite smoke、protocol v2、
      schema budget +0.0%、semantic snapshot 17 工具

### 开关

`MEMOS_SPREAD_ACTIVATION=true` 开启，**默认关闭**。与
`MEMOS_SHOW_WORKING_MEMORY` 同一模式：用环境变量而非工具参数（schema budget
接近上限，且这是部署级策略）。

默认关闭的理由：扩散会改变每次检索的返回内容（多带回最多 12 条旁证）。
前置测量支持它有效，但「有效」不等于「所有场景都想要」—— 精确查找时多出来的
联想是干扰。让部署方显式开启，而不是替他们决定。

---

## 10. 参考文献

| 论文 | arXiv | 与本文档的关系 |
|---|---|---|
| Hopfield Networks is All You Need | 2008.02217 | 注意力等价于全息联想检索；说明为何「联想」能力不缺 |
| Holographic Memory for Zero-Shot Compositional Reasoning（负面结果） | 2606.24948 | 叠加容量与干扰是硬约束；支撑 localist 路线选择 |
| Titans: Learning to Memorize at Test Time | 2501.00663 | 双系统（短期注意力 + 长期神经记忆）的架构范式 |
| UniMem: Complementary Episodic-to-Parametric Memory | 2607.26017 | P3 巩固 pipeline 的自路由参考 |
| eMEM: Hybrid Spatio-Temporal Memory | 2606.03374 | 海马-新皮层巩固流程 |
| FSFM: Selective Forgetting of Agent Memory | 2604.20300 | 主动遗忘是核心功能而非缺陷；支撑 P1 |
| The Library Theorem | 2603.21272 | 索引化外部记忆的指数级优势；支撑 P4 |
| Dynamically Structured Holographic Memory | 10.22215/etd/2011-09665 | ACT-R base-level activation，P1 访问强化的理论来源 |

---

## 9.5 检索期注解：把算出来的东西显示出来

`memoryAnnotations()` in `mcp-server-node/src/formatters.ts`。

### 起因是 P2 的一个真缺陷

quality policy 往 metadata 写三个字段，但显示层原本只输出
cube / type / 首行 / ID —— **这些字段算完就被丢掉了**。

第 7 节写着「折叠项 id 写入 `duplicates_folded`，信息不丢，可用 `memos_get` 展开」。
**这个说法当时是假的** —— 字段确实写了，但没有任何消费者读它，agent 看不到被折叠的
是哪几条，也就无从展开。这是我在 P2 引入的缺陷，不是继承的。

`freshness` 的 stale / expired 判定同理：它是可行动信号（该复核这条记忆了），
不显示等于白算。`quality_score` 是唯一真被消费的 —— 用于排序。

### 输出规则

| 字段 | 显示条件 | 形态 |
|---|---|---|
| `access_count` | `> 0` | `access_count 4` |
| `freshness` | 仅 `stale` / `expired` | `stale` |
| `duplicates_folded` | 非空数组 | `folded 2: id-a, id-b` |

`fresh` 是常态，不占字符。全新且未被读过的记忆无任何附加，ID 行与改动前逐字一致。

### 两条渲染路径都要覆盖

`compact` 模式（结果 > 15 条时只显示 5 条预览）走 `toMinimal`，
它**原本丢掉整个 metadata**。而 compact 恰恰在结果量大时触发 ——
正是最需要 stale / access_count 信号的场合。

已给 `MemoryMinimal` 加可选 `annotations` 字段，`toMinimal` 计算、
`compactedResultToText` 渲染。可选字段，七个既有调用点无需改动。
`MemoryMinimal` 是显示层类型不是 wire schema，schema budget 实测 +0.0%。

### 抽成纯函数是为了可单测

P1.5 的教训：`formatters.ts` 的改动会整体逃出单测，只有 lite smoke 能覆盖。
`memoryAnnotations` 是纯函数，新增 `formatters.test.ts` 12 项。
8 个变异全部被捕获，含「A1 折叠 id 不显示」—— 即回到我引入缺陷时的状态。

---

## 9.6 记忆层级：默认隐藏 WorkingMemory

`mcp-server-node/src/memory-tier.ts`。

### 起因：用户看到每条记忆都出现两次

`memos_list_v2` 返回的每条记忆都成对出现。初次判断是「写入重复」，**这个判断错了**。
逐个 ID 实测 tier：

```
49b59302  tier=LongTermMemory   created=20:21:14.032312
a2e2b97d  tier=WorkingMemory    created=20:21:14.032312
4894c5b5  tier=LongTermMemory   created=20:20:48.873643
49788c49  tier=WorkingMemory    created=20:20:48.873643
e33c5b86  tier=LongTermMemory   created=19:42:16.097801
d3eae358  tier=WorkingMemory    created=19:42:16.097801
```

三对全是一个 `LongTermMemory` + 一个 `WorkingMemory`，`created_at` 逐字相同。

根因在 `src/oh_memos/memories/textual/tree_text_memory/organize/manager.py`
的 `_add_memories_batch`：同一个循环对每条记忆构造**两个节点** ——
一个 `WorkingMemory` 副本 + 一个图节点，只有图节点 id 进 `added_ids`。
所以 `memos_save` 返回单个 id，而库里落了两条。

**这是分层设计，不是重复。** `WorkingMemory` 是短期缓冲，由
`_cleanup_working_memory` 做 FIFO 淘汰；`LongTermMemory` 持久。两者都必需。

### 两个正交的「类型」轴

| 字段 | 含义 | 取值 | 谁写 |
|---|---|---|---|
| `metadata.memory_type` | **层级** | WorkingMemory / LongTermMemory / UserMemory | scheduler |
| `metadata.type`、tags | **业务类型** | DECISION / BUGFIX / GOTCHA… | agent 在 `memos_save` 时 |

第 6 节的半衰期分档用的是后者。本节管前者。混淆这两个轴是这块最容易犯的错。

### 决定：默认隐藏，环境变量可开

维护者确认默认不可见。理由：`WorkingMemory` 随时会被淘汰，让 agent 引用一个
会消失的 id 是误导。

**这个决定项目里已经做过一次** —— `handlers/wiki-export.ts:324` 早就在过滤
`WorkingMemory`，注释写明「scheduler-managed」。本节只是把它铺到 search 与 list。

逃生开关 `MEMOS_SHOW_WORKING_MEMORY=true`。用环境变量而非工具参数：
schema budget 已接近上限，且这是调试用途，不该进 agent 可见的入参。

### 两条安全边界

**缺 `memory_type` 视为可见。** Lite 模式的本地 JSONL 根本不写这个字段，
误判成 ephemeral 会让**整个 Lite cube 变空**。

**全是 `WorkingMemory` 时原样返回，不返回空。** 「一条都没有」对 agent 的伤害
远大于「多了一层」。真实成因可能是后端只写了 WorkingMemory，
或 LongTermMemory 已被归档过滤掉。

### 接线点与顺序

`memory-quality.ts` 在打分前过滤，覆盖 search 的四条路径。

`handlers/memory.ts` 的 list 路径抽成了导出的纯函数 `prepareListMemories`：
提取 → 滤层级 → 滤业务类型 → 截断。**顺序不是随意的**：

- 滤层级必须在 `slice` **之前**。放到之后 `limit` 会被随即隐藏的副本吃掉 ——
  要 20 条只拿到 10 条。
- `slice` 必须最后，它是对外承诺的输出上界。

### 为什么必须抽成函数

这段逻辑原本内联在 handler 里，**单测触达不到**：实测切断层级过滤后
全部 319 项 vitest 依然通过。与 P1.5 的 W3/W4 同源。

在测试里自行组合这几步只能证明测试文件本身，证明不了 handler ——
所以让 handler 与测试调用**同一个函数**。

### 验收

- [x] 配对只留 `LongTermMemory`
- [x] 滤层级在 slice 之前（交替 20 条、limit=10 必须拿到 10 条 LongTermMemory）
- [x] 缺 `memory_type` 不被误滤；全 ephemeral 不返回空
- [x] 层级与业务类型可叠加过滤
- [x] `memory-tier.test.ts` 18 项 + `list-memories.test.ts` 8 项
- [x] 6 个层级变异 + 4 个顺序变异全部被捕获（含「不滤层级」= 回到漏洞状态）
- [x] 全量 327/327、`tsc` 干净、lite smoke、protocol v2、schema budget +0.0%、pack exit 0

---

## 10.5 为什么不用 LoCoMo 验证这一层

`evaluation/data/locomo/locomo10.json` 在仓库里是现成的，但它验证不了
`memoryQualityScore`，原因有三层，记下来免得后人重复尝试：

1. **粒度不对。** `evaluation/scripts/locomo/locomo_eval.py` 依赖 OpenAI API、
   `sentence_transformers`、`bert_score` 与一个跑起来的 server，测的是端到端
   生成质量（ROUGE/BLEU/METEOR），不是排序函数。
2. **职责不对。** `memoryQualityScore` **消费** `relativity` 而不产生它 ——
   它是重排器。语义匹配是向量检索的职责。
3. **最根本：信号不存在。** LoCoMo 的记忆没有 `memory_type`、`confidence`、
   `status`，也没有真实的年龄分布。本层新增的质量信号在 LoCoMo 语料上
   **全部为空或均匀**，比较会是空转 —— 得到的数字不能说明任何事。

**结论：这一层的正确评测语料是 oh-memos 自己的记忆库，且 ground truth 需要
人工标注的成对偏好。** 当前的基准测试是「不变量 + 敏感度 + 变异验证」，
它能防回归、能抓静默失效，但**不能判定一组参数比另一组更好**。
半衰期 14/180/365/540/1095 与阈值 0.82 都是有理由的选择，但**未经测量**。
这是已知局限，不是遗漏。

---

## 11. 审计过程中的修正记录

初次审计有两处误判，记录以免后续误引：

1. **误称「全仓无归档机制」。** 实际 `archiver.py` 存在且已接入。根因是
   `grep -l` 的输出被 `head` 截断，只剩 `.claude/worktrees/` 下的历史副本，
   主工作树命中被截掉。**教训：带 worktree 的仓库做 grep 必须显式排除
   `.claude/worktrees/`，否则路径按字母序排在前面会挤掉主树结果。**

2. **一次 `search_text` 调用因缺 `query` 参数失败**，但失败结果被当作
   「零命中」使用。工具报错与零结果必须区分。

3. **初版 P1 从惩罚项挪走 0.05 权重**，静默削弱 auto-capture 降权 33%。
   已修正为从 semantic/confidence 让出，并加了三条强度守卫断言。
   **教训：新增评分维度时不要从惩罚项凑权重 —— 惩罚编码的是产品策略。**

4. **一次变异测试打错了位置。** 变异 `.toLowerCase()` → `""` 时，
   `String.replace` 只替换第一处，而第一处是 `isAutoCapture` 里的 tag 匹配
   （测试数据本就小写，等于空变异），真正的目标 `normalizeForCompare`
   没被碰到。据此得出的「覆盖漏洞」结论是错的。
   **教训：变异锚点必须唯一。得到「变异存活」结论时，先量一下该变异
   在用例上到底该产生多大差异 —— 本例实测 Jaccard 应从 1.0000 掉到 0.4737，
   与「全部通过」矛盾，矛盾本身就指出了变异没生效。**

5. **变异脚本最初写成 `node -e`**，含反斜杠、反引号与全角空格的锚点
   被 shell 吃掉一层导致静默 no-op。已改为独立 `.mjs` 文件，
   锚点以 JS 字面量写死。这与项目记忆里 hooks 测试的 shell 转义坑同源。

6. **误称 quality policy 有「5 个调用点」，实际是 4 个** —— 把 import 行
   算进了 grep 计数。已改。

7. **变异驱动器 v2 按「stdout 里有没有 Tests 摘要行」判定，得出 4 条全部
   「未捕获」的结论 —— 全是假的。** vitest 在非 TTY 下不把摘要写进 stdout。
   改成只看**退出码**后，真实结果是 3 捕获 / 2 存活。
   **教训：变异驱动器自己也要先验证 —— 至少确认它能对一个已知会失败的
   变异报出失败。这是第二次因为「验证工具本身失效」而得出错误结论
   （第一次是锚点不唯一）。**

8. **第 7 节写「折叠后信息不丢，可用 memos_get 展开」，当时是假的** ——
   `duplicates_folded` 写进了 metadata 但没有任何消费者，agent 看不到。
   已由第 9.5 节的 `memoryAnnotations` 修掉。
   **教训：写「信息保留在 X」时要顺手确认 X 有出口。**

9. **P3 举的例子证伪了 P3 自己的方案。** 用来论证「需要巩固 pipeline」的
   那三条记忆，恰好是词法聚类找不到的一类（共享词汇接近于零）。
   已撤回原方案并写明重启条件。
   **教训：论证一个方案有价值时，要检查举的例子是否真在该方案的能力范围内。**

10. **`node -e` 的转义坑在本轮反复出现三次**，且 prettier 会重排
    连驱动器脚本本身也被重排，导致锚点失配报 SKIP。
    **SKIP 是无效判定，不是通过** —— 驱动器已把 SKIP 计入 survived。

11. **把「每条记忆出现两次」误判为写入重复。** 实际是
    `WorkingMemory` / `LongTermMemory` 两层同时呈现（见第 9.6 节）。
    误判的代价不只是说法不准：按「去重」去修会**删掉短期记忆整层**，
    并让 `_cleanup_working_memory` 开始淘汰本该持久的东西。
    **教训：22 微秒 + 内容逐字相同是「同一批写入」的特征，不是重复的证据。
    该先看的是能区分两者角色的字段（这里是 `memory_type`）。
    分辨方法：问「这两份用途一样吗」—— 用途相同才是重复，
    用途不同且有字段标着角色就是分层，该过滤显示而非删数据。**

12. **宿主 `python` 一直可用，我却断言「跑不了 pytest」。** PATH 里第一个是
    Microsoft Store 的 `python.exe` 存根（恒 `rc=49` 且无输出），真 Python 在
    `F:\Program\python\python.exe`。据此得出的「Python 侧补不了测试」是错的 ——
    前提一破，结论就不成立。是维护者 `where Python` 指出来的。

13. **管道会吞掉真实退出码。** `cmd | head; echo $?` 取的是 `head` 的退出码。
    我据此说过「8 项检查全过、SYNTAX OK」——**那次验证从未执行**。
    **判定成败必须拿被测命令自己的退出码。**

14. **实现完、39 项测试全绿之后，才发现决定未被满足。**
    `spreadRelativity` 函数完全正确，但排序用的是 `quality_score`（六项加权和），
    压低 relativity 只约束了其中一项 —— 新鲜联想靠 freshness 满分反超陈旧命中
    （实测 0.8400 > 0.7030）。修法是在排序层分层，详见第 9 节。
    **教训：测函数 ≠ 测决定关心的性质。断言的对象必须是决定本身陈述的那个量
    （这里是「顺序」），不能是它的输入代理。**

15. **收紧断言不止抓实现缺陷，也抓测试作者的错误认知。**
    脏值用例里我把 `null` 归进「非数值」，但 `Number(null) === 0` 是合法 finite
    值。宽松断言 `r < 0.6` 让错误答案 0.05 也通过；收紧成
    `toBeCloseTo(0.59)` 才暴露。
    **这类错误变异抓不到** —— 因为错误认知同时写进了实现和测试就自洽了。

16. **prettier 重排让字符串锚点反复失效（本会话第六次）。**
    多行调用、CRLF、以及驱动器脚本自身都会被重排。可靠的替代是按**行号**定位
    并在改动前逐处自证（检查该行内容符合预期），失败即 `exit 1` 不留半成品。

# 调研: "LLM Wiki" 与 "GBrain" (2026-08-01)

> 目的: 确认这两个名字在 LLM/agent 记忆系统语境下的指代, 提取其记忆组织/写入/整理/检索/遗忘/图谱/集成/评测机制, 并记录与 oh-memos 的客观差异点。
> 方法: 全部结论以一手来源为准 (GitHub 仓库 README/源码、Karpathy gist、HN Algolia API、GitHub API); 每个事实句后附来源链接。优化建议不在本文范围内。

---

## 0. 结论速览

| 名字 | 指代确认 | 一句话定性 |
|------|---------|-----------|
| **LLM Wiki** | Andrej Karpathy 于 2026-04-04 前后发布的一个 **设计模式** (gist "llm-wiki.md"), 随后衍生出大量实现与产品, "LLM Wiki" 已成为一个类别名 ([gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), [HN 2026-04-04, 296 分](https://hn.algolia.com/api/v1/search?query=%22llm+wiki%22&tags=story)) | 让 LLM 增量构建并持续维护一个"持久、互链、可复利"的 markdown wiki 作为知识/记忆载体, 以取代"每次查询都从原始文档重新检索合成"的传统 RAG ([gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)) |
| **GBrain** | Y Combinator 总裁/CEO Garry Tan 的开源项目 `garrytan/gbrain`, 2026-04-05 创建, TypeScript, MIT, 截至 2026-08-01 约 27.5k stars ([GitHub API](https://api.github.com/repos/garrytan/gbrain), [仓库](https://github.com/garrytan/gbrain)) | 给 AI agent 的 "brain layer": markdown 页面 + Postgres 混合检索 + 零 LLM 自动建图 + 夜间 "dream cycle" 整理 + 合成式回答与缺口分析, 通过 MCP 接入 Claude Code/Codex 等 ([README](https://github.com/garrytan/gbrain)) |

两者时间上强相关: Karpathy gist 于 2026-04-04 登上 HN 首页 (296 分) ([HN Algolia](https://hn.algolia.com/api/v1/search?query=%22llm+wiki%22&tags=story)), `garrytan/gbrain` 仓库次日 (2026-04-05T14:40:56Z) 创建 ([GitHub API](https://api.github.com/search/repositories?q=gbrain&sort=stars)), 其 HN 发布帖标题自称 "The memex" (2026-04-10) ([HN Algolia](https://hn.algolia.com/api/v1/search?query=gbrain&tags=story)) —— 而 Karpathy gist 结尾正是把该模式追溯到 Vannevar Bush 的 Memex (1945) ([gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f))。GBrain 可视为 LLM Wiki 模式在 "agent 长期记忆" 方向上最重的一个工程化实现 (页面即 wiki、typed wikilink、lint/合成/矛盾清扫等机制与 gist 一一对应, 但 README 未直接引用 Karpathy)。

---

## 1. LLM Wiki (Karpathy 模式及其生态)

### 1.1 指代确认与时间线

- 原始出处是 Karpathy 的 gist `llm-wiki.md`, 自述为 "A pattern for building personal knowledge bases using LLMs", 是一份设计给 "复制粘贴给你自己的 LLM Agent (OpenAI Codex, Claude Code, OpenCode/Pi 等)" 的 "idea file" ([gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f))。
- 2026-04-04 该 gist 以 "LLM Wiki – example of an 'idea file'" 为题登上 HN, 296 分 ([HN Algolia API](https://hn.algolia.com/api/v1/search?query=%22llm+wiki%22&tags=story))。
- 随后数日内出现一批实现仓库 (创建时间 2026-04-04 ~ 04-09), 描述里普遍写明 "Karpathy's LLM Wiki pattern" ([GitHub Search API](https://api.github.com/search/repositories?q=%22llm+wiki%22+OR+llmwiki+OR+%22llm-wiki%22&sort=stars))。
- 该词此后泛化为类别名: inkeep/open-knowledge 自述 "AI-native markdown IDE and LLM wiki"; Java 框架 agents-flex 把 "LLM Wiki" 列为一项功能; 腾讯云 TencentDB-Agent-Memory 把 "LLM-Wiki" 列为四类记忆资产之一 (见 1.5) ([GitHub Search API](https://api.github.com/search/repositories?q=%22llm+wiki%22+OR+llmwiki+OR+%22llm-wiki%22&sort=stars))。

### 1.2 模式本体 (以 Karpathy gist 为准)

以下全部出自 gist 原文 ([来源](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)), 不再逐句重复链接:

- **定位/目标**: 对比传统 RAG —— "RAG 每次提问都从零重新发现知识, 没有积累 (no accumulation)"; LLM Wiki 让 LLM **增量构建并维护一个持久 wiki** (结构化、互链的 markdown 文件集), 位于用户与原始资料之间; "知识编译一次并保持最新, 而不是每次查询重新推导"。核心论断: "wiki 是一个持久的、复利式的产物 (persistent, compounding artifact)" —— 交叉引用已就位、矛盾已被标记、综合页已反映所读全部内容。
- **角色分工**: 人负责选材、探索、提问; LLM 负责全部维护 (总结、交叉引用、归档、簿记)。"Obsidian 是 IDE; LLM 是程序员; wiki 是代码库。"
- **记忆组织模型 (三层)**:
  1. **Raw sources** — 原始资料, 不可变, LLM 只读不改, 是 source of truth;
  2. **Wiki** — LLM 生成的 markdown 目录: 摘要页、实体页、概念页、对比页、overview、synthesis, LLM 完全拥有该层;
  3. **Schema** — 一份约定文档 (如 CLAUDE.md / AGENTS.md), 规定 wiki 结构、约定、ingest/query/维护工作流, 人与 LLM 共同演化。
- **三个核心操作**:
  - **Ingest**: 投入新资料 → LLM 阅读、与用户讨论要点、写摘要页、更新 index、更新相关实体/概念页、追加 log; "单个 source 可能触及 10-15 个 wiki 页面"。
  - **Query**: LLM 检索相关页面、阅读、带引用地合成回答; 关键洞见: "**好的回答应回写进 wiki 成为新页面**" —— 探索成果与摄入的资料一样在知识库中复利。
  - **Lint**: 定期健康检查 —— 页面间矛盾、被新资料取代的过期论断 (stale claims)、无入链的孤儿页、被提及但缺页的重要概念、缺失的交叉引用、可用 web 搜索补的数据缺口。
- **导航文件**: `index.md` (内容目录, 每次 ingest 更新, 查询时 LLM 先读 index 再下钻; "在 ~100 个 source、数百页的规模下工作得出奇地好, 无需 embedding RAG 基础设施") + `log.md` (仅追加的时间线记录, 统一前缀格式可被 unix 工具解析)。
- **检索策略**: 默认 index-first (读目录→读页面); 规模变大后可加本地搜索引擎, gist 点名 [qmd](https://github.com/tobi/qmd) (markdown 本地混合 BM25/向量检索 + LLM 重排, 提供 CLI 与 MCP server 两种接口)。
- **遗忘/衰减机制**: 无自动衰减; 由 Lint 操作以 "LLM 修订" 的方式处理过期论断与孤儿页。
- **图谱用法**: 用 `[[wikilink]]` 互链; 用 Obsidian graph view 观察 wiki 形状 (hub 页/孤儿页); 无独立图数据库。
- **与 agent 的集成**: 模式本身就是"给 coding agent 的指令文件"; wiki 即 git 仓库的 markdown, "版本历史、分支、协作免费获得"。
- **评测**: gist 无任何量化评测 (它是模式文档, 自述 "intentionally abstract, 描述想法而非具体实现")。

### 1.3 生态与代表实现

数据取自 GitHub Search API (2026-08-01 查询, [来源](https://api.github.com/search/repositories?q=%22llm+wiki%22+OR+llmwiki+OR+%22llm-wiki%22&sort=stars)):

| 仓库 | stars | 创建时间 | 定位 (仓库自述) |
|------|------:|---------|----------------|
| [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki) | 15,689 | 2026-04-08 | 跨平台桌面应用, "Instead of traditional RAG… the LLM incrementally builds and maintains a persistent wiki" |
| [AgriciDaniel/claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian) | 10,184 | 2026-04-07 | Obsidian + Claude Code 的自组织第二大脑, "Based on Karpathy's LLM Wiki pattern" |
| [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) | 9,865 | 2026-04-07 | 团队级 Agent 记忆中枢, 四类记忆资产之一为 "LLM-Wiki" (见 1.5) |
| [SamurAIGPT/llm-wiki-agent](https://github.com/SamurAIGPT/llm-wiki-agent) | 3,297 | 2023-04-21* | 自建自维护的个人知识库 (*创建时间早于模式发布, 系旧仓库改名蹭热点的可能性存疑, 引用其机制需谨慎) |
| [inkeep/open-knowledge](https://github.com/inkeep/open-knowledge) | 3,239 | 2026-06-03 | "AI-native markdown IDE and LLM wiki" |
| [sdyckjq-lab/llm-wiki-skill](https://github.com/sdyckjq-lab/llm-wiki-skill) | 2,255 | 2026-04-05 | "基于 Karpathy llm-wiki 方法论的个人知识库构建 Skill" (国内社区实现) |
| [lucasastorian/llmwiki](https://github.com/lucasastorian/llmwiki) | 1,446 | 2026-04-04 | "Open Source Implementation of Karpathy's LLM Wiki", 经 MCP 连接 Claude 写 wiki |
| [nvk/llm-wiki](https://github.com/nvk/llm-wiki) | 917 | 2026-04-04 | "LLM-compiled knowledge bases for any AI agent", 多 agent 并行研究 + wiki 编译 |
| [kytmanov/obsidian-llm-wiki-local](https://github.com/kytmanov/obsidian-llm-wiki-local) | 794 | 2026-04-07 | "Karpathy's LLM Wiki, 100% local with Ollama" (全本地 + Ollama, 与 oh-memos 的本地推理取向相同) |

HN 上另有多个衍生 (wuphf、vault-operator、mcptube、memhub 等), 均自称 Karpathy 式 LLM wiki ([HN Algolia API](https://hn.algolia.com/api/v1/search?query=%22llm+wiki%22&tags=story))。

### 1.4 旗舰实现: nashsu/llm_wiki 的机制细节

以下全部出自其 README ([来源](https://github.com/nashsu/llm_wiki)), 该项目明确声明 "based on Karpathy's LLM Wiki pattern… 忠实保留三层架构/三操作/index.md/log.md/[[wikilink]]/YAML frontmatter/Obsidian 兼容", 并做了如下扩展:

- **写入/整理**: 两步链式 ingest (Step1 LLM 结构化分析: 实体/概念/论点/与现有 wiki 的关联与矛盾; Step2 生成 wiki 文件); SHA256 增量缓存跳过未变更文件; 持久化 ingest 队列 (串行、崩溃恢复、失败自动重试 3 次); 每页 frontmatter 带 `sources[]` 溯源; 每次 ingest 自动重生成 overview.md。
- **新增 `purpose.md`**: 在 schema (结构规则) 之外补充 "wiki 为什么存在" 的方向性意图, ingest 与 query 时都读取。
- **图谱**: 4 信号相关性模型 —— 直接 wikilink (×3.0)、共享同一 raw source (×4.0)、Adamic-Adar 共同邻居 (×1.5)、同类型页面亲和 (×1.0); Louvain 社区发现 + 凝聚度评分; "Graph Insights" 自动产出 **surprising connections** (跨社区/跨类型/边缘-枢纽连接) 与 **knowledge gaps** (孤立页 degree≤1、稀疏社区 cohesion<0.15、桥接节点), 缺口可一键触发 Deep Research (web 搜索→合成→自动回灌 wiki)。
- **检索**: 四阶段管线 —— Phase1 分词检索 (中文 CJK bigram, 标题命中加分) → Phase1.5 可选向量检索 (LanceDB, 任意 OpenAI 兼容 embedding 端点) → Phase2 图扩展 (以检索结果为种子, 4 信号模型 2-hop 带衰减遍历) → Phase3 token 预算控制 (4K~1M 可配, 60% wiki 页 / 20% 聊天历史 / 5% index / 15% system) → Phase4 上下文组装 (编号引用 [1][2])。自测: 启用向量检索后整体召回率 58.2% → 71.4%。
- **遗忘/删除**: 无自动衰减; 提供级联删除 —— 删 source 时按 frontmatter `sources[]` 等 3 种方式匹配相关 wiki 页, 多来源共享的实体页只摘除该 source 而不删页, 同时清理 index 与死 wikilink。
- **人在环**: 异步 Review 队列 (LLM 在 ingest 时标记需人判断的条目, 动作限定为 Create Page / Deep Research / Skip 以防幻觉)。
- **MCP/agent 集成**: 内置本地 HTTP API (`127.0.0.1:19828`, token 保护) + 本地 MCP server (list projects / 读文件 / 混合检索 / 图查询 / Review 导出与回写 / 触发 rescan / 后端 Agent chat); 另有官方 agent skill 仓库, `npx skills add` 一条命令装入 Claude Code/Codex ([skill 仓库](https://github.com/nashsu/llm_wiki_skill))。
- **技术栈**: Tauri v2 (Rust) + React 19; 向量库 LanceDB (嵌入式); 图可视化 sigma.js + graphology; 支持 OpenAI/Anthropic/Google/**Ollama**/自定义。GPL-3.0。

### 1.5 agent-memory 语境下的 "LLM-Wiki": TencentDB-Agent-Memory

腾讯云的 TencentDB-Agent-Memory 是 "LLM Wiki" 概念进入 **团队级 agent 记忆系统** 的代表 (与 oh-memos 定位最接近的一个), 以下出自其 README ([来源](https://github.com/TencentCloud/TencentDB-Agent-Memory)):

- **定位**: "team-level memory hub for AI Agents", 把对话/文档/代码转成四类可复用记忆资产 —— **Chat Memory、Skill、LLM-Wiki、Code-Graph** —— 统一治理、共享、按 Agent 配装。README 致谢部分明确写道: 其 Wiki 层的构建与保鲜方式 "directly informed" 自 Karpathy 的 "LLM Wiki" gist。
- **分层记忆模型**: L0 Conversation (原始对话) → L1 Atom (事实/偏好/约束/事件) → L2 Scenario (按项目/场景组织的知识块) → L3 Core/Persona (长期画像与稳定模式), 由异步管线逐层蒸馏; 检索也分层 —— 常规用 L2/L3 快速引导上下文, 需要具体事实时用 **BM25 + 向量 + RRF** 回落到 L1/L0, 并施加条数/字符预算/超时三重上限防止记忆挤爆上下文窗口。
- **权限模型**: 资产可见性四级 `private` / `team` / `restricted` (User/Role/Agent ACL) / `agent` (定向配装); "Fixed Binding + ACL" 先按 Team/User/Agent/可见性收缩权限范围再检索。
- **按需调用**: 文档组织为可检索、支持链接图下钻的 Wiki 页; 代码索引为含文件/符号/调用关系的 CodeGraph; Agent 经 `/v3/tools/list` 发现能力、`/v3/tools/call` 按需读取, "文档与代码也是记忆, 但只在真正需要时进入上下文"。
- **评测**: 自报 PersonaMem 基准 48% → 76% (相对提升 +59%)。
- **集成**: 当前支持 OpenClaw、Hermes 与 SDK 接入; npm 包 `@tencentdb-agent-memory/memory-tencentdb`; MIT。

---

## 2. GBrain

### 2.1 指代确认与排除项

**确认**: `garrytan/gbrain`, 自述 "Garry's Opinionated OpenClaw/Hermes Agent Brain", README 第一人称署名 "I'm Garry Tan, President and CEO of Y Combinator", 2026-04-05 创建, TypeScript, MIT, 27,499 stars (2026-08-01, [GitHub API](https://api.github.com/search/repositories?q=gbrain&sort=stars)); HN 发布帖 (2026-04-10) 标题 "GBrain – The memex, built for people who think for a living" ([HN Algolia](https://hn.algolia.com/api/v1/search?query=gbrain&tags=story)); Garry Tan 本人推文见 [此贴](https://twitter.com/garrytan/status/2053127519872614419) (经 HN 2026-05-11 转发)。周边生态已成形: 评测仓库 [gbrain-evals](https://github.com/garrytan/gbrain-evals) (329 stars)、第三方 hermes-memory-installer / hermes-gbrain-bridge / brain-map-skill 等 ([GitHub API](https://api.github.com/search/repositories?q=gbrain&sort=stars))。

**排除的同名候选** (均与 agent memory 无关):
- 2010s 的 graphbrain (语义超图库) —— 本次 GitHub/HN 检索中未与 2026 记忆语境产生任何关联;
- npm 包 `gbrain` —— GBrain README 专门警告 "npm 上的 gbrain 是无关包, 请勿 npm install" ([README](https://github.com/garrytan/gbrain));
- "Neuro+ GBrain" —— 面向神经多样性人群的诊断/治疗工具 ([HN Algolia](https://hn.algolia.com/api/v1/search?query=gbrain&tags=story));
- gBrainy —— 2008 年 GNOME 益智游戏 ([HN Algolia](https://hn.algolia.com/api/v1/search?query=gbrain&tags=story));
- arXiv 检索 "GBrain" 未发现同名论文 (export.arxiv.org API 查询无结果, 见 §4)。

### 2.2 定位/目标

以下未注明者均出自 README ([来源](https://github.com/garrytan/gbrain)):

- "Search gives you raw pages. GBrain gives you the answer." —— agent 缺失的 "brain layer", 宣称独有点是把 **synthesis (合成)**、**graph traversal (图遍历)**、**gap analysis (缺口分析)** 做在一个盒子里; 两种用法: 在其上跑完整自治 agent, 或一条命令接入 Claude Code/Codex 作为增强检索层。
- 作者的生产实例规模自述: 146,646 页、24,585 人、5,339 家公司、66 个自治 cron 任务; agent 全天摄入会议/邮件/推文/语音/想法, "夜间自己修引用、做记忆整理 (consolidates memory overnight)"。
- 也定位为 "company brain" (团队共享机构记忆): 每人按登录隔离出 brain 切片, 检索/列表/查找/多源读取全路径做过 fuzz 测试, 自称零泄漏 (自测声明)。

### 2.3 记忆组织模型

- **系统记录 (system of record) 是 git 仓库里的 markdown 页面** ("brain repo"); GBrain 把仓库同步进 Postgres 供检索, git 里的删除在 DB 中变为软删除 ([README §Architecture](https://github.com/garrytan/gbrain))。
- **双引擎单契约**: PGLite (WASM 版 Postgres 17, 零配置, 个人 brain ~50K 页以内) 或 Postgres + pgvector (Supabase/自托管); `BrainEngine` 接口约 47 个操作, CLI 与 MCP server 由同一来源生成 ([README §Architecture](https://github.com/garrytan/gbrain))。
- **两个正交组织轴**: *brain* (一个数据库: 个人 brain、加入的团队挂载) ⊥ *source* (brain 内的一个仓库: wiki、essay、知识库), 经 `.gbrain-source` 点文件 + 6 级优先链路由 ([README §Architecture](https://github.com/garrytan/gbrain))。
- **类型化页面 + 可演化 schema (schema packs)**: 默认包 `gbrain-base-v2` 是 15 类页面分类 (`person, company, media, tweet, social-digest, analysis, atom, concept, source, deal, email, slack, writing, project, note`); 另有 legacy 24 类包与扩展包; 用户可用 `gbrain schema detect / suggest / review-candidates` 三条命令从自己的文件系统聚类出自定义类型包; **agent 可代为演化 schema** (14 个 `gbrain schema` CLI 动词 + 批量 MCP 操作 `schema_apply_mutations`, admin scope, 原子文件锁 + 记录 agent 身份的审计日志) ([README §schema packs / Agent-authored schema](https://github.com/garrytan/gbrain))。

### 2.4 写入路径

- 入口: `gbrain capture` (文本/文件/stdin, 默认落到 `inbox/YYYY-MM-DD-<hash8>` 便于归拢分诊)、HTTP `/ingest` webhook (Zapier/IFTTT/Apple Shortcuts)、`~/.gbrain/inbox/` 收件夹 (iOS 快捷指令/AirDrop 投放)、第三方 skillpack 可按版本化的 `IngestionSource` 契约扩展摄入源 (Granola/Linear/语音/OCR) ([README §How to get data in](https://github.com/garrytan/gbrain))。
- **Signal detector** 在 agent 收到的每条消息上运行, 捕获想法/实体提及/时效性待办/人名/链接; 检索遵循 "brain-first lookup" (先查 brain 再调外部 API) ([README §What it does](https://github.com/garrytan/gbrain))。
- **写入即建图 (零 LLM)**: 每次 `put_page` 运行 `extractEntityRefs`, 仅用 3 条正则匹配 markdown 链接 / Obsidian `[[wikilink]]` / typed-link blockquote, 单条 SQL 批量建边; 边的类型 (`attended, works_at, invested_in, founded, advises, mentions…`) 由周边句子上下文做启发式推断, 同样不花 LLM token; 17K 页的 brain 全量图抽取秒级完成 ([docs/architecture/RETRIEVAL.md](https://github.com/garrytan/gbrain/blob/master/docs/architecture/RETRIEVAL.md))。

### 2.5 整理/合并 (consolidation): dream cycle

- README 表述: cron 驱动的夜间富化 —— "dedup people pages, fix citations, score salience, find contradictions, prep tomorrow's tasks" ([README §What it does](https://github.com/garrytan/gbrain)); `gbrain dream` 一次性执行, `gbrain autopilot` 守护化调度, 两者收敛到同一 `runCycle` 原语 ([src/commands/dream.ts](https://github.com/garrytan/gbrain/blob/master/src/commands/dream.ts))。
- 源码中 `CyclePhase` 枚举共 **23 个阶段** (部分默认关闭), 按 `ALL_PHASES` 顺序: `lint → backlinks → sync → synthesize → extract → extract_facts → extract_atoms → resolve_symbol_edges → patterns → synthesize_concepts → recompute_emotional_weight → consolidate → propose_takes → grade_takes → calibration_profile → drift → conversation_facts_backfill → enrich_thin → skillopt → embed → orphans → schema-suggest → purge` ([src/core/cycle.ts](https://github.com/garrytan/gbrain/blob/master/src/core/cycle.ts))。
- 关键阶段语义 (源码注释, [同上](https://github.com/garrytan/gbrain/blob/master/src/core/cycle.ts)):
  - `consolidate` (v0.31): 按 (source_id, entity_slug) 聚类未整理的 facts, Sonnet 每簇合成一条 take (kind='fact') 写入, 原 facts 标记 consolidated_at/consolidated_into 但 "**Never DELETE — facts stay as audit trail**";
  - `extract_atoms` / `synthesize_concepts` (v0.41, 按 schema pack 门控): 从转录/文章/会议中用 Haiku 抽取 atom 页, 再全局聚合为 "dedup → tier 提升 → Sonnet 叙事" 的 concept 页;
  - `propose_takes / grade_takes / calibration_profile` (Hindsight 校准三连): LLM 扫描文本提出可评分的 claim → 人工接受后由 judge 模型对照证据裁决 → 聚合为 2-4 条叙事模式 + 偏差标签;
  - `drift` (默认关): LLM 以最近 timeline 证据评判既有 takes 是否漂移, v1 仅出报告不改数据;
  - `enrich_thin` (默认关): 每轮用 brain 内部有据合成充实少量 stub 页;
  - `skillopt` (默认关): 自演化技能, 单技能成本上限 $0.50 / 全 brain $2.00, 绝不自动改捆绑技能。

### 2.6 检索策略

以下出自 [docs/architecture/RETRIEVAL.md](https://github.com/garrytan/gbrain/blob/master/docs/architecture/RETRIEVAL.md) 与 [README §Capabilities](https://github.com/garrytan/gbrain):

- **四策略并联**: 向量 (pgvector HNSW) + BM25 关键词 + RRF 融合 + **知识图谱遍历**; 文档给出各自单独失败的模式 (纯向量抓不住事实关系、纯关键词对措辞脆弱、纯图对未建链页面盲、混合无图答不了 "Y 与 X 什么关系")。
- 其上叠加: 来源分层加权 (精选目录 `originals/ concepts/ writing/` 压过批量目录 `chat/ daily/`; `archive/` 降权 0.5x 而非隐藏)、意图感知查询改写、cross-encoder 重排器 (默认 ZeroEntropy `zerank-2`, 实测重排改写 60% 的 top-1, 代价 +150ms p50)、每查询图信号 (hub 邻接加权 / 跨 brain 佐证加权 / 会话噪声降权)、named-thing 专项层 (per-page max-pool 每页取最强 chunk、标题短语加权、alias 别名跳转、结果携带 `evidence` 标签与 `create_safety` 提示供 agent 判断页面是否已存在)。
- 三种命名检索模式 `conservative / balanced / tokenmax` 打包成一个配置键; `gbrain search --explain` 输出每阶段加权归因; `gbrain search diagnose` 追踪某页在哪一层被命中/漏掉。
- **两级查询**: `gbrain search` 返回原始检索结果 (无 LLM 成本); `gbrain think` 在同样检索之上合成带引用的回答, 并附 **gap analysis** —— 明说哪页过期、哪条 claim 无引用、哪两页互相矛盾、哪里有洞 ([README §Two ways to query](https://github.com/garrytan/gbrain))。

### 2.7 遗忘/衰减机制

- 删除是三段式: git 删除 → DB 软删除 ([README §Architecture](https://github.com/garrytan/gbrain)) → dream cycle 末位 `purge` 阶段硬删 "过了 72 小时恢复窗口的软删页与过期归档 source" ([src/core/cycle.ts](https://github.com/garrytan/gbrain/blob/master/src/core/cycle.ts))。
- `archive/` 目录内容检索时降权 0.5x 但刻意不隐藏 (高信号历史内容仍可被重排器捞回) ([RETRIEVAL.md](https://github.com/garrytan/gbrain/blob/master/docs/architecture/RETRIEVAL.md))。
- **salience 权重**: `recompute_emotional_weight` 阶段为每页计算确定性的 0..1 "情感权重" (由 tags + active takes 派生, 纯函数无 LLM), 喂给 `get_recent_salience` 查询, 使高情感权重页面在 "最近发生了什么" 类查询中压过 "繁忙但浅" 的页面; 高情感 tag 种子表可配置 ([src/core/cycle/emotional-weight.ts](https://github.com/garrytan/gbrain/blob/master/src/core/cycle/emotional-weight.ts))。
- consolidate 明确 "永不删除 facts, 保留审计痕迹" ([src/core/cycle.ts](https://github.com/garrytan/gbrain/blob/master/src/core/cycle.ts)) —— 即整体哲学是 "降权/归档/审计保留" 而非真正遗忘。

### 2.8 图谱用法

- 类型化边 (`attended, works_at, invested_in, founded, advises, mentions…`), 多跳遍历命令 `gbrain graph-query` ([README §Capabilities](https://github.com/garrytan/gbrain))。
- 建边零 LLM (3 正则 + 启发式类型推断, 见 2.4); "图返回的是事实相连的 chunk, 向量返回的是语义相近的 chunk" ([RETRIEVAL.md](https://github.com/garrytan/gbrain/blob/master/docs/architecture/RETRIEVAL.md))。
- 量化归因: BrainBench 240 页语料上, ripgrep-BM25 / 纯向量 RAG / 关图的混合检索三个基线 P@5 均 ~18, 完整栈 P@5 49.1 / R@5 97.9 —— "+31 个 P@5 点来自图 + 抽取质量; 图不是边缘特性, 是承重墙" ([RETRIEVAL.md](https://github.com/garrytan/gbrain/blob/master/docs/architecture/RETRIEVAL.md))。

### 2.9 与 MCP / agent 的集成方式

- **MCP**: 30+ 工具, stdio 与 HTTP 双传输; 本地一条命令 `claude mcp add gbrain -- gbrain serve`; HTTP 侧带 OAuth 2.1 + PKCE (ChatGPT 硬要求)、DCR 式客户端注册、`read/write/admin` 三级 scope、限流; 按客户端出文档 (Claude Code / Codex / Cursor / Windsurf / Claude Desktop / Cowork / Perplexity / ChatGPT) ([README §Install / MCP](https://github.com/garrytan/gbrain))。
- **面向 agent 的安装协议**: `INSTALL_FOR_AGENTS.md` —— 让用户把一句 "Retrieve and follow the instructions at <raw URL>" 粘给任意能读 HTTPS + 执行 shell 的 agent, 由 agent 完成安装/建 brain/装 43 个技能/配 dream cycle/端到端验证 ([README](https://github.com/garrytan/gbrain))。
- **43 个策划技能** (markdown、工具无关), 路由表 `skills/RESOLVER.md`; `skillopt` 把 SKILL.md 当可训练参数优化 ([README §Capabilities](https://github.com/garrytan/gbrain))。
- 提供 `llms.txt` / `llms-full.txt` 文档地图与 `AGENTS.md` / `CLAUDE.md` 双入口 ([README](https://github.com/garrytan/gbrain))。
- 服务的上游 agent 平台: OpenClaw 与 Hermes (NousResearch hermes-agent) ([README](https://github.com/garrytan/gbrain))。
- **Minions 任务队列**: Postgres 原生 (BullMQ 形态) 的持久任务队列, 子 agent 是 "经两阶段 pending→done 持久化、崩溃可恢复的 LLM 工具循环" ([README §Capabilities](https://github.com/garrytan/gbrain))。

### 2.10 评测结果

出自评测仓库 [gbrain-evals](https://github.com/garrytan/gbrain-evals) (公开、可本地复现、每张记分卡标注运行的 commit):

| 基准 | 结果 (自报) | 备注 |
|------|------------|------|
| **LongMemEval** (公开数据集, 500 题长对话史) | **97.6% recall@5** | 自称 "该测试的已发表最好成绩, 且检索环节零 LLM" |
| **BrainBench 关系型问题** (240 页 Opus 生成的虚构人生语料) | **97.9% recall@5, 49.1% precision@5** | 比纯向量检索 precision 高 38 点, 其中约 30 点归因图层 |
| **跨 20 个版本回归** (v0.20.0→v0.40.6.0) | 零回归 | 头名指标逐版本保持一致 |
| **PrecisionMembench** (外部 precision-only 测试) | 默认 **0.076** precision (recall 0.99), 开 adaptive 后 **0.582**、总榜第二 | 主动把难看的默认成绩留在 README ("we report the bad numbers too") |
| **SkillOpt** | 4/4 缺陷技能 0→1.00, 关键词作弊被独立 judge 拦截, 增益跨模型迁移 | |

- CI 门禁覆盖面 (每项有提交的通过阈值): 检索 recall@5>0.83、身份归并 (别名/handle/邮箱→同一人) recall>0.80、时间问题 ("as of last March") recall>0.80、**引用溯源 accuracy>0.90**、建链 precision>0.95、p95<200ms、22 条对抗输入 100% 不崩溃不损坏、信任边界 (agent API 不可被骗成静默损坏) 等 ([gbrain-evals README](https://github.com/garrytan/gbrain-evals))。
- 语料含 "混乱的虚构一周" (50 邮件 + 300 聊天 + 8 转录, **故意埋入矛盾、过期事实与垃圾**) 用于测试脑子在真实噪声下是否保持一致 ([同上](https://github.com/garrytan/gbrain-evals))。
- 另有 `gbrain eval suspected-contradictions` (采样检索对 + 日期预过滤 + 查询条件化 LLM judge) 接入每日 dream cycle 做一致性巡检 ([README §Capabilities](https://github.com/garrytan/gbrain))。

---

## 3. 与 oh-memos 的客观差异点

对照基线: oh-memos 当前架构 = MCP Server (Node/TS) 暴露 memos_save/search/get_graph/trace_path/impact 等工具; Python 后端基于 MemOS, tree_text 模式; Neo4j 图 (CAUSE/RELATE/CONFLICT/CONDITION 边) + Qdrant 向量; LLM 抽取 key/tags/background/confidence, 本地 Ollama; 按 project_path 分 cube; 9 类 memory_type 枚举 (本仓库 CLAUDE.md 及调研任务给定的架构速览)。以下只列 **机制层面的客观差异**, 不含建议:

| # | 对方机制 | 出处 | oh-memos 现状 |
|---|---------|------|--------------|
| 1 | **记忆载体是可反复改写、人类可读的 markdown 页面**, git 即系统记录 (版本史/分支/协作免费); GBrain 的 DB 只是页面的检索投影 | [Karpathy gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), [gbrain README](https://github.com/garrytan/gbrain) | 记忆是 Neo4j/Qdrant 中的离散条目, 无文件形态、无版本史 |
| 2 | **持久合成产物**: wiki 页 (实体页/概念页/synthesis/overview) 随每次摄入被"就地更新", 知识编译一次持续保鲜; 查询产出的好答案回写为新页面参与后续链接与检索 ("探索也复利") | [Karpathy gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) | 记忆按条追加, 无跨条目的持续综合页; 无"答案回灌"机制 |
| 3 | **定期离线整理循环** (nightly dream cycle, 23 阶段: facts 聚类合成、原子→概念分层提升、矛盾/漂移巡检、孤儿处理、purge…); Karpathy 模式对应 Lint 操作 | [src/core/cycle.ts](https://github.com/garrytan/gbrain/blob/master/src/core/cycle.ts), [gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) | 无周期性维护任务; 仅 PROGRESS TTL 自动归档处于设计阶段 (`docs/design/phase3_auto_archive.md`, status 字段与检索过滤已就绪) |
| 4 | **零 LLM 成本的写入即建图**: 3 条正则抽实体引用 + 句子上下文启发式推断边类型, 每次写页即建 typed edges | [RETRIEVAL.md](https://github.com/garrytan/gbrain/blob/master/docs/architecture/RETRIEVAL.md) | 建边依赖 LLM 抽取 (本地 Ollama 推理), 每次保存有推理成本 |
| 5 | **检索融合层**: BM25 + 向量 + RRF + 来源分层加权 + cross-encoder 重排 + 每查询图信号 + per-page max-pool/标题/别名加权; nashsu 版为 分词+向量+图扩展+token 预算 四阶段; Tencent 版为 BM25+向量+RRF 分层回落 | [RETRIEVAL.md](https://github.com/garrytan/gbrain/blob/master/docs/architecture/RETRIEVAL.md), [nashsu README](https://github.com/nashsu/llm_wiki), [Tencent README](https://github.com/TencentCloud/TencentDB-Agent-Memory) | 检索为 Qdrant 语义相似 + Neo4j 图查询; 未见 BM25/RRF/重排器/来源加权 |
| 6 | **合成式回答 + 缺口分析**: `gbrain think` 返回带引用的合成答案并明示"脑子还不知道什么" (过期页/无引用 claim/互相矛盾/空洞); nashsu Graph Insights 自动产出 knowledge gaps 并可一键 Deep Research 补洞 | [gbrain README](https://github.com/garrytan/gbrain), [nashsu README](https://github.com/nashsu/llm_wiki) | 检索返回记忆条目本身; 无合成回答层, 无缺口分析/主动补洞 |
| 7 | **遗忘/衰减为"降权+归档+审计保留"**: 软删→72h 后 purge 硬删; archive 检索降权 0.5x 不隐藏; salience(emotional_weight) 影响时序类查询排序; consolidate 后原 facts 永不删除留审计 | [cycle.ts](https://github.com/garrytan/gbrain/blob/master/src/core/cycle.ts), [RETRIEVAL.md](https://github.com/garrytan/gbrain/blob/master/docs/architecture/RETRIEVAL.md), [emotional-weight.ts](https://github.com/garrytan/gbrain/blob/master/src/core/cycle/emotional-weight.ts) | 有 status(activated/archived/deleted) 过滤; 无衰减/salience 权重; TTL 归档在设计中 |
| 8 | **记忆粒度分层**: Tencent L0 对话→L1 原子→L2 场景→L3 画像逐层蒸馏, 生成与检索都分层; gbrain atoms→tier 提升→concepts | [Tencent README](https://github.com/TencentCloud/TencentDB-Agent-Memory), [cycle.ts](https://github.com/garrytan/gbrain/blob/master/src/core/cycle.ts) | memory_type 是平级分类枚举 (BUGFIX/DECISION/…), 非粒度分层 |
| 9 | **schema 可演化**: gbrain schema packs (15 类默认 + 自定义包三命令生成 + agent 代改 schema 的 MCP 操作/审计); Karpathy 模式中 schema 文档本身由人机共同演化 | [gbrain README](https://github.com/garrytan/gbrain), [gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) | memory_type 枚举固定在工具 schema 中 |
| 10 | **多用户/团队权限**: gbrain company brain 按登录隔离 (自称 fuzz 零泄漏), OAuth2.1 + read/write/admin scope; Tencent private/team/restricted/agent 四级 ACL + 按 Agent 配装 | [gbrain README](https://github.com/garrytan/gbrain), [Tencent README](https://github.com/TencentCloud/TencentDB-Agent-Memory) | cube 按项目隔离; 无用户/角色级 ACL 与 scope 化远程访问 |
| 11 | **引用溯源作为硬指标**: 每页 frontmatter `sources[]` (nashsu); gbrain 引用准确率>0.90 进 CI 门禁, dream cycle 含 fix citations | [nashsu README](https://github.com/nashsu/llm_wiki), [gbrain-evals](https://github.com/garrytan/gbrain-evals) | 记忆条目无到原始出处 (对话/文件) 的结构化引用字段 (速览未提及) |
| 12 | **技能/代码也是记忆资产**: Tencent 把 Skill (带版本/触发边界/验证规则) 与 CodeGraph 与 Chat Memory/Wiki 同库治理; gbrain 43 技能 + skillopt 自优化 | [Tencent README](https://github.com/TencentCloud/TencentDB-Agent-Memory), [gbrain README](https://github.com/garrytan/gbrain) | 记忆为文本条目; skill 是独立的 project-memory 目录, 不入记忆库 |
| 13 | **矛盾的持续巡检**: gbrain suspected-contradictions (采样+日期预过滤+LLM judge) 入每日 dream cycle; 评测语料故意埋矛盾; Karpathy Lint 专查页面间矛盾与过期论断 | [gbrain README](https://github.com/garrytan/gbrain), [gbrain-evals](https://github.com/garrytan/gbrain-evals), [gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) | 有 CONFLICT 边类型 (保存时刻的关系), 无周期性矛盾扫描 |
| 14 | **面向 agent 的安装/文档协议**: INSTALL_FOR_AGENTS.md (agent 自装自验)、llms.txt/llms-full.txt、AGENTS.md+CLAUDE.md 双入口 | [gbrain README](https://github.com/garrytan/gbrain) | 面向人的 install_run.bat/文档; 无 agent 自安装协议与 llms.txt |

**共性 (非差异, 记录备查)**: 评测基准高度重合 —— oh-memos 仓库 `evaluation/` 已带 LongMemEval、PersonaMem、LoCoMo、LongBench-v2、PrefEval 脚本 (仓库事实, `/mnt/g/test/oh-memos/evaluation/scripts/`), gbrain 自报 LongMemEval 97.6% recall@5 ([gbrain-evals](https://github.com/garrytan/gbrain-evals)), Tencent 自报 PersonaMem 48%→76% ([Tencent README](https://github.com/TencentCloud/TencentDB-Agent-Memory)) —— 三方可在同一基准上直接对比。MCP 集成、图+向量双库、本地推理 (kytmanov 的全 Ollama 实现、gbrain 的 Ollama/llama.cpp embedding+reranker 配方) 亦为共性。

---

## 4. 检索过程记录 (可复核)

- 环境限制: 会话内 WebSearch/WebFetch 多次返回 429 限流, 故主要经 `curl` 走 GitHub REST API、raw.githubusercontent.com、gist raw、HN Algolia API、export.arxiv.org 获取一手材料; 所有引用链接均为一手来源。
- 已试查询: GitHub repo search `gbrain` (sort=updated/stars, 414 结果)、`"llm wiki" OR llmwiki OR "llm-wiki"` (sort=stars); HN Algolia `"llm wiki"`、`gbrain` (tags=story); arXiv API `all:"GBrain"` (无结果)、`all:"LLM Wiki"` (无相关结果); Karpathy 名下仓库列表 (无 llm-wiki 仓库, 确认原始载体是 gist)。
- 排除候选: graphbrain (2010s 语义超图库)、npm `gbrain` 包 (GBrain README 明确声明无关)、Neuro+ GBrain (神经多样性治疗工具)、gBrainy (2008 GNOME 游戏)。"LLM Wiki" 一词的商业变体 (llm-wiki.net 等) 未深入, 因其非模式源头且 HN 热度低。
- 局限声明: gbrain 的 LongMemEval "已发表最好成绩"、company brain "fuzz 零泄漏"、生产规模 (146,646 页) 均为项目自述/自测, 本文未独立复现; SamurAIGPT/llm-wiki-agent 仓库创建时间 (2023-04) 早于模式发布, 其描述可信度存疑, 未采用其任何机制性 claim。

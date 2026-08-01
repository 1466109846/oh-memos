---
generator: oh-memos-wiki-export
id: 06a5bf24-e50f-43ca-8717-4b02580d6b5f
type: PROGRESS
status: activated
tags: ["PROGRESS"]
confidence: 0.99
created: 2026-08-01T03:39:52.334192000+00:00
updated: 2026-08-01T03:39:52.335189000+00:00
---

# [PROGRESS] 2026-08-01 完成 "LLM Wiki 与 GBrain 对 oh-memos 的优化点" 调研,完整报告(14 项机制差异对照,

2026-08-01 完成 "LLM Wiki 与 GBrain 对 oh-memos 的优化点" 调研,完整报告(14 项机制差异对照,全部一手来源)在 docs/research/2026-08-01-llm-wiki-gbrain.md。

指代确认:LLM Wiki = Karpathy 2026-04-04 gist 提出的设计模式(LLM 增量维护持久互链 markdown wiki;三层 raw sources/wiki/schema;Ingest/Query/Lint 三操作;好答案回写 wiki 复利)。GBrain = Garry Tan 的 garrytan/gbrain(2026-04-05,27.5k stars):git markdown 为系统记录 + 零 LLM 正则建图 + 夜间 dream cycle 23 阶段整理(consolidate 永不删原 facts/矛盾巡检/salience/purge)+ BM25/向量/RRF/图四路检索融合 + think 合成回答与缺口分析,自报 LongMemEval 97.6% recall@5(图层贡献约 +31 P@5)。

对本项目的关键发现:
1. 两个休眠开关:BM25_CALL 与 MOS_ENABLE_REORGANIZE 在 MCP 端(mcp-server-node/src/cube-manager.ts:292,294)与 API 端(src/oh_memos/api/config.py)默认均 false,而底座的 EnhancedBM25 与 GraphStructureReorganizer(聚类+摘要+MEMORY_MERGE_PROMPT 合并)机制完整——处于"机制在库、实际未跑"状态,开启即得混合检索与记忆整理。注意 env_loader.py 默认 True 与 MCP/API 端 false 存在双端漂移;oh-memos-cli init_wizard 默认 bm25:true。
2. 优化优先级结论:第一梯队=接线两开关+落地已设计的 phase3 TTL 归档;第二梯队=dream cycle 式夜间编排(矛盾巡检、consolidate 聚合、salience 衰减权重——原料 usage_history/mem_scheduler/MEMORY_MERGE_PROMPT 全部现成)+ memos_think 工具(检索之上合成带引用回答+缺口分析,结果回灌为新记忆);第三梯队(需决策)=cube 渲染为互链 markdown wiki 只读镜像(git 版本化、人可读)、记忆粒度分层(腾讯 L0-L3/GBrain atoms→concepts,context_resume 改读画像层)、schema 可演化。
3. evaluation/ 已有 LongMemEval/PersonaMem/LoCoMo 脚本,与 GBrain(LongMemEval 97.6%)、腾讯 TencentDB-Agent-Memory(PersonaMem 48%→76%)自报基准同源,任何检索改造前应先跑基线量化。

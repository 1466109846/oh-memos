---
generator: oh-memos-wiki-export
id: 338e60dc-0c03-4c41-875b-efd23c94d30a
type: PROGRESS
status: activated
tags: ["oh-memos", "deepseek-v4-pro", "LLM", "fallback", "probe", "write-read consistency", "neo4j", "Qdrant", "embedding", "search", "full-chain verification", "debugging"]
confidence: 0.66
created: 2026-07-19T19:54:32.400616000+00:00
updated: 2026-07-19T19:54:32.400616000+00:00
---

# 2026年7月11日 oh-memos 全链路验证、模型切换与写后读一致性修复",
  "memory_type": "UserMemory",
  "value": "2026年7月11日0时23分，用户通过本地中转站http://loc

2026年7月11日0时23分，用户通过本地中转站http://localhost:3000/v1将oh-memos项目的主LLM模型从原有模型切换为deepseek‑ai/deepseek‑v4‑pro，并新增了LLM自动降级子系统，配置在主模型超时或额度耗尽时自动降级到LongCat‑2.0。离线单元测试全部通过，无循环导入问题，classify_error判定正确，超时场景在重试2次后降级，额度耗尽场景立即降级，disabled状态原样返回。全链路实测中，POST /memories 接口返回200，耗时约8秒完成真实提炼，LLM正确提炼出key、tags、background、summary，embedding随后成功写入Neo4j和Qdrant（vector_sync成功），POST /search 接口成功检索返回结果，未出现降级告警，也没有旧xiaorong残留，证明deepseek‑v4‑pro 正常工作。0时38分，用户执行写后读一致性探针 PROBE‑ZXQV7731，该探针的执行依赖于之前的模型切换和降级子系统的启用，旨在验证“存后即搜不命中”问题在新链路下是否已消除。12时35分，用户创建验证探针 PROBE‑FIXV8842，用于在修复 ORDER BY updated_at DESC + top_k 转发后检验新保存的记忆是否能被 memos_search 立即命中；12时41分继续执行该探针以确认效果。13时44分，用户启动超时快速降级验证探针 PROBE‑FB9977，验证在 fallback 超时优化后，当 deepseek 主模型不可用时系统能否在 MCP 超时限制内快速降级至 LongCat 并成功保存。当天，用户修复了写后读不命中的根因：在 neo4j_community.py 的 get_all_memory_items 查询中加入 ORDER BY coalesce(n.updated_at,n.created_at) DESC，删除多余的打印语句；并在 start_api.py 的 SearchRequest 中增加 top_k 字段，使 /search 接口能够转发 MCP 的 top_k 参数。修复后，使用 PROBE‑FB9977 存入的记忆在 memos_search 中立即命中并排名第一。随后，用户对上述两项修复均完成端到端验证并通过，修复1通过 PROBE‑FB9977 验证写后读一致性，修复2通过模拟 deepseek 挂起场景验证在熔断机制下短记忆和长记忆均能成功降级保存。",
  "tags": [
    "oh-memos",
    "deepseek-v4-pro",
    "LLM",
    "fallback",
    "probe",
    "write-read consistency",
    "neo4j",
    "Qdrant",
    "embedding",
    "search",
    "full-chain verification",
    "debugging"
  ],
  "summary": "在2026年7月11日，用户完成了oh-memos项目的关键里程碑：将主模型切换至deepseek‑v4‑pro并加入自动降级到LongCat‑2.0的子系统，离线单测与全链路实测均顺利通过，证明模型正常工作。随后，用户在00:38发起写后读一致性探针PROBE‑ZXQV7731，以验证新模型和降级逻辑下“存后即搜不命中”问题已解决。下午12:35创建并在12:41执行了PROBE‑FIXV8842，检验ORDER BY更新排序与top_k转发修复后的即时搜索能力。13:44进行PROBE‑FB9977，确认超时后快速降级机制可在MCP超时内成功保存。用户还修复了neo4j查询缺少ORDER BY及/search未转发top_k的问题，并通过端到端验证确认两项修复均生效，写后读一致性得到恢复，降级机制在深度模型挂起时也能可靠工作。

## 关联

- 上级 → [[2026-07-11-端到端验证完成]]
- 上级 → [[2026-07-11-搜索写后读一致性问题修复]]
- 上级 → [[2026-07-11-probe-fb9977-超时快速降级验证]]
- 上级 → [[2026-07-11-写后读一致性修复验证探针-probe-fixv8842]]
- 上级 → [[2026-07-11-写后读一致性修复验证探针]]
- 上级 → [[2026-07-11-全链路验证通过]]
- 被导致 ← [[2026-07-11-修复存后即搜不命中问题-写后读一致性]]
- 被后续 ← [[2026-07-11-修复存后即搜不命中问题-写后读一致性]]
- 被前提 ← [[2026-07-11-写后读一致性探针测试]]
- 被后续 ← [[2026-07-11-写后读一致性探针测试]]
- 被导致 ← [[2026-07-11-全链路验证通过]]
- 被后续 ← [[2026-07-11-全链路验证通过]]
- 被导致 ← [[2026-07-11-llm主模型切换为deepseek-v4-pro]]
- 被后续 ← [[2026-07-11-llm主模型切换为deepseek-v4-pro]]

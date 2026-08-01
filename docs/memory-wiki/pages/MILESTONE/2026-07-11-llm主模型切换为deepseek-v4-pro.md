---
generator: oh-memos-wiki-export
id: 9ea5ce1b-549e-4334-836d-914eb4e8f5a1
type: MILESTONE
status: activated
tags: ["oh-memos", "LLM", "deepseek-v4-pro", "模型切换", "降级系统"]
confidence: 0.99
created: 2026-07-11T00:24:31.138557000+00:00
updated: 2026-07-11T00:24:31.752637000+00:00
---

# LLM主模型切换为deepseek-v4-pro

在2026年7月11日凌晨12:23，用户完成了oh-memos项目的LLM提炼主模型切换，从原有模型更换为deepseek-ai/deepseek-v4-pro，通过本地中转站http://localhost:3000/v1访问。同时新增了LLM自动降级子系统，当主模型超时或额度耗尽时自动降级到LongCat-2.0（https://api.longcat.chat/openai/v1）。

## 关联

- 被上级 ← [[2026-07-19-oh-memos-项目-llm-主模型切换与自动降级系统全面实现-memory-type-usermemory-valu]]
- 被前提 ← [[2026-07-11-写后读一致性探针测试]]
- 被相关 ← [[2026-07-11-写后读一致性探针测试]]
- 被导致 ← [[2026-07-11-全链路验证通过]]
- 导致 → [[2026-07-19-error-classification-model-verification-and-probing-on-july]]
- 后续 → [[2026-07-19-error-classification-model-verification-and-probing-on-july]]
- 相关 → [[2026-07-19-oh-memos-项目-llm-主模型切换与自动降级系统全面实现-memory-type-usermemory-valu]]
- 后续 → [[2026-07-19-oh-memos-项目-llm-主模型切换与自动降级系统全面实现-memory-type-usermemory-valu]]
- 导致 → [[2026-07-19-2026年7月11日-oh-memos-全链路验证-模型切换与写后读一致性修复-memory-type-usermemo]]
- 后续 → [[2026-07-19-2026年7月11日-oh-memos-全链路验证-模型切换与写后读一致性修复-memory-type-usermemo]]
- 后续 → [[2026-07-11-写后读一致性探针测试]]
- 后续 → [[2026-07-11-写后读一致性探针测试]]
- 导致 → [[2026-07-11-全链路验证通过]]

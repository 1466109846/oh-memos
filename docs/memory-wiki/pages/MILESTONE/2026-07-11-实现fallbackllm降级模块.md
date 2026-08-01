---
generator: oh-memos-wiki-export
id: ec35196c-3876-479d-be1e-1bc57d78f134
type: MILESTONE
status: activated
tags: ["oh-memos", "降级系统", "FallbackLLM", "错误分类", "重试策略"]
confidence: 0.99
created: 2026-07-11T00:24:31.259129000+00:00
updated: 2026-07-11T00:24:31.752637000+00:00
---

# 实现FallbackLLM降级模块

用户实现了LLM自动降级子系统，新增src/oh_memos/llms/fallback.py文件，包含FallbackLLM(BaseLLM)类。该模块实现了错误分类（classify_error）、指数退避重试策略（RetryPolicy）、生成与流式生成的降级（generate/generate_stream）、以及健康跟踪功能。错误分类逻辑独立，不依赖embedder模块。

## 关联

- 被上级 ← [[2026-07-19-oh-memos-项目-llm-主模型切换与自动降级系统全面实现-memory-type-usermemory-valu]]
- 被导致 ← [[2026-07-11-错误分类规则定义]]
- 前提 → [[2026-07-11-错误分类规则定义]]

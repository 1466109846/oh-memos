---
generator: oh-memos-wiki-export
id: e122ab65-9401-43e8-8581-71a1a4dc4a2a
type: PROGRESS
status: activated
tags: ["LLM", "deepseek-v4-pro", "LongCat-2.0", "fallback", "factory", "configuration", ".env", "circuit breaker", "neo4j", "oh-memos"]
confidence: 0.66
created: 2026-07-19T21:21:30.257990000+00:00
updated: 2026-07-19T21:21:30.257990000+00:00
---

# oh-memos 项目 LLM 主模型切换与自动降级系统全面实现",
  "memory_type": "UserMemory",
  "value": "2026年7月11日凌晨约00:23，用户在oh-memos项目中完成了以下关键改动

2026年7月11日凌晨约00:23，用户在oh-memos项目中完成了以下关键改动：\n1. 将记忆提炼使用的主语言模型切换为 deepseek‑ai/deepseek‑v4‑pro，并通过本地中转站 http://localhost:3000/v1 访问。\n2. 新增完整的LLM自动降级子系统，实现于 src/oh_memos/llms/fallback.py 的 FallbackLLM（继承 BaseLLM）类，包含：\n   - classify_error 方法对错误进行分类，新增 unresponsive 类别用于超时/连接错误，瞬时错误（如超时）可重试后降级，永久错误（如额度耗尽、鉴权失败）立即降级；\n   - RetryPolicy 实现指数退避重试；\n   - generate 与 generate_stream 在主模型失败后自动切换到降级模型 LongCat‑2.0（https://api.longcat.chat/openai/v1）；\n   - 健康跟踪与熔断器机制：主模型连续失败进入冷却期，仅走 fallback，避免多块记忆提炼时重复撞击主模型。\n3. 在 src/oh_memos/llms/factory.py 中的 LLMFactory.from_config 方法更新，使所有兼容 OpenAI 的后端（openai、azure、deepseek、qwen、vllm、openai_new）在实例化时自动包装为 FallbackLLM；本地 huggingface 与 ollama 后端保持不包装，避免二次包装。\n4. 在 src/oh_memos/configs/llm.py 中新增 LLMFallbackConfig 类，并在 configs/env_loader.py 中添加 llm_fallback_* 环境变量前缀及 get_llm_fallback_config() 函数。根目录 .env 中 MOS_CHAT_* 与 MEMRADER_* 均配置为 deepseek‑v4‑pro@localhost:3000，MOS_CHAT_FALLBACK_* 配置为 LongCat‑2.0。\n5. 排查并记录了 .env 配置的三大陷阱：src/.env 会覆盖根 .env 导致配置失效；行内注释未被剥离导致布尔值解析错误；GBK 与 UTF‑8 编码混杂导致中文注释乱码。用户删除/重命名 src/.env 并备份为 src/.env.bak‑shadowed‑root‑20260711，制定不在 .env 行值中写行内注释、使用 ASCII/英文注释的规则。\n6. 为解决 deepseek 超时导致的降级过慢问题，用户在 fallback.py、configs/llm.py、configs/env_loader.py 中做出修复：将 classify_error 中的 unresponsive 错误直接降级不重试；将主模型的 OpenAI 客户端 max_retries 设为 0，timeout 参数改为 primary_timeout（默认 60 秒，可通过 MOS_CHAT_FALLBACK_PRIMARY_TIMEOUT 配置）；增加熔断器，使主模型在冷却期内直接走 fallback。\n7. 为解决 Neo4j 写后读不一致问题，用户在 src/oh_memos/graph_dbs/neo4j_community.py 中为查询新增 ORDER BY 并传递 top_k 参数，使新保存的记忆能够立即被搜索到。\n8. 同时更新了 api/start_api.py、llms/fallback.py、configs/llm.py、configs/env_loader.py 等文件，以配合上述功能和修复。所有改动通过离线单元测试和全链路集成测试，单元测试全部通过，端到端从记忆提炼到 embedding 存储再到检索均成功，无降级告警，确认主模型正常工作。",
  "tags": [
    "LLM",
    "deepseek-v4-pro",
    "LongCat-2.0",
    "fallback",
    "factory",
    "configuration",
    ".env",
    "circuit breaker",
    "neo4j",
    "oh-memos"
  ],
  "summary": "在2026年7月11日凌晨，用户完成了oh-memos项目的关键里程碑：将记忆提炼主模型切换为deepseek‑v4‑pro并通过本地中转站访问，同时实现了完整的LLM自动降级子系统，新增FallbackLLM模块、错误分类、指数退避、健康跟踪与熔断器，并在工厂模式中自动包装兼容OpenAI的后端。用户还在配置层面加入LLMFallbackConfig，更新.env变量，并排查了三个常见的.env陷阱（覆盖、行内注释、编码混杂），予以修复。针对deepseek超时导致的降级慢问题，用户改进了错误分类、关闭主模型重试并加入熔断器，使降级更及时。随后，用户优化了Neo4j查询以解决写后读不一致，并更新了相关代码文件。所有改动经离线单元测试和全链路实测验证，均通过，系统运行稳定，未出现降级告警。

## 关联

- 上级 → [[2026-07-11-修改文件清单]]
- 上级 → [[2026-07-11-fallback超时降级与熔断器修复]]
- 上级 → [[2026-07-11-oh-memos-env-配置三大陷阱排查记录]]
- 上级 → [[2026-07-11-新增llm降级配置]]
- 上级 → [[2026-07-11-llm工厂模式更新]]
- 上级 → [[2026-07-11-实现fallbackllm降级模块]]
- 上级 → [[2026-07-11-llm主模型切换为deepseek-v4-pro]]
- 被相关 ← [[2026-07-11-修复存后即搜不命中问题-写后读一致性]]
- 被后续 ← [[2026-07-11-修复存后即搜不命中问题-写后读一致性]]
- 被前提 ← [[2026-07-11-写后读一致性探针测试]]
- 被后续 ← [[2026-07-11-写后读一致性探针测试]]
- 被导致 ← [[2026-07-11-oh-memos-env-配置三大陷阱排查记录]]
- 被后续 ← [[2026-07-11-oh-memos-env-配置三大陷阱排查记录]]
- 被相关 ← [[2026-07-11-llm主模型切换为deepseek-v4-pro]]
- 被后续 ← [[2026-07-11-llm主模型切换为deepseek-v4-pro]]

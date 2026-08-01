---
generator: oh-memos-wiki-export
id: 68d93232-6add-4bd6-a8ba-c4e8c832c2dc
type: GOTCHA
status: activated
tags: ["GOTCHA"]
confidence: 0.99
created: 2026-07-30T16:36:52.036587000+00:00
updated: 2026-07-30T16:36:52.037594000+00:00
---

# [GOTCHA] 凭证脱敏正则的 \b 陷阱:通用兜底模式原本写作 \b(?:api[_-]?key|secret|token|password|...)\b\

凭证脱敏正则的 \b 陷阱:通用兜底模式原本写作 \b(?:api[_-]?key|secret|token|password|...)\b\s*[:=]\s*(?P<secret>[A-Za-z0-9/+_-]{24,}),结果对 MEMOS_TOKEN=xxx、OPENAI_API_KEY=xxx、DB_PASSWORD=xxx、GITHUB_TOKEN=xxx 这类 env dump 形态**全部漏检**。

原因:\b 是「单词字符与非单词字符的边界」,而下划线 _ 属于单词字符([A-Za-z0-9_])。在 MEMOS_TOKEN 中 TOKEN 前面是 _,两侧都是单词字符 → 不存在边界 → \btoken 匹配失败。

这是最危险的一类漏检,因为密钥进入记忆最常见的方式就是粘贴一段 env dump。之前测试没暴露,是因为样例用的是 OPENAI_API_KEY=sk-...,值本身命中了 sk- 专用模式;换成本项目中转站(localhost:3000/v1)那种非 sk- 前缀的 key 就直接漏过去。

修复:前导 \b 改为非消费的负向后顾 (?<![A-Za-z0-9]),这样 _ 和 - 都算作合法分隔符,同时字符串开头也能匹配。**尾部的 \b 必须保留**,否则 tokenizer_path = /models/... 会被误伤。

文件:src/oh_memos/security/redact.py 的 labelled_credential 模式。回归测试见 tests/test_redact.py::test_env_var_shaped_credential_is_caught 与 test_tokenizer_path_is_not_a_token。

推广:任何用 \b 圈定「标识符单词」的正则,只要目标可能出现在 SCREAMING_SNAKE_CASE 里,\b 都不可靠。

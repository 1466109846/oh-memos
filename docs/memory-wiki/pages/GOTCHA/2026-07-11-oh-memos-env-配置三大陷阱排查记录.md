---
generator: oh-memos-wiki-export
id: ce72d7b2-415a-4c08-8e4f-b745f06439fa
type: GOTCHA
status: activated
tags: ["oh-memos", ".env", "环境变量", "配置陷阱", "排查", "load_dotenv", "编码", "注释"]
confidence: 0.99
created: 2026-07-11T00:26:13.847595000+00:00
updated: 2026-07-11T00:26:13.848600000+00:00
---

# oh-memos .env 配置三大陷阱排查记录

2026年7月11日凌晨，用户排查 oh-memos 项目时发现了三个与环境变量 .env 配置相关的重大陷阱，耗时较久并记录以备忘。第一个陷阱：src/.env 会覆盖根目录 .env，因为 api/config.py 中 load_dotenv(override=True) 的 bare 调用会从 src/oh_memos/api/ 向上查找到 src/.env，且 start.bat 从 src/ 启动 uvicorn，导致修改根 .env 的主模型和 API 配置不生效，被 src/.env 中的旧值（如 LongCat-Flash-Lite@www.xiaorong.site）覆盖。用户通过编写脚本对比 os.environ 与 .env 文件值发现了不一致，最终重命名/删除了 src/.env 并备份为 src/.env.bak-shadowed-root-20260711。第二个陷阱：行内注释会泄漏到环境变量值中，因为 env_loader._get_env 和 load_dotenv 仅做 .strip() 去首尾空白，不剥离行内 # 注释，导致如 'true # 注释' 的值使布尔判断失效，MOS_CHAT_FALLBACK_ENABLED 被静默禁用。规则是 .env 值行不要写行内注释。第三个陷阱：根 .env 存在 GBK/UTF-8 编码混杂，应用按系统 GBK 读取时，UTF-8 工具写入的中文注释在启动日志中显示为乱码，建议 .env 注释使用 ASCII 或英文。此外，用户还注意到存记忆功能依赖 API 在线提炼，API 故障时会报 HTTP 502 错误。

## 关联

- 被上级 ← [[2026-07-19-oh-memos-项目-llm-主模型切换与自动降级系统全面实现-memory-type-usermemory-valu]]
- 导致 → [[2026-07-19-oh-memos-项目-llm-主模型切换与自动降级系统全面实现-memory-type-usermemory-valu]]
- 后续 → [[2026-07-19-oh-memos-项目-llm-主模型切换与自动降级系统全面实现-memory-type-usermemory-valu]]

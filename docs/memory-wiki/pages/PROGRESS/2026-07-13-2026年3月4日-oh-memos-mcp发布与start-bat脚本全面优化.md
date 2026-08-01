---
generator: oh-memos-wiki-export
id: 37803a92-3573-4203-abc6-9b093e2b0210
type: PROGRESS
status: activated
tags: ["oh-memos-mcp", "npm包发布", "MCP迁移", "start.bat优化", "脚本修复", "性能优化", "数据库启动"]
confidence: 0.66
created: 2026-07-13T04:38:12.690742000+00:00
updated: 2026-07-13T04:38:12.690742000+00:00
---

# 2026年3月4日：oh-memos-mcp发布与start.bat脚本全面优化

在2026年3月4日，用户完成了一系列重要的开发与优化工作。首先，用户成功发布并完成了oh-memos-mcp npm包的1.0.0版本，标志着MCP迁移的成功完成。该版本修复了.env文件加载优先级以支持npx执行，完善了包含仓库信息的包元数据，创建了.env.example文档，将Claude的MCP配置从shell脚本更新为npm包使用，并验证了所有18个工具（包括memos_list_cubes、memos_search和memos_save）均能正常加载。其次，用户对本地启动脚本scripts/local/start.bat进行了全面修复与优化。在凌晨5:57，用户移除了UTF-8 BOM以避免cmd首行解析错误，将日志重构为4阶段输出，明确了数据库启动顺序为Neo4j -> Qdrant -> Ollama，并抽取了多个标签（:is_listening / :ensure_neo4j / :ensure_qdrant / :check_ollama / :load_env）以减少重复逻辑，同时保留了原有的Python环境探测机制（优先.venv，兼容conda_venv）和API启动流程。在上午8:15，用户修复了start.bat运行时报错“系统找不到指定的批处理标签 - wait_port_loop”的问题，将wait_port子程序改为使用for /l轮询实现，不再依赖子标签跳转，并保留了Neo4j（优先执行start-Neo4j.bat，失败回退到neo4j.bat start）和Qdrant（使用PowerShell的Start-Process）的非阻塞后台启动方式。此外，用户还移除了start.bat中用于防止WatchFiles触发重启循环的copy .env到src\.env操作和用于生产模式的--reload参数。最后，用户针对API启动缓慢的问题进行了性能优化。通过识别出串行注册所有cube是性能瓶颈，用户决定将启动逻辑改为仅注册默认cube，其余cube采用按需注册方式，新增了MEMOS_STARTUP_CUBES环境变量来控制启动cube数量，并添加了详细的注册耗时日志。同时，用户清理了由start.bat中echo命令重定向错误产生的Ollama相关垃圾文件。

## 关联

- 上级 → [[2026-03-10-清理ollama垃圾文件]]
- 上级 → [[2026-03-04-修复start-bat批处理标签错误]]
- 上级 → [[2026-03-04-批处理脚本修复与优化]]
- 上级 → [[2026-03-04-start-bat-optimization]]

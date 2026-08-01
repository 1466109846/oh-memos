---
generator: oh-memos-wiki-export
id: 645507e1-0e20-480e-bf24-399f106b0b89
type: PROGRESS
status: activated
tags: ["oh-memos", "Neo4j", "fallback", "超时修复", "端口冲突", "winnat", "Java 24", "G1 OOM", "ServiceUnavailable", "异常处理", "uvicorn重启", "deepseek", "Windows", "Hyper-V"]
confidence: 0.66
created: 2026-07-17T23:08:01.053957000+00:00
updated: 2026-07-17T23:08:01.053957000+00:00
---

# oh-memos项目Neo4j连接韧性与Fallback超时修复全记录

在2026年7月11日，用户针对oh-memos项目进行了两项关键Bug修复并端到端验证通过。首先，解决了存后即搜不命中的写后读一致性问题，通过为Neo4j的Cypher查询添加降序排序以及转发top_k参数，确保了刚存入的记忆能立即被搜索到。其次，修复了因deepseek超时导致fallback降级过慢而引发报错的问题，原因在于OpenAILLM的openai SDK客户端max_retries=3且read timeout=120s，导致单次调用内部重试时间过长，超出MCP 180s超时限制。修复方案为：(a)在fallback.py中将classify_error拆分，将超时/连接类错误归为新类别'unresponsive'并立即降级不重试；(b)新增FallbackLLM._fast_fail_primary()方法，将主模型客户端改为max_retries=0, timeout=primary_timeout（默认60s）；(c)新增LLMFallbackConfig.primary_timeout字段及MOS_CHAT_FALLBACK_PRIMARY_TIMEOUT环境变量。用户通过deepseek仍挂的情况下memos_save成功并回退到LongCat-2.0进行了验证。此次修改涉及5个核心文件：src/oh_memos/graph_dbs/neo4j_community.py、src/oh_memos/api/start_api.py、src/oh_memos/llms/fallback.py、src/oh_memos/configs/llm.py、src/oh_memos/configs/env_loader.py。由于uvicorn未开启热重载（未使用--reload参数），用户需从src/目录重启服务以使改动生效。

在2026年7月13日，用户排查并修复了oh-memos在Windows环境下因Neo4j连接失败引发的500错误。问题的核心在于Windows Hyper-V/WSL2的winnat服务将Neo4j所需的7687和7474端口动态保留进了TCP排除范围，导致Neo4j无法绑定端口（尽管netstat显示无监听）。用户使用管理员PowerShell命令修复了端口冲突：执行`net stop winnat`，然后运行`netsh int ipv4 add excludedportrange protocol=tcp startport=7687 numberofports=1 store=persistent`和`netsh int ipv4 add excludedportrange protocol=tcp startport=7474 numberofports=1 store=persistent`，最后执行`net start winnat`。修复后，端口变为带*号的管理排除状态，Neo4j可以显式绑定。验证结果为：运行start-Neo4j.bat后14秒Bolt 7687启动，memos_search命中。撤销命令为`netsh int ipv4 delete excludedportrange protocol=tcp startport=7687 numberofports=1 store=persistent`。

此外，用户还发现并修复了另一隐患：该机Neo4j 5.15运行在Java 24上（官方仅支持17），且neo4j.conf的堆内存使用自动计算加`-XX:+AlwaysPreTouch`，在内存抖动时触发了G1 mmap OOM（hs_err_pid*.log显示"insufficient memory ... G1 virtual space"）。用户通过在conf中显式设置heap为1g和pagecache为1g来规避此问题。

用户同时为oh-memos项目增加了Neo4j连接韧性，对齐了此前修复LLM WinError 10053的思路，认为瞬时连接错误是可恢复的。改动分为两部分：一是在Neo4jGraphDB的初始化中新增了带封顶指数退避的连接等待方法，将API先于Neo4j就绪的启动竞态从崩溃转为短暂等待，且因cube缓存机制，重试仅发生一次；二是在API层新增了ServiceUnavailable的异常处理器，在通用Exception handler之前新增了@app.exception_handler(neo4j.exceptions.ServiceUnavailable)，返回503及清晰提示而非裸500堆栈，并使用try/except ImportError守护注册过程（因为neo4j是可选后端，general_text模式可能未安装）。用户强调这两个文件的py_compile已通过，但当前运行的仍是旧代码，需要重启uvicorn（start.bat）才能让改动生效，不过运维层已通过winnat端口保留和启动Neo4j恢复了服务。

## 关联

- 上级 → [[2026-07-13-serviceunavailable异常处理器]]
- 上级 → [[2026-07-13-neo4j在java-24下的g1-mmap-oom隐患修复]]
- 上级 → [[2026-07-13-neo4j端口冲突的修复与验证]]
- 上级 → [[2026-07-11-修改文件与重启要求]]
- 上级 → [[2026-07-11-修复-fallback-超时降级过慢问题]]
- 被相关 ← [[2026-07-13-serviceunavailable异常处理器]]
- 被后续 ← [[2026-07-13-serviceunavailable异常处理器]]
- 被后续 ← [[2026-07-13-为oh-memos增加neo4j连接韧性]]
- 被相关 ← [[2026-07-13-为oh-memos增加neo4j连接韧性]]
- 被后续 ← [[2026-07-13-neo4j在java-24下的g1-mmap-oom隐患修复]]
- 被相关 ← [[2026-07-13-neo4j在java-24下的g1-mmap-oom隐患修复]]
- 被后续 ← [[2026-07-13-windows下neo4j端口冲突导致oh-memos-500错误]]
- 被相关 ← [[2026-07-13-windows下neo4j端口冲突导致oh-memos-500错误]]
- 被相关 ← [[2026-07-11-fallback超时降级与熔断器修复]]
- 被后续 ← [[2026-07-11-fallback超时降级与熔断器修复]]
- 被后续 ← [[2026-07-11-修复-fallback-超时降级过慢问题]]
- 被相关 ← [[2026-07-11-全链路验证通过]]
- 被后续 ← [[2026-07-11-全链路验证通过]]

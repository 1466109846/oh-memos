---
generator: oh-memos-wiki-export
id: 3af53222-872d-4a88-a7c8-3c86d524d22e
type: PROGRESS
status: activated
tags: ["uvicorn", "reload", ".env", "WSL", "Windows venv", "FastAPI", "TestClient", "OSError", "socket.socketpair", "ProactorEventLoop", "anyio", "intermittent failure", "real uvicorn instance", "urllib.request", "port conflict", "netstat", "PID", "Chinese output garbled", "Neo4j", "py_compile", "service restart", "GUI"]
confidence: 0.66
created: 2026-07-19T21:23:13.187700000+00:00
updated: 2026-07-19T21:23:13.187700000+00:00
---

# uvicorn 重载、WSL 环境下 FastAPI 测试与服务重启注意事项",
  "memory_type": "LongTermMemory",
  "value": "在 WSL 环境中使用 Windows 的 .venv\\Scr

在 WSL 环境中使用 Windows 的 .venv\\Scripts\\python.exe 运行 FastAPI/Starlette 的 TestClient 时，初始化 event loop 会因 socket.socketpair() 抛出 OSError [WinError 10022 无效参数]（ProactorEventLoop，在 anyio start_blocking_portal 处）而导致间歇性失败。解决办法是改用真实的 uvicorn 后台实例，并使用 urllib.request 轮询请求替代 TestClient，同时更换端口（例如使用 18011 规避已占用的 18010）。为区分后台孤儿进程与用户进程，可通过 `cmd.exe /c \"netstat -ano | findstr :端口\"` 获取 LISTENING 的 PID 并对比进程号。还需注意 Windows python.exe 在 WSL 终端输出中文时会出现 GBK/UTF-8 乱码，判断输出正确性应使用字符检测而非肉眼。uvicorn --reload 只监视 .py 文件，不会检测 .env 文件的变化；在 WSL 中修改位于 Windows 主机的文件即使触碰也可能不触发重载，需要手动在 Windows 的 run.bat 窗口使用 Ctrl+C 重启 API 进程。2026 年 4 月 18 日，用户因 .env 文件中未加引号的 inline 注释导致 API KEY 包含注释内容，进而在调用 LongCat、SiliconFlow 等外部服务时出现 401 认证错误，经过测试后将注释移到变量上方或对值加引号即解决。2026 年 7 月 13 日，为提升 Neo4j 连接的韧性，用户在 Neo4jGraphDB 初始化中加入指数退避的连接等待，并在 API 层增加 ServiceUnavailable 处理器，虽已通过 py_compile 检查，但仍需重启 uvicorn（start.bat）才能让改动生效。2026 年 7 月 19 日 21:20，用户再次提醒，任何代码修改后必须手动重启 GUI 服务，否则旧实例不会自动加载新代码。",
  "tags": [
    "uvicorn",
    "reload",
    ".env",
    "WSL",
    "Windows venv",
    "FastAPI",
    "TestClient",
    "OSError",
    "socket.socketpair",
    "ProactorEventLoop",
    "anyio",
    "intermittent failure",
    "real uvicorn instance",
    "urllib.request",
    "port conflict",
    "netstat",
    "PID",
    "Chinese output garbled",
    "Neo4j",
    "py_compile",
    "service restart",
    "GUI"
  ],
  "summary": "用户在 2026 年 4 月 18 日发现 .env 文件中的 inline 注释导致 API Key 被污染，引发 LongCat、SiliconFlow 等外部服务的 401 认证错误，解决办法是将注释移到变量上方或对值加引号。同时，uvicorn --reload 只监视 .py 文件，不会检测 .env 变化，尤其在 WSL 与 Windows 文件系统交叉时，需要手动在 Windows 的 run.bat 窗口 Ctrl+C 重启服务。2026 年 7 月 19 日，用户在 WSL 中使用 Windows 虚拟环境运行 FastAPI TestClient 时遭遇 OSError [WinError 10022]，导致测试间歇性失败，后改用真实的 uvicorn 实例并换端口（如 18011）解决，并通过 netstat‑PID 对比区分后台孤儿进程与用户进程。用户还注意到 Windows python 在 WSL 终端输出中文会出现 GBK/UTF‑8 乱码，需用字符检测判断。7 月 13 日和 19 日的记录中，用户强调所有代码修改后必须手动重启 uvicorn 或 GUI 服务，否则旧实例不会加载新代码。

## 关联

- 上级 → [[2026-07-13-需重启uvicorn生效]]
- 上级 → [[2026-04-18-uvicorn-reload-不监听-env-变化]]
- 被后续 ← [[2026-04-18-uvicorn-reload-不监听-env-变化]]
- 被相关 ← [[2026-04-18-uvicorn-reload-不监听-env-变化]]

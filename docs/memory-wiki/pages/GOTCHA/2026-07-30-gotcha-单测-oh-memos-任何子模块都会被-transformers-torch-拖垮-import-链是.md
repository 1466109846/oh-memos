---
generator: oh-memos-wiki-export
id: 3ef097dd-5aea-4d70-a385-a778c715f903
type: GOTCHA
status: activated
tags: ["GOTCHA"]
confidence: 0.99
created: 2026-07-30T16:37:55.138345000+00:00
updated: 2026-07-30T16:37:55.138345000+00:00
---

# [GOTCHA] 单测 oh_memos 任何子模块都会被 transformers/torch 拖垮:import 链是 oh_memos/__init__.

单测 oh_memos 任何子模块都会被 transformers/torch 拖垮:import 链是 oh_memos/__init__.py → configs.mem_cube → configs.memory → internet_retriever → mem_reader.factory → llms.base → types → memories.activation.item → transformers → torch。

后果:
1. WSL 系统 python3 缺 concurrent_log_handler,oh_memos/log.py 的 dictConfig 直接抛 ValueError: Unable to configure handler 'file';
2. 用项目自带的 Windows .venv/Scripts/python.exe(经 WSL interop 调用)会撞上 OSError [WinError 1114] c10.dll —— 即 DeskGo 覆盖 msvcp140.dll 那个老问题。

也就是说,一个只 import os 和 re 的纯 stdlib 模块(src/oh_memos/security/redact.py),单测却跑不起来。

解法:测试里不要 from oh_memos.xxx import,改用 importlib 按文件路径直接加载,绕开包的 __init__:

    _spec = importlib.util.spec_from_file_location("_redact_under_test", PATH)
    _mod = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)

对无内部依赖的模块,这与正常 import 完全等价,且让测试在 ML 栈损坏时依然可跑 —— 对安全原语来说这正是最需要能验证的时刻。参考 tests/test_redact.py 顶部。

另注:项目 .venv 里原本没装 pytest(pyproject 声明了但未安装),已补装 pytest 9.1.1;WSL 侧用系统 python3 -m pytest 即可跑该文件。

"""
启动 oh-memos 记忆管理 GUI。

用法(在项目根目录):
    .venv/bin/python tools/memory-admin/run.py         # Linux / WSL
    .venv\\Scripts\\python tools\\memory-admin\\run.py   # Windows

依赖(项目已有,无需额外安装):fastapi, uvicorn, neo4j, qdrant-client
"""

from __future__ import annotations

import os
import sys


# 确保能以 `import app / config / db_admin` 方式加载本目录模块,
# 无论从哪个工作目录启动。
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import config  # noqa: E402

import uvicorn  # noqa: E402


def main() -> None:
    import app  # noqa: E402  延迟导入,保证 sys.path 已就绪

    print("=" * 56)
    print("  oh-memos 记忆管理 GUI")
    print(f"  → http://{config.GUI_HOST}:{config.GUI_PORT}")
    print(f"  Neo4j : {config.NEO4J_URI} (db={config.NEO4J_DB_NAME})")
    qd = config.QDRANT_URL or f"{config.QDRANT_HOST}:{config.QDRANT_PORT}"
    print(f"  Qdrant: {qd}")
    print(f"  Cubes : {config.cubes_base_dir()}")
    print("=" * 56)
    uvicorn.run(app.app, host=config.GUI_HOST, port=config.GUI_PORT, log_level="info")


if __name__ == "__main__":
    main()

"""
读取项目根 .env,提供数据库连接与 cube 目录配置。

本工具独立于主 API(端口 18000)运行,直连 Neo4j + Qdrant + 文件系统,
因此即使主 API 未启动也能查询/删除记忆。

零新增依赖:优先使用 python-dotenv 解析 .env,若环境中没有该包,
则回退到内置的极简解析器(能处理项目 .env 里的行内注释与引号)。
"""

from __future__ import annotations

import os
import re

from pathlib import Path


# config.py 位于 tools/memory-admin/ 下,项目根在上溯两级
PROJECT_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = PROJECT_ROOT / ".env"


def _parse_env_line(line: str) -> tuple[str, str] | None:
    """解析单行 KEY=VALUE,处理引号与无引号值的行内注释。返回 (key, value) 或 None。"""
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        return None
    key, _, raw = line.partition("=")
    key = key.strip()
    if key.startswith("export "):
        key = key[len("export ") :].strip()
    if not key:
        return None

    raw = raw.strip()
    # 带引号的值:引号内原样保留(允许值中包含 # 等特殊字符,例如密码)
    if len(raw) >= 2 and raw[0] in "\"'" and raw[-1] == raw[0]:
        return key, raw[1:-1]

    # 无引号:去掉行内注释(空格 + # 之后视为注释),再去尾随空白
    value = re.split(r"\s+#", raw, maxsplit=1)[0].strip()
    return key, value


def _load_env() -> None:
    """把项目根 .env 加载进 os.environ(不覆盖已存在的真实环境变量)。"""
    if not ENV_PATH.is_file():
        return
    try:
        from dotenv import load_dotenv  # 优先使用标准库(项目通常已间接依赖)

        load_dotenv(ENV_PATH, override=False)
        return
    except Exception:
        pass  # 回退到内置解析器

    try:
        text = ENV_PATH.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return
    for line in text.splitlines():
        parsed = _parse_env_line(line)
        if parsed is None:
            continue
        k, v = parsed
        os.environ.setdefault(k, v)


_load_env()


def _get(name: str, default: str | None = None, *aliases: str) -> str | None:
    for key in (name, *aliases):
        val = os.environ.get(key)
        if val is not None and val.strip() != "":
            return val.strip()
    return default


# ---- Neo4j(图数据库)----
NEO4J_URI = _get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = _get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = _get("NEO4J_PASSWORD", "")
NEO4J_DB_NAME = _get("NEO4J_DB_NAME", "neo4j")
# 当前架构:Neo4j 社区版单库,靠节点属性 user_name(= cube_id)做逻辑隔离。
# 若将来切到 multi-db(每 cube 一个 database),需把 delete_cube 改为 drop database。
NEO4J_USE_MULTI_DB = (_get("MOS_NEO4J_SHARED_DB", "false") or "false").lower() == "true" and False

# ---- Qdrant(向量数据库)----
QDRANT_URL = _get("QDRANT_URL")  # 云端/远程地址,存在时优先
QDRANT_API_KEY = _get("QDRANT_API_KEY")
QDRANT_HOST = _get("QDRANT_HOST", "localhost")
QDRANT_PORT = int(_get("QDRANT_PORT", "16333") or "16333")

# 每个 cube 在 Qdrant 中对应一个 collection,命名规则:{cube_id}_graph
COLLECTION_SUFFIX = "_graph"


def collection_name(cube_id: str) -> str:
    return f"{cube_id}{COLLECTION_SUFFIX}"


def cube_id_from_collection(name: str) -> str | None:
    """从 collection 名反推 cube_id;不符合命名规则则返回 None。"""
    if name.endswith(COLLECTION_SUFFIX):
        return name[: -len(COLLECTION_SUFFIX)]
    return None


# ---- Cube 目录(文件系统)----
_cubes_dir_raw = _get("MEMOS_CUBES_DIR")


def cubes_base_dir() -> Path | None:
    """
    cube 目录根。MEMOS_CUBES_DIR 有时直接指向某个具体 cube(内含 config.json),
    这种情况下取其父目录作为根。
    """
    if not _cubes_dir_raw:
        return None
    p = Path(_cubes_dir_raw)
    if (p / "config.json").is_file():
        return p.parent
    return p


# ---- GUI 服务 ----
GUI_HOST = _get("MEMORY_ADMIN_HOST", "127.0.0.1")  # 只绑本机,不把删除能力暴露到网络
GUI_PORT = int(_get("MEMORY_ADMIN_PORT", "18010") or "18010")

BACKUP_DIR = Path(__file__).resolve().parent / "backups"

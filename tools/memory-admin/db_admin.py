"""
记忆管理核心:直连 Neo4j + Qdrant + 文件系统,提供查询、导出与删除能力。

数据分区(与 oh-memos 主程序一致):
- Neo4j:所有 cube 共享 `NEO4J_DB_NAME` 库,靠节点属性 `user_name`(= cube_id)隔离;label 为 `Memory`。
- Qdrant:每个 cube 一个 collection,命名 `{cube_id}_graph`。
- 文件系统:每个 cube 在 `MEMOS_CUBES_DIR` 下一个目录 + config.json。

彻底删除一个 cube = 三处一起清:Neo4j 节点 + Qdrant collection + cube 目录。
所有删除都提供 dry_run 预览,实删前自动导出 JSON 备份。
"""

from __future__ import annotations

import json
import re
import shutil

from datetime import datetime
from pathlib import Path
from typing import Any

import config


# ---- 连接单例(懒加载)----
_driver = None
_qdrant = None


def _prefer_ipv4_loopback(target: str) -> str:
    """Rewrite a localhost target to 127.0.0.1.

    On Windows 11 "localhost" resolves to ::1 first, but Docker publishes ports
    on 127.0.0.1 only. Every connection therefore waits out a ~5s IPv6 connect
    timeout before falling back to IPv4. Measured against this stack: Neo4j
    connect 21.05s -> 0.00s, Qdrant count() 5.02s -> 0.03s.
    """
    return re.sub(r"(?i)(?<=//)localhost(?=[:/]|$)", "127.0.0.1", target)


def get_driver():
    global _driver
    if _driver is None:
        from neo4j import GraphDatabase

        _driver = GraphDatabase.driver(
            _prefer_ipv4_loopback(config.NEO4J_URI),
            auth=(config.NEO4J_USER, config.NEO4J_PASSWORD),
        )
    return _driver


def get_qdrant():
    global _qdrant
    if _qdrant is None:
        from qdrant_client import QdrantClient

        if config.QDRANT_URL:
            _qdrant = QdrantClient(
                url=_prefer_ipv4_loopback(config.QDRANT_URL),
                api_key=config.QDRANT_API_KEY,
                check_compatibility=False,
            )
        else:
            host = config.QDRANT_HOST
            if host.lower() == "localhost":
                host = "127.0.0.1"
            _qdrant = QdrantClient(
                host=host,
                port=config.QDRANT_PORT,
                check_compatibility=False,
            )
    return _qdrant


def close() -> None:
    global _driver, _qdrant
    if _driver is not None:
        try:
            _driver.close()
        except Exception:
            pass
        _driver = None
    if _qdrant is not None:
        try:
            _qdrant.close()
        except Exception:
            pass
        _qdrant = None


def _run(query: str, **params) -> list[dict[str, Any]]:
    """在配置的 Neo4j 库上执行查询,返回记录字典列表。"""
    driver = get_driver()
    with driver.session(database=config.NEO4J_DB_NAME) as session:
        return [record.data() for record in session.run(query, **params)]


def _jsonable(value: Any) -> Any:
    """把 Neo4j 时间类型等转换为 JSON 可序列化的形式。"""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    for attr in ("iso_format", "isoformat"):
        fn = getattr(value, attr, None)
        if callable(fn):
            try:
                return fn()
            except Exception:
                pass
    return str(value)


# ================= 健康检查 =================
def ping() -> dict[str, Any]:
    """探测三个数据源是否可用,供前端提示。"""
    status: dict[str, Any] = {}

    try:
        get_driver().verify_connectivity()
        status["neo4j"] = {"ok": True, "uri": config.NEO4J_URI, "db": config.NEO4J_DB_NAME}
    except Exception as e:
        status["neo4j"] = {"ok": False, "error": str(e), "uri": config.NEO4J_URI}

    try:
        cols = get_qdrant().get_collections().collections
        status["qdrant"] = {"ok": True, "collections": len(cols)}
    except Exception as e:
        status["qdrant"] = {"ok": False, "error": str(e)}

    base = config.cubes_base_dir()
    status["cubes_dir"] = {
        "ok": bool(base and base.is_dir()),
        "path": str(base) if base else None,
    }
    return status


# ================= cube 列表 =================
def _neo4j_cube_counts() -> tuple[dict[str, int], str | None]:
    try:
        rows = _run(
            "MATCH (n:Memory) WHERE n.user_name IS NOT NULL "
            "RETURN n.user_name AS cube, count(n) AS nodes"
        )
        return {r["cube"]: r["nodes"] for r in rows if r.get("cube")}, None
    except Exception as e:
        return {}, str(e)


def _qdrant_cube_counts() -> tuple[dict[str, int], str | None]:
    try:
        client = get_qdrant()
        result: dict[str, int] = {}
        for col in client.get_collections().collections:
            cube = config.cube_id_from_collection(col.name)
            if cube is None:
                continue
            try:
                result[cube] = client.count(col.name, exact=True).count
            except Exception:
                result[cube] = -1  # collection 存在但计数失败
        return result, None
    except Exception as e:
        return {}, str(e)


def _fs_cubes() -> tuple[set[str], str | None]:
    base = config.cubes_base_dir()
    if not base or not base.is_dir():
        return set(), (None if base is None else f"目录不存在: {base}")
    try:
        return {p.name for p in base.iterdir() if p.is_dir()}, None
    except OSError as e:
        return set(), str(e)


def list_cubes() -> dict[str, Any]:
    neo_counts, neo_err = _neo4j_cube_counts()
    qd_counts, qd_err = _qdrant_cube_counts()
    fs_cubes, fs_err = _fs_cubes()

    all_ids = set(neo_counts) | set(qd_counts) | fs_cubes
    cubes = []
    for cube_id in sorted(all_ids):
        sources = []
        if cube_id in neo_counts:
            sources.append("neo4j")
        if cube_id in qd_counts:
            sources.append("qdrant")
        if cube_id in fs_cubes:
            sources.append("dir")
        cubes.append(
            {
                "cube_id": cube_id,
                "neo4j_nodes": neo_counts.get(cube_id),
                "qdrant_points": qd_counts.get(cube_id),
                "has_dir": cube_id in fs_cubes,
                "sources": sources,
                # 孤儿:数据只残留在部分数据源(通常是删除不彻底或异常残留)
                "orphan": len(sources) < 3,
            }
        )
    return {
        "cubes": cubes,
        "errors": {k: v for k, v in {"neo4j": neo_err, "qdrant": qd_err, "cubes_dir": fs_err}.items() if v},
    }


# ================= 记忆查询 =================
_LIST_FIELDS = (
    "n.id AS id, n.memory AS memory, n.memory_type AS memory_type, "
    "n.created_at AS created_at, n.updated_at AS updated_at, "
    "n.status AS status, n.key AS key"
)


def list_memories(cube_id: str, q: str | None = None, limit: int = 50, offset: int = 0) -> dict[str, Any]:
    """列出某 cube 的记忆(不含 embedding 向量)。支持关键词过滤与分页。"""
    where = "n.user_name = $cube"
    params: dict[str, Any] = {"cube": cube_id, "limit": int(limit), "offset": int(offset)}
    if q:
        where += " AND toLower(n.memory) CONTAINS toLower($q)"
        params["q"] = q

    total = _run(f"MATCH (n:Memory) WHERE {where} RETURN count(n) AS c", **{k: v for k, v in params.items() if k in ("cube", "q")})
    total_count = total[0]["c"] if total else 0

    rows = _run(
        f"MATCH (n:Memory) WHERE {where} "
        f"RETURN {_LIST_FIELDS} "
        "ORDER BY n.created_at DESC, n.id "
        "SKIP $offset LIMIT $limit",
        **params,
    )
    return {
        "cube_id": cube_id,
        "total": total_count,
        "limit": int(limit),
        "offset": int(offset),
        "memories": [_jsonable(r) for r in rows],
    }


def get_memory(cube_id: str, memory_id: str) -> dict[str, Any] | None:
    """单条记忆详情:全部元数据(剥离 embedding 向量)+ 关联边。"""
    rows = _run(
        "MATCH (n:Memory) WHERE n.user_name = $cube AND n.id = $id RETURN properties(n) AS props",
        cube=cube_id,
        id=memory_id,
    )
    if not rows:
        return None
    props = rows[0]["props"] or {}
    embedding = props.pop("embedding", None)
    emb_info = {"has_embedding": embedding is not None, "dim": len(embedding) if isinstance(embedding, list) else None}

    edges = _run(
        "MATCH (n:Memory {id: $id})-[r]-(m:Memory) WHERE n.user_name = $cube "
        "RETURN type(r) AS rel, m.id AS other_id, m.memory AS other_memory, "
        "CASE WHEN startNode(r).id = $id THEN 'out' ELSE 'in' END AS direction LIMIT 200",
        cube=cube_id,
        id=memory_id,
    )
    return {
        "cube_id": cube_id,
        "memory_id": memory_id,
        "properties": _jsonable(props),
        "embedding": emb_info,
        "edges": [_jsonable(e) for e in edges],
    }


# ================= 导出 / 备份 =================
def export_cube(cube_id: str) -> dict[str, Any]:
    """导出某 cube 的 Neo4j 节点(含 embedding)与边,附 Qdrant 统计。用于删除前备份。"""
    nodes = _run(
        "MATCH (n:Memory) WHERE n.user_name = $cube RETURN properties(n) AS props",
        cube=cube_id,
    )
    edges = _run(
        "MATCH (a:Memory)-[r]->(b:Memory) WHERE a.user_name = $cube AND b.user_name = $cube "
        "RETURN a.id AS source, b.id AS target, type(r) AS type, properties(r) AS props",
        cube=cube_id,
    )
    qd_points = None
    try:
        qd_points = get_qdrant().count(config.collection_name(cube_id), exact=True).count
    except Exception:
        qd_points = None

    return {
        "cube_id": cube_id,
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "neo4j": {
            "nodes": [_jsonable(n["props"]) for n in nodes],
            "edges": [_jsonable(e) for e in edges],
            "node_count": len(nodes),
            "edge_count": len(edges),
        },
        "qdrant": {"collection": config.collection_name(cube_id), "point_count": qd_points},
    }


def _write_backup(payload: dict[str, Any], label: str) -> str:
    config.BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = config.BACKUP_DIR / f"{label}_{ts}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(path)


# ================= 删除:整个 cube =================
def _cube_dir(cube_id: str) -> Path | None:
    base = config.cubes_base_dir()
    if not base:
        return None
    d = base / cube_id
    return d if d.is_dir() else None


def delete_cube_preview(cube_id: str) -> dict[str, Any]:
    """干跑:统计将删除的 Neo4j 节点数、Qdrant collection/向量数、cube 目录。不改动任何数据。"""
    report: dict[str, Any] = {"cube_id": cube_id, "dry_run": True}

    try:
        rows = _run("MATCH (n:Memory) WHERE n.user_name = $cube RETURN count(n) AS c", cube=cube_id)
        report["neo4j_nodes"] = rows[0]["c"] if rows else 0
    except Exception as e:
        report["neo4j_nodes"] = None
        report["neo4j_error"] = str(e)

    coll = config.collection_name(cube_id)
    try:
        client = get_qdrant()
        exists = client.collection_exists(coll)
        report["qdrant_collection"] = coll if exists else None
        report["qdrant_points"] = client.count(coll, exact=True).count if exists else None
    except Exception as e:
        report["qdrant_collection"] = coll
        report["qdrant_points"] = None
        report["qdrant_error"] = str(e)

    d = _cube_dir(cube_id)
    report["cube_dir"] = str(d) if d else None
    return report


def delete_cube(cube_id: str) -> dict[str, Any]:
    """
    彻底删除一个 cube:先导出备份,再依次清 Neo4j 节点、Qdrant collection、cube 目录。
    每一步独立记录成败,单步失败不阻断其余步骤。
    """
    report: dict[str, Any] = {"cube_id": cube_id, "dry_run": False, "steps": []}

    # 1) 删除前自动备份
    try:
        payload = export_cube(cube_id)
        report["backup_path"] = _write_backup(payload, f"cube_{cube_id}")
        report["steps"].append({"target": "backup", "status": "ok", "detail": report["backup_path"]})
    except Exception as e:
        report["backup_path"] = None
        report["steps"].append({"target": "backup", "status": "error", "detail": str(e)})

    # 2) Neo4j:删除该 cube 的全部 Memory 节点
    if config.NEO4J_USE_MULTI_DB:
        report["steps"].append(
            {"target": "neo4j", "status": "skipped", "detail": "multi-db 模式请改用 drop database(当前架构为单库,不会走到这里)"}
        )
    else:
        try:
            deleted = _run(
                "MATCH (n:Memory) WHERE n.user_name = $cube "
                "WITH n LIMIT 100000 DETACH DELETE n RETURN count(n) AS c",
                cube=cube_id,
            )
            n = deleted[0]["c"] if deleted else 0
            report["steps"].append({"target": "neo4j", "status": "ok", "detail": f"删除 {n} 个节点"})
        except Exception as e:
            report["steps"].append({"target": "neo4j", "status": "error", "detail": str(e)})

    # 3) Qdrant:删除该 cube 的 collection
    coll = config.collection_name(cube_id)
    try:
        client = get_qdrant()
        if client.collection_exists(coll):
            client.delete_collection(coll)
            report["steps"].append({"target": "qdrant", "status": "ok", "detail": f"删除 collection {coll}"})
        else:
            report["steps"].append({"target": "qdrant", "status": "skipped", "detail": f"collection {coll} 不存在"})
    except Exception as e:
        report["steps"].append({"target": "qdrant", "status": "error", "detail": str(e)})

    # 4) 文件系统:删除 cube 目录
    d = _cube_dir(cube_id)
    if d:
        try:
            shutil.rmtree(d)
            report["steps"].append({"target": "dir", "status": "ok", "detail": f"删除目录 {d}"})
        except Exception as e:
            report["steps"].append({"target": "dir", "status": "error", "detail": str(e)})
    else:
        report["steps"].append({"target": "dir", "status": "skipped", "detail": "目录不存在"})

    report["ok"] = all(s["status"] != "error" for s in report["steps"])
    return report


def delete_cubes(cube_ids: list[str]) -> dict[str, Any]:
    """批量彻底删除多个 cube。逐个调用 delete_cube —— 每个 cube 各自独立备份与容错,单个失败不影响其余。"""
    results = [delete_cube(cid) for cid in cube_ids]
    return {
        "requested": len(cube_ids),
        "succeeded": sum(1 for r in results if r.get("ok")),
        "failed": sum(1 for r in results if not r.get("ok")),
        "results": results,
    }


# ================= 删除:单条记忆 =================
def delete_memory_preview(cube_id: str, memory_id: str) -> dict[str, Any]:
    """干跑:确认单条记忆存在并展示将删除的内容与关联边数。"""
    detail = get_memory(cube_id, memory_id)
    if detail is None:
        return {"cube_id": cube_id, "memory_id": memory_id, "found": False, "dry_run": True}
    return {
        "cube_id": cube_id,
        "memory_id": memory_id,
        "found": True,
        "dry_run": True,
        "memory": (detail["properties"] or {}).get("memory"),
        "memory_type": (detail["properties"] or {}).get("memory_type"),
        "edge_count": len(detail["edges"]),
    }


def delete_memory(cube_id: str, memory_id: str) -> dict[str, Any]:
    """删除单条记忆:先把该节点备份落盘,再从 Neo4j 与 Qdrant 中删除。"""
    report: dict[str, Any] = {"cube_id": cube_id, "memory_id": memory_id, "steps": []}

    detail = get_memory(cube_id, memory_id)
    if detail is None:
        report["ok"] = False
        report["error"] = "记忆不存在"
        return report

    # 1) 备份(含完整属性,通过 export 的单节点形式)
    try:
        nodes = _run(
            "MATCH (n:Memory) WHERE n.user_name = $cube AND n.id = $id RETURN properties(n) AS props",
            cube=cube_id,
            id=memory_id,
        )
        payload = {
            "cube_id": cube_id,
            "memory_id": memory_id,
            "exported_at": datetime.now().isoformat(timespec="seconds"),
            "node": _jsonable(nodes[0]["props"]) if nodes else None,
            "edges": detail["edges"],
        }
        report["backup_path"] = _write_backup(payload, f"mem_{cube_id}_{memory_id}")
        report["steps"].append({"target": "backup", "status": "ok", "detail": report["backup_path"]})
    except Exception as e:
        report["backup_path"] = None
        report["steps"].append({"target": "backup", "status": "error", "detail": str(e)})

    # 2) Neo4j 删除节点
    try:
        deleted = _run(
            "MATCH (n:Memory) WHERE n.user_name = $cube AND n.id = $id "
            "DETACH DELETE n RETURN count(n) AS c",
            cube=cube_id,
            id=memory_id,
        )
        n = deleted[0]["c"] if deleted else 0
        report["steps"].append({"target": "neo4j", "status": "ok" if n else "skipped", "detail": f"删除 {n} 个节点"})
    except Exception as e:
        report["steps"].append({"target": "neo4j", "status": "error", "detail": str(e)})

    # 3) Qdrant 删除对应向量点(point id 与 Neo4j node id 一致)
    coll = config.collection_name(cube_id)
    try:
        from qdrant_client.http import models

        client = get_qdrant()
        if client.collection_exists(coll):
            client.delete(collection_name=coll, points_selector=models.PointIdsList(points=[memory_id]))
            report["steps"].append({"target": "qdrant", "status": "ok", "detail": f"从 {coll} 删除向量点"})
        else:
            report["steps"].append({"target": "qdrant", "status": "skipped", "detail": f"collection {coll} 不存在"})
    except Exception as e:
        report["steps"].append({"target": "qdrant", "status": "error", "detail": str(e)})

    report["ok"] = all(s["status"] != "error" for s in report["steps"])
    return report


# ================= 备份管理 =================
def list_backups() -> dict[str, Any]:
    """列出 backups/ 下的 JSON 备份文件及元信息(大小、时间、来源 cube、节点数)。"""
    d = config.BACKUP_DIR
    items: list[dict[str, Any]] = []
    if d.is_dir():
        for f in sorted(d.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            st = f.stat()
            info: dict[str, Any] = {
                "filename": f.name,
                "size": st.st_size,
                "modified": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
                "kind": "unknown",
            }
            try:  # 读取备份内容里的摘要(容错:损坏文件也照样能列出/删除)
                data = json.loads(f.read_text(encoding="utf-8"))
                info["cube_id"] = data.get("cube_id")
                if "neo4j" in data:
                    info["kind"] = "cube"
                    info["node_count"] = data["neo4j"].get("node_count")
                elif "memory_id" in data:
                    info["kind"] = "memory"
                    info["memory_id"] = data.get("memory_id")
            except Exception:
                pass
            items.append(info)
    return {"dir": str(d), "count": len(items), "backups": items}


def _safe_backup_path(filename: str) -> Path:
    """把文件名安全解析到 BACKUP_DIR 内,阻止路径穿越(../、绝对路径、子目录)。"""
    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        raise ValueError("非法文件名")
    base = config.BACKUP_DIR.resolve()
    p = (base / filename).resolve()
    if p != base and base not in p.parents:
        raise ValueError("路径越界")
    return p


def delete_backup(filename: str) -> dict[str, Any]:
    """删除单个备份文件(仅删 backups/ 内的文件,不影响数据库中的现有数据)。"""
    p = _safe_backup_path(filename)
    if not p.is_file():
        return {"filename": filename, "ok": False, "error": "文件不存在"}
    p.unlink()
    return {"filename": filename, "ok": True}


# ================= vector_sync 对账 =================
def _embed_texts(texts: list[str]) -> list[list[float]]:
    """用 .env 里的 embedder(OpenAI 兼容 /embeddings)重算向量。"""
    import os
    import urllib.request

    base = (os.environ.get("MOS_EMBEDDER_API_BASE") or os.environ.get("OPENAI_API_BASE") or "").rstrip("/")
    key = os.environ.get("MOS_EMBEDDER_API_KEY") or os.environ.get("OPENAI_API_KEY") or ""
    model = os.environ.get("MOS_EMBEDDER_MODEL", "BAAI/bge-m3")
    if not base:
        raise RuntimeError("MOS_EMBEDDER_API_BASE / OPENAI_API_BASE 未配置")
    req = urllib.request.Request(
        f"{base}/embeddings",
        data=json.dumps({"model": model, "input": texts}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read())
    return [d["embedding"] for d in data["data"]]


def repair_failed_vectors(dry_run: bool = False) -> dict[str, Any]:
    """
    对账 vector_sync='failed' 的节点:重算 embedding 补写 Qdrant,并把节点改回 success。
    这些节点在图里存在但被语义检索过滤(search 只认 success),不修复就永久不可见。
    空内容节点无法 embed,单独列出(建议删除)。
    """
    rows = _run(
        "MATCH (n:Memory) WHERE n.vector_sync='failed' "
        "RETURN n.id AS id, n.user_name AS cube, n.memory AS memory, properties(n) AS props"
    )
    repairable = [r for r in rows if (r.get("memory") or "").strip()]
    empty = [{"id": r["id"], "cube": r["cube"]} for r in rows if not (r.get("memory") or "").strip()]
    report: dict[str, Any] = {"found": len(rows), "repairable": len(repairable), "empty_skipped": empty, "dry_run": dry_run, "repaired": []}
    if dry_run or not repairable:
        return report

    from qdrant_client.http import models

    qc = get_qdrant()
    vectors = _embed_texts([r["memory"] for r in repairable])
    for r, vec in zip(repairable, vectors):
        cube, nid = r["cube"], r["id"]
        coll = config.collection_name(cube)
        payload = {k: _jsonable(v) for k, v in (r["props"] or {}).items() if k != "embedding"}
        payload["vector_sync"] = "success"
        try:
            if not qc.collection_exists(coll):
                report["repaired"].append({"id": nid, "cube": cube, "ok": False, "error": f"collection {coll} 不存在"})
                continue
            qc.upsert(collection_name=coll, points=[models.PointStruct(id=nid, vector=vec, payload=payload)])
            _run("MATCH (n:Memory {id:$id}) SET n.vector_sync='success'", id=nid)
            report["repaired"].append({"id": nid, "cube": cube, "ok": True})
        except Exception as e:
            report["repaired"].append({"id": nid, "cube": cube, "ok": False, "error": str(e)})
    report["ok"] = all(x.get("ok") for x in report["repaired"]) if report["repaired"] else True
    return report

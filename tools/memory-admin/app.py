"""
oh-memos 记忆管理 GUI —— FastAPI 后端。

直连 Neo4j + Qdrant + 文件系统(见 db_admin),独立于主 API 运行。
所有端点使用同步 def:FastAPI 会将其调度到线程池执行,避免同步数据库调用
阻塞事件循环(这是主 API 曾经踩过的坑)。

删除三重保护:
1) 二次确认 —— 删 cube 需在 query 传 confirm=<cube_id> 校验;
2) 干跑预览 —— *-preview 端点只统计影响范围,不改数据;
3) 删前备份 —— 实删端点在 db_admin 内部先导出 JSON 到 backups/。
"""

from __future__ import annotations

import json

from contextlib import asynccontextmanager
from pathlib import Path

import config
import db_admin

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse, Response
from pydantic import BaseModel


STATIC_DIR = Path(__file__).resolve().parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    db_admin.close()


app = FastAPI(title="oh-memos 记忆管理", lifespan=lifespan)


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    html = STATIC_DIR / "index.html"
    if not html.is_file():
        raise HTTPException(status_code=500, detail="index.html 缺失")
    return HTMLResponse(html.read_text(encoding="utf-8"))


@app.get("/api/health")
def health() -> JSONResponse:
    return JSONResponse(db_admin.ping())


@app.get("/api/cubes")
def cubes() -> JSONResponse:
    return JSONResponse(db_admin.list_cubes())


@app.get("/api/cubes/{cube_id}/memories")
def memories(
    cube_id: str,
    q: str | None = Query(default=None, description="按记忆内容关键词过滤"),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> JSONResponse:
    return JSONResponse(db_admin.list_memories(cube_id, q=q, limit=limit, offset=offset))


@app.get("/api/cubes/{cube_id}/memories/{memory_id}")
def memory_detail(cube_id: str, memory_id: str) -> JSONResponse:
    detail = db_admin.get_memory(cube_id, memory_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="记忆不存在")
    return JSONResponse(detail)


@app.get("/api/cubes/{cube_id}/export")
def export(cube_id: str) -> Response:
    payload = db_admin.export_cube(cube_id)
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    return Response(
        content=body,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{cube_id}_export.json"'},
    )


# ---- 删除:整个 cube ----
@app.post("/api/cubes/{cube_id}/delete-preview")
def cube_delete_preview(cube_id: str) -> JSONResponse:
    return JSONResponse(db_admin.delete_cube_preview(cube_id))


@app.delete("/api/cubes/{cube_id}")
def cube_delete(
    cube_id: str,
    confirm: str = Query(..., description="必须等于 cube_id 才执行,防误删"),
) -> JSONResponse:
    if confirm != cube_id:
        raise HTTPException(status_code=400, detail=f"确认名称不匹配:请输入 “{cube_id}” 以确认删除")
    return JSONResponse(db_admin.delete_cube(cube_id))


# ---- 批量删除多个 cube ----
class BatchDeleteReq(BaseModel):
    cube_ids: list[str]
    confirm: str | None = None


@app.post("/api/cubes/batch-delete-preview")
def batch_delete_preview(req: BatchDeleteReq) -> JSONResponse:
    previews = [db_admin.delete_cube_preview(c) for c in req.cube_ids]
    aggregate = {
        "count": len(previews),
        "neo4j_nodes": sum((p.get("neo4j_nodes") or 0) for p in previews),
        "qdrant_points": sum((p.get("qdrant_points") or 0) for p in previews),
    }
    return JSONResponse({"previews": previews, "aggregate": aggregate})


@app.post("/api/cubes/batch-delete")
def batch_delete(req: BatchDeleteReq) -> JSONResponse:
    # 批量删除用 Y 确认(逐个输入 cube 名不现实),与单删的 confirm 同属「二次确认」防护层
    if (req.confirm or "").strip().lower() not in ("y", "yes"):
        raise HTTPException(status_code=400, detail="批量删除需要输入 Y 确认")
    if not req.cube_ids:
        raise HTTPException(status_code=400, detail="未选择任何 cube")
    return JSONResponse(db_admin.delete_cubes(req.cube_ids))


# ---- 删除:单条记忆 ----
@app.post("/api/cubes/{cube_id}/memories/{memory_id}/delete-preview")
def memory_delete_preview(cube_id: str, memory_id: str) -> JSONResponse:
    return JSONResponse(db_admin.delete_memory_preview(cube_id, memory_id))


@app.delete("/api/cubes/{cube_id}/memories/{memory_id}")
def memory_delete(cube_id: str, memory_id: str) -> JSONResponse:
    return JSONResponse(db_admin.delete_memory(cube_id, memory_id))


# ---- 备份管理 ----
@app.get("/api/backups")
def backups_list() -> JSONResponse:
    return JSONResponse(db_admin.list_backups())


@app.get("/api/backups/{filename}/download")
def backup_download(filename: str) -> Response:
    try:
        p = db_admin._safe_backup_path(filename)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not p.is_file():
        raise HTTPException(status_code=404, detail="备份不存在")
    return Response(
        content=p.read_text(encoding="utf-8"),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.delete("/api/backups/{filename}")
def backup_delete(filename: str) -> JSONResponse:
    try:
        return JSONResponse(db_admin.delete_backup(filename))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ---- vector_sync 对账 ----
@app.post("/api/repair-vectors")
def repair_vectors(dry_run: bool = Query(default=False)) -> JSONResponse:
    return JSONResponse(db_admin.repair_failed_vectors(dry_run=dry_run))

import logging

from oh_memos.api.handlers.base_handler import BaseHandler, HandlerDependencies
from oh_memos.api.product_models import (
    APIGraphRequest,
    APISchemaRequest,
    APITracePathRequest,
    GraphData,
    GraphResponse,
    PathEdge,
    PathNode,
    SchemaData,
    SchemaResponse,
    TracePath,
    TracePathData,
    TracePathResponse,
)


logger = logging.getLogger(__name__)


def neo4j_schema_stats(sample_size: int, mem_cube_id: str | None = None) -> dict:
    """图 schema 统计。**唯一实现**，start_api 与 GraphHandler 共用。

    ## 为什么是唯一路径而非 fallback

    `get_schema_stats` 在 graph_dbs/ 下从未实现（neo4j.py 里那处只是 docstring
    提到返回结构），所以 `hasattr(graph_db, "get_schema_stats")` 恒为 False。

    ## 修掉的三处缺陷

    1. `avg_connections` / `max_connections` / `orphan_nodes` 从初始化的 0 起
       **没被赋值过** —— 不是算错，是根本没算。实测某 cube 有 6430 个带边节点、
       25781 条边，报告却是 avg 0.00 / max 0，而健康评估同时输出「连接良好」
       与「平均连接过低」，自证矛盾。修好后实测 avg 6.83 / max 151，
       原先那句「建议丰富关系」是基于坏数字给出的错误建议。
    2. 查询是裸 `MATCH (n:Memory)`，**不按 cube 过滤** → 返回全库合计
       （实测某 cube 6534 节点却报 7878 = 所有 cube 之和）。
    3. `memory_types` / `time_range` 同样从未被填充。

    ## 为什么收敛成一份

    此前 start_api.py 与 graph_handler.py 各有一份逐行重复的实现，
    两份**各自**漏掉了同样的东西 —— 重复本身就是缺陷成因。

    节点上区分 cube 的属性是 `user_name`（实测值形如 `jincaizhaopin_cube`）。
    """
    import os

    import httpx

    neo4j_url = os.environ.get("NEO4J_HTTP_URL", "http://localhost:7474/db/neo4j/tx/commit")
    neo4j_user = os.environ.get("NEO4J_USER", "neo4j")
    neo4j_password = os.environ.get("NEO4J_PASSWORD", "12345678")

    stats = {
        "total_nodes": 0,
        "total_edges": 0,
        "edge_types": {},
        "memory_types": {},
        "top_tags": [],
        "avg_connections": 0.0,
        "max_connections": 0,
        "orphan_nodes": 0,
        "time_range": {},
    }

    # mem_cube_id 缺失时退回全库统计（保持旧行为），但那种数字只应作为
    # 部署总量看，不能当单 cube 诊断依据。
    scope = "WHERE n.user_name = $cube" if mem_cube_id else ""
    edge_scope = "WHERE a.user_name = $cube" if mem_cube_id else ""
    params = {"cube": mem_cube_id} if mem_cube_id else {}

    def run(statement: str) -> list:
        """跑一条 Cypher。任何失败返回空列表 —— schema 是诊断接口，
        取不到某一项不该让整个响应失败。"""
        try:
            resp = httpx.post(
                neo4j_url,
                json={"statements": [{"statement": statement, "parameters": params}]},
                auth=(neo4j_user, neo4j_password),
                timeout=30,
            )
            if resp.status_code != 200:
                return []
            payload = resp.json()
            if payload.get("errors"):
                logger.warning(f"Neo4j schema query error: {payload['errors'][:1]}")
                return []
            return payload.get("results", [{}])[0].get("data", [])
        except Exception as exc:
            logger.error(f"Neo4j schema query failed: {exc}")
            return []

    rows = run(f"MATCH (n:Memory) {scope} RETURN count(n) AS cnt")
    if rows:
        stats["total_nodes"] = rows[0].get("row", [0])[0]

    rows = run(f"MATCH (a:Memory)-[r]->(:Memory) {edge_scope} RETURN count(r) AS cnt")
    if rows:
        stats["total_edges"] = rows[0].get("row", [0])[0]

    for r in run(
        f"MATCH (a:Memory)-[r]->(:Memory) {edge_scope} RETURN type(r) AS t, count(r) AS cnt"
    ):
        row = r.get("row", [])
        if len(row) >= 2:
            stats["edge_types"][row[0]] = row[1]

    for r in run(
        f"MATCH (n:Memory) {scope} RETURN coalesce(n.type, '(none)') AS t, count(n) AS cnt"
    ):
        row = r.get("row", [])
        if len(row) >= 2:
            stats["memory_types"][row[0]] = row[1]

    # 度数统计。此前完全缺失，是 avg 0.00 / max 0 的直接原因。
    # 用无向度数（`--`）：扩散检索两个方向都会走，只算出度会低估连通性。
    degree_rows = run(
        f"MATCH (n:Memory) {scope} "
        "WITH n, size([(n)--() | 1]) AS deg "
        "RETURN avg(toFloat(deg)) AS avgDeg, max(deg) AS maxDeg, "
        "sum(CASE WHEN deg = 0 THEN 1 ELSE 0 END) AS orphans"
    )
    if degree_rows:
        row = degree_rows[0].get("row", [])
        if len(row) >= 3:
            stats["avg_connections"] = round(float(row[0] or 0.0), 2)
            stats["max_connections"] = int(row[1] or 0)
            stats["orphan_nodes"] = int(row[2] or 0)

    time_clause = (
        f"MATCH (n:Memory) {scope} AND n.created_at IS NOT NULL"
        if mem_cube_id
        else "MATCH (n:Memory) WHERE n.created_at IS NOT NULL"
    )
    time_rows = run(
        f"{time_clause} RETURN min(n.created_at) AS earliest, max(n.created_at) AS latest"
    )
    if time_rows:
        row = time_rows[0].get("row", [])
        if len(row) >= 2 and row[0]:
            stats["time_range"] = {"earliest": str(row[0]), "latest": str(row[1])}

    return stats


class GraphHandler(BaseHandler):
    """Handler for graph-related operations."""

    def __init__(self, dependencies: HandlerDependencies):
        super().__init__(dependencies)

    def handle_get_graph_data(self, graph_req: APIGraphRequest) -> GraphResponse:
        """
        Fetch graph nodes and edges for visualization.
        """
        logger.info(f"[GraphHandler] Fetching graph data for user: {graph_req.user_id}")

        if not self.graph_db:
            return GraphResponse(
                code=500,
                message="Graph database not configured",
                data=None
            )

        try:
            # Call export_graph from Neo4jGraphDB
            # We use user_id as the user_name for filtering in Neo4j
            graph_data_raw = self.graph_db.export_graph(
                page=graph_req.page,
                page_size=graph_req.page_size,
                user_name=graph_req.user_id,
                filter=graph_req.filter
            )

            graph_data = GraphData(
                nodes=graph_data_raw["nodes"],
                edges=graph_data_raw["edges"],
                total_nodes=graph_data_raw["total_nodes"],
                total_edges=graph_data_raw["total_edges"]
            )

            return GraphResponse(
                code=200,
                message="Graph data fetched successfully",
                data=graph_data
            )
        except Exception as e:
            logger.error(f"[GraphHandler] Error fetching graph data: {e}", exc_info=True)
            return GraphResponse(
                code=500,
                message=f"Internal server error: {e!s}",
                data=None
            )

    def handle_trace_path(self, req: APITracePathRequest) -> TracePathResponse:
        """
        Trace paths between two memory nodes.
        """
        logger.info(f"[GraphHandler] Tracing path from {req.source_id} to {req.target_id}")

        if not self.graph_db:
            return TracePathResponse(
                code=500,
                message="Graph database not configured",
                data=None
            )

        try:
            # Use graph_db to find paths
            if hasattr(self.graph_db, 'find_path'):
                path_result = self.graph_db.find_path(
                    source_id=req.source_id,
                    target_id=req.target_id,
                    max_depth=req.max_depth
                )
            else:
                # Fallback: direct Neo4j query
                path_result = self._neo4j_find_path(
                    req.source_id,
                    req.target_id,
                    req.max_depth
                )

            if path_result and path_result.get("path_found"):
                paths = []
                for p in path_result.get("paths", []):
                    nodes = [PathNode(id=n["id"], memory=n.get("memory", ""), metadata=n.get("metadata", {})) for n in p.get("nodes", [])]
                    edges = [PathEdge(source=e["source"], target=e["target"], type=e.get("type", "RELATE")) for e in p.get("edges", [])]
                    paths.append(TracePath(nodes=nodes, edges=edges, length=len(edges)))

                return TracePathResponse(
                    code=200,
                    message="Path found",
                    data=TracePathData(
                        path_found=True,
                        paths=paths,
                        source_id=req.source_id,
                        target_id=req.target_id
                    )
                )
            else:
                return TracePathResponse(
                    code=200,
                    message="No path found between nodes",
                    data=TracePathData(
                        path_found=False,
                        paths=[],
                        source_id=req.source_id,
                        target_id=req.target_id
                    )
                )

        except Exception as e:
            logger.error(f"[GraphHandler] Error tracing path: {e}", exc_info=True)
            return TracePathResponse(
                code=500,
                message=f"Internal server error: {e!s}",
                data=None
            )

    def handle_export_schema(self, req: APISchemaRequest) -> SchemaResponse:
        """
        Export graph schema and statistics.
        """
        logger.info(f"[GraphHandler] Exporting schema for user: {req.user_id}")

        if not self.graph_db:
            return SchemaResponse(
                code=500,
                message="Graph database not configured",
                data=None
            )

        try:
            # Use graph_db to get schema stats
            if hasattr(self.graph_db, 'get_schema_stats'):
                stats = self.graph_db.get_schema_stats(sample_size=req.sample_size)
            else:
                # Fallback: direct Neo4j query
                # 传 mem_cube_id：统计必须按 cube 收敛，否则返回全库合计。
                stats = self._neo4j_get_schema_stats(req.sample_size, req.mem_cube_id)

            return SchemaResponse(
                code=200,
                message="Schema exported successfully",
                data=SchemaData(
                    total_nodes=stats.get("total_nodes", 0),
                    total_edges=stats.get("total_edges", 0),
                    edge_types=stats.get("edge_types", {}),
                    memory_types=stats.get("memory_types", {}),
                    top_tags=stats.get("top_tags", []),
                    avg_connections=stats.get("avg_connections", 0.0),
                    max_connections=stats.get("max_connections", 0),
                    orphan_nodes=stats.get("orphan_nodes", 0),
                    time_range=stats.get("time_range", {})
                )
            )

        except Exception as e:
            logger.error(f"[GraphHandler] Error exporting schema: {e}", exc_info=True)
            return SchemaResponse(
                code=500,
                message=f"Internal server error: {e!s}",
                data=None
            )

    def _neo4j_find_path(self, source_id: str, target_id: str, max_depth: int) -> dict:
        """Fallback: Direct Neo4j query for path finding."""
        import os

        import httpx

        neo4j_url = os.environ.get("NEO4J_HTTP_URL", "http://localhost:7474/db/neo4j/tx/commit")
        neo4j_user = os.environ.get("NEO4J_USER", "neo4j")
        neo4j_password = os.environ.get("NEO4J_PASSWORD", "12345678")

        query = f"""
        MATCH path = shortestPath((a:Memory {{id: $source_id}})-[*1..{max_depth}]-(b:Memory {{id: $target_id}}))
        RETURN path
        LIMIT 1
        """

        try:
            response = httpx.post(
                neo4j_url,
                json={"statements": [{"statement": query, "parameters": {"source_id": source_id, "target_id": target_id}}]},
                auth=(neo4j_user, neo4j_password),
                timeout=10
            )

            if response.status_code == 200:
                data = response.json()
                results = data.get("results", [{}])[0].get("data", [])
                if results:
                    # Parse path from Neo4j response
                    return {"path_found": True, "paths": [{"nodes": [], "edges": []}]}
                return {"path_found": False, "paths": []}
        except Exception as e:
            logger.error(f"[GraphHandler] Neo4j path query error: {e}")

        return {"path_found": False, "paths": []}

    def _neo4j_get_schema_stats(self, sample_size: int, mem_cube_id: str | None = None) -> dict:
        """委托给模块级 neo4j_schema_stats。

        此前这里有一份与 start_api 逐行重复的实现，两份**各自**漏掉了度数统计
        与 cube 过滤 —— 重复本身就是缺陷成因，所以收敛为一份。
        """
        return neo4j_schema_stats(sample_size, mem_cube_id)

    def _legacy_unused_schema_stats(self, sample_size: int) -> dict:
        """已废弃：保留仅为对照，不被调用。见 neo4j_schema_stats。"""
        import os

        import httpx

        neo4j_url = os.environ.get("NEO4J_HTTP_URL", "http://localhost:7474/db/neo4j/tx/commit")
        neo4j_user = os.environ.get("NEO4J_USER", "neo4j")
        neo4j_password = os.environ.get("NEO4J_PASSWORD", "12345678")

        stats = {
            "total_nodes": 0,
            "total_edges": 0,
            "edge_types": {},
            "memory_types": {},
            "top_tags": [],
            "avg_connections": 0.0,
            "max_connections": 0,
            "orphan_nodes": 0,
            "time_range": {}
        }

        try:
            # Get node count
            response = httpx.post(
                neo4j_url,
                json={"statements": [{"statement": "MATCH (n:Memory) RETURN count(n) as cnt"}]},
                auth=(neo4j_user, neo4j_password),
                timeout=10
            )
            if response.status_code == 200:
                data = response.json()
                results = data.get("results", [{}])[0].get("data", [])
                if results:
                    stats["total_nodes"] = results[0].get("row", [0])[0]

            # Get edge count
            response = httpx.post(
                neo4j_url,
                json={"statements": [{"statement": "MATCH ()-[r]->() RETURN count(r) as cnt"}]},
                auth=(neo4j_user, neo4j_password),
                timeout=10
            )
            if response.status_code == 200:
                data = response.json()
                results = data.get("results", [{}])[0].get("data", [])
                if results:
                    stats["total_edges"] = results[0].get("row", [0])[0]

            # Get edge type distribution
            response = httpx.post(
                neo4j_url,
                json={"statements": [{"statement": "MATCH ()-[r]->() RETURN type(r) as t, count(r) as cnt"}]},
                auth=(neo4j_user, neo4j_password),
                timeout=10
            )
            if response.status_code == 200:
                data = response.json()
                results = data.get("results", [{}])[0].get("data", [])
                for r in results:
                    row = r.get("row", [])
                    if len(row) >= 2:
                        stats["edge_types"][row[0]] = row[1]

        except Exception as e:
            logger.error(f"[GraphHandler] Neo4j schema query error: {e}")

        return stats

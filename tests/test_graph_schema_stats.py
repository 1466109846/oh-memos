"""`neo4j_schema_stats` 的契约测试。

## 为什么需要这组测试

这个函数此前有三处缺陷，**全部没有测试守着**：

1. `avg_connections` / `max_connections` / `orphan_nodes` 从初始化的 0 起
   从未被赋值 —— 不是算错，是根本没算。实测某 cube 有 6430 个带边节点、
   25781 条边，报告却是 avg 0.00 / max 0。
2. 查询是裸 `MATCH (n:Memory)`，不按 cube 过滤 → 返回全库合计
   （某 cube 6534 节点却报 7878 = 所有 cube 之和）。
3. `start_api` 与 `graph_handler` 各有一份逐行重复的实现，两份**各自**
   漏掉了同样的东西 —— 重复本身就是缺陷成因。

## 测试策略

mock `httpx.post`，不依赖跑起来的 Neo4j 或 API。断言的是**发出去的 Cypher**
与**解析出的结果**，这两者才是缺陷所在。`tests/test_graph_data.py` 打真实
端点，属于集成测试，覆盖不到这一层。
"""

from __future__ import annotations

import json
import re

from unittest.mock import MagicMock, patch

import pytest

from oh_memos.api.handlers.graph_handler import neo4j_schema_stats


# 真实测量值，取自 jincaizhaopin_cube（6534 节点 / 104 孤立 / avg 6.83 / max 151）。
# 用真值而非编造数字：这样断言失败时能直接对照现实。
REAL_TOTAL = 6534
REAL_ORPHANS = 104
REAL_AVG = 6.8344046525865005
REAL_MAX = 151


def _row(*values: object) -> dict:
    return {"row": list(values)}


def _resp(rows: list[dict], status: int = 200, errors: list | None = None) -> MagicMock:
    """构造一个 httpx 响应替身。"""
    resp = MagicMock()
    resp.status_code = status
    resp.json.return_value = {
        "results": [{"data": rows}],
        "errors": errors or [],
    }
    return resp


def _dispatch(statement_to_rows: dict[str, list[dict]]):
    """按 Cypher 内容分派响应。key 是子串，第一个命中的生效。

    这样测试不必关心查询顺序 —— 顺序是实现细节，改了不该让测试变红。
    """

    def _post(url, json=None, auth=None, timeout=None):  # noqa: A002
        statement = json["statements"][0]["statement"]
        for needle, rows in statement_to_rows.items():
            if needle in statement:
                return _resp(rows)
        return _resp([])

    return _post


def _captured_statements(calls) -> list[str]:
    return [c.kwargs["json"]["statements"][0]["statement"] for c in calls]


def _captured_params(calls) -> list[dict]:
    return [c.kwargs["json"]["statements"][0].get("parameters", {}) for c in calls]


class TestCubeScoping:
    """缺陷 2：查询必须按 cube 收敛，否则返回全库合计。"""

    def test_cube_id_reaches_every_query(self):
        with patch("httpx.post", side_effect=_dispatch({})) as post:
            neo4j_schema_stats(100, "jincaizhaopin_cube")

        statements = _captured_statements(post.call_args_list)
        assert statements, "应当至少发出一条查询"
        for stmt in statements:
            assert "user_name" in stmt, f"查询缺少 cube 过滤: {stmt[:80]}"

        for params in _captured_params(post.call_args_list):
            assert params.get("cube") == "jincaizhaopin_cube"

    def test_node_and_edge_queries_scope_on_correct_alias(self):
        """节点查询过滤 n，边查询过滤 a —— 别名弄错会静默返回全库。"""
        with patch("httpx.post", side_effect=_dispatch({})) as post:
            neo4j_schema_stats(100, "some_cube")

        for stmt in _captured_statements(post.call_args_list):
            if "-[r]->" in stmt:
                assert "a.user_name = $cube" in stmt, f"边查询别名错: {stmt[:80]}"
            else:
                assert "n.user_name = $cube" in stmt, f"节点查询别名错: {stmt[:80]}"

    def test_no_cube_keeps_legacy_global_behaviour(self):
        """不传 cube 时退回全库统计 —— 保持旧行为，不引入破坏性变更。"""
        with patch("httpx.post", side_effect=_dispatch({})) as post:
            neo4j_schema_stats(100, None)

        for stmt in _captured_statements(post.call_args_list):
            assert "$cube" not in stmt
        for params in _captured_params(post.call_args_list):
            assert params == {}


class TestDegreeStats:
    """缺陷 1：avg / max / orphan 此前从未被赋值。"""

    def test_degree_stats_are_populated(self):
        stats = None
        with patch(
            "httpx.post",
            side_effect=_dispatch(
                {"AS orphans": [_row(REAL_AVG, REAL_MAX, REAL_ORPHANS)]}
            ),
        ):
            stats = neo4j_schema_stats(100, "c")

        # 这三个断言直接对应缺陷：改坏实现后它们必须变红。
        assert stats["avg_connections"] == pytest.approx(6.83, abs=0.01)
        assert stats["max_connections"] == REAL_MAX
        assert stats["orphan_nodes"] == REAL_ORPHANS

    def test_degree_query_uses_undirected_pattern(self):
        """必须用无向度数：扩散检索两个方向都走，只算出度会低估连通性。"""
        with patch("httpx.post", side_effect=_dispatch({})) as post:
            neo4j_schema_stats(100, "c")

        degree_stmts = [s for s in _captured_statements(post.call_args_list) if "deg" in s]
        assert degree_stmts, "应当发出度数查询"
        assert any("(n)--()" in s for s in degree_stmts), "度数查询应为无向"

    def test_avg_is_rounded_for_display(self):
        with patch(
            "httpx.post",
            side_effect=_dispatch({"AS orphans": [_row(6.8344046525865005, 151, 104)]}),
        ):
            stats = neo4j_schema_stats(100, "c")
        assert stats["avg_connections"] == 6.83

    def test_null_degrees_do_not_crash(self):
        """空 cube 时 avg 是 NULL —— 不能因此抛异常。"""
        with patch(
            "httpx.post", side_effect=_dispatch({"AS orphans": [_row(None, None, None)]})
        ):
            stats = neo4j_schema_stats(100, "empty_cube")
        assert stats["avg_connections"] == 0.0
        assert stats["max_connections"] == 0
        assert stats["orphan_nodes"] == 0


class TestOtherFields:
    """缺陷 3 的连带：memory_types / time_range 同样从未被填充。"""

    def test_counts_and_types_are_parsed(self):
        with patch(
            "httpx.post",
            side_effect=_dispatch(
                {
                    # 顺序有意义：边类型查询同时含 "type(r) AS t" 与
                    # "count(r) AS cnt"，必须让更具体的键先命中，
                    # 否则它会被当成边计数查询、拿到单元素行。
                    "type(r) AS t": [_row("RELATE", 5824), _row("CAUSE", 2556)],
                    "coalesce(n.type": [_row("fact", 1837), _row("topic", 1202)],
                    "count(n) AS cnt": [_row(REAL_TOTAL)],
                    "count(r) AS cnt": [_row(25781)],
                }
            ),
        ):
            stats = neo4j_schema_stats(100, "c")

        assert stats["total_nodes"] == REAL_TOTAL
        assert stats["total_edges"] == 25781
        assert stats["edge_types"] == {"RELATE": 5824, "CAUSE": 2556}
        assert stats["memory_types"] == {"fact": 1837, "topic": 1202}

    def test_time_range_is_populated(self):
        with patch(
            "httpx.post",
            side_effect=_dispatch(
                {"AS earliest": [_row("2026-07-10T23:08:00", "2026-08-21T20:21:14")]}
            ),
        ):
            stats = neo4j_schema_stats(100, "c")
        assert stats["time_range"]["earliest"].startswith("2026-07-10")
        assert stats["time_range"]["latest"].startswith("2026-08-21")

    def test_absent_time_range_stays_empty(self):
        with patch("httpx.post", side_effect=_dispatch({"AS earliest": [_row(None, None)]})):
            stats = neo4j_schema_stats(100, "c")
        assert stats["time_range"] == {}


class TestFailureIsolation:
    """schema 是诊断接口 —— 单项取不到不该让整个响应失败。"""

    def test_http_error_yields_zeros_not_exception(self):
        with patch("httpx.post", return_value=_resp([], status=500)):
            stats = neo4j_schema_stats(100, "c")
        assert stats["total_nodes"] == 0
        assert stats["avg_connections"] == 0.0

    def test_neo4j_error_payload_is_not_used_even_when_rows_present(self):
        """errors 伴随数据时必须丢弃数据。

        判别性在「伴随数据」上：早先这条测试用 errors + 空 data，那样即便把
        `if payload.get("errors")` 整个删掉也照样通过 —— 空 data 本来就解析不出
        东西。变异验证暴露了这一点。
        """
        errors = [{"code": "Neo.ClientError.Statement.SyntaxError"}]
        poisoned = _resp([_row(999999)], errors=errors)
        with patch("httpx.post", return_value=poisoned):
            stats = neo4j_schema_stats(100, "c")

        assert stats["total_nodes"] == 0, "带 errors 的响应不该被采用"
        assert stats["total_edges"] == 0

    def test_transport_exception_is_tolerated(self):
        with patch("httpx.post", side_effect=RuntimeError("connection refused")):
            stats = neo4j_schema_stats(100, "c")
        assert stats["total_nodes"] == 0
        assert stats["orphan_nodes"] == 0

    def test_partial_failure_keeps_the_parts_that_worked(self):
        """节点数取到、度数失败 —— 前者不该被后者拖没。"""

        def _post(url, json=None, auth=None, timeout=None):  # noqa: A002
            stmt = json["statements"][0]["statement"]
            if "count(n) AS cnt" in stmt:
                return _resp([_row(REAL_TOTAL)])
            if "AS orphans" in stmt:
                raise RuntimeError("degree query timed out")
            return _resp([])

        with patch("httpx.post", side_effect=_post):
            stats = neo4j_schema_stats(100, "c")

        assert stats["total_nodes"] == REAL_TOTAL
        assert stats["avg_connections"] == 0.0

    def test_result_shape_is_always_complete(self):
        """调用方按固定键读 —— 任何情况下都不能缺键。"""
        with patch("httpx.post", side_effect=RuntimeError("boom")):
            stats = neo4j_schema_stats(100, "c")
        for key in (
            "total_nodes",
            "total_edges",
            "edge_types",
            "memory_types",
            "top_tags",
            "avg_connections",
            "max_connections",
            "orphan_nodes",
            "time_range",
        ):
            assert key in stats, f"缺少键 {key}"


class TestNoDuplicateImplementation:
    """缺陷 3：两份重复实现必须已收敛为一份。"""

    def test_start_api_delegates_instead_of_duplicating(self):
        from pathlib import Path

        src = Path("src/oh_memos/api/start_api.py").read_text(encoding="utf-8")
        assert "return neo4j_schema_stats(sample_size, mem_cube_id)" in src, (
            "start_api 应委托给共享实现"
        )
        assert 'stats["avg_connections"] = round(' not in src, (
            "start_api 里不该再有第二份度数计算"
        )

    def test_handler_delegates_to_module_level_function(self):
        from oh_memos.api.handlers import graph_handler

        assert hasattr(graph_handler, "neo4j_schema_stats"), (
            "共享实现应在模块级，供两处 import"
        )

    def test_product_endpoint_calls_an_existing_method(self):
        """/product/graph/schema 曾调用不存在的 handle_get_graph_schema，恒返回 500。"""
        from pathlib import Path

        from oh_memos.api.handlers.graph_handler import GraphHandler

        src = Path("src/oh_memos/api/start_api.py").read_text(encoding="utf-8")

        # 断言实际调用，不是整个文件 —— 注释里提到旧名字是合理的（解释修了什么），
        # 早先写成 `"handle_get_graph_schema" not in src` 会被自己的注释判红。
        assert "handler.handle_get_graph_schema(req)" not in src, (
            "不该再调用不存在的 handle_get_graph_schema"
        )
        assert "handler.handle_export_schema(req)" in src

        # 真正的守卫：端点调的每个 handler 方法都必须在 GraphHandler 上存在。
        called = set(re.findall(r"handler\.(handle_\w+)\(", src))
        assert called, "应当能提取到 handler 调用"
        for name in sorted(called):
            assert hasattr(GraphHandler, name), (
                f"start_api 调了 GraphHandler.{name}，但该方法不存在"
            )

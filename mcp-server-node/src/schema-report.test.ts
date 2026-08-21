/**
 * `formatSchemaReport` 的字段契约测试。
 *
 * 起因：这段渲染逻辑原本内联在 handler 里，单测触达不到 —— 于是**五个字段名
 * 读错了却长期无人发现**。修好 Python 侧的统计后才暴露：API 返回
 * avg 6.83 / orphan 104，MCP 却显示 0.00 / 0。
 *
 * 部分正确正是它难被发现的原因：`total_nodes`、`max_connections` 恰好同名，
 * 所以报告看起来「大部分对」。
 */
import { describe, expect, it } from "vitest";
import { formatSchemaReport } from "./handlers/graph.js";

/** 取自 jincaizhaopin_cube 的真实 API 响应（修好 Python 侧后实测）。 */
const REAL_RESPONSE: Record<string, unknown> = {
  total_nodes: 6534,
  total_edges: 22328,
  avg_connections: 6.83,
  max_connections: 151,
  orphan_nodes: 104,
  edge_types: { RELATE: 5824, CAUSE: 2556, CONDITION: 753 },
  memory_types: { reasoning: 3495, fact: 1837, topic: 1202 },
  top_tags: [],
  time_range: {
    earliest: "2026-07-10T21:46:12.603068Z",
    latest: "2026-08-20T21:20:12.698182Z",
  },
};

describe("formatSchemaReport 字段契约", () => {
  it("渲染真实 API 响应的每一项", () => {
    const out = formatSchemaReport(REAL_RESPONSE);
    expect(out).toContain("**Total Nodes**: 6534");
    expect(out).toContain("**Total Edges**: 22328");
    expect(out).toContain("**Avg Connections/Node**: 6.83");
    expect(out).toContain("**Max Connections**: 151");
    expect(out).toContain("**Orphan Nodes**: 104");
  });

  it("avg 与 orphan 不再被静默兜成零", () => {
    // 这两个字段此前读的是 avg_connections_per_node / orphan_node_count，
    // API 不返回那两个键，`?? 0` 于是把真值吞掉了。
    const out = formatSchemaReport(REAL_RESPONSE);
    expect(out).not.toContain("**Avg Connections/Node**: 0.00");
    expect(out).not.toContain("**Orphan Nodes**: 0\n");
  });

  it("边类型与记忆类型按数量降序", () => {
    // 插入序必须与排序后不同，否则去掉 sort 也照样通过 —— 变异验证暴露过
    // 这一点：早先用 REAL_RESPONSE（RELATE 本就在前）时 S9 存活。
    const shuffled = {
      total_nodes: 100,
      edge_types: { CONDITION: 753, RELATE: 5824, CAUSE: 2556 },
      memory_types: { topic: 1202, reasoning: 3495, fact: 1837 },
    };
    const out = formatSchemaReport(shuffled);

    const order = ["RELATE", "CAUSE", "CONDITION"].map((t) =>
      out.indexOf(`**${t}**`),
    );
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);

    const mem = ["reasoning", "fact", "topic"].map((t) =>
      out.indexOf(`- ${t}:`),
    );
    expect(mem[0]).toBeLessThan(mem[1]);
    expect(mem[1]).toBeLessThan(mem[2]);
  });

  it("真实响应的数值被渲染", () => {
    const out = formatSchemaReport(REAL_RESPONSE);
    expect(out).toContain("**RELATE**: 5824");
    expect(out).toContain("reasoning: 3495");
  });

  it("time_range 被渲染", () => {
    const out = formatSchemaReport(REAL_RESPONSE);
    expect(out).toContain("Earliest: 2026-07-10T21:46:12.603068Z");
    expect(out).toContain("Latest: 2026-08-20T21:20:12.698182Z");
  });
});

describe("健康评估基于真值而非零值", () => {
  it("avg 6.83 判为关系丰富，不再报「平均连接过低」", () => {
    // 旧行为：avg 读不到 → 恒为 0 → 永远输出「平均连接过低」。
    const out = formatSchemaReport(REAL_RESPONSE);
    expect(out).toContain("Rich relationships");
    expect(out).not.toContain("Low average connections");
  });

  it("orphan 比例基于真实 orphan 数", () => {
    // 104/6534 ≈ 1.6% → 连接良好
    expect(formatSchemaReport(REAL_RESPONSE)).toContain("Good connectivity");

    // 高孤立比例必须被识别 —— 旧实现 orphan 恒为 0，这一支永远走不到。
    const lonely = {
      ...REAL_RESPONSE,
      orphan_nodes: 5000,
      avg_connections: 0.3,
    };
    const out = formatSchemaReport(lonely);
    expect(out).toContain("High orphan ratio");
    expect(out).toContain("Low average connections");
  });

  it("中等孤立比例走中间分支", () => {
    const out = formatSchemaReport({ ...REAL_RESPONSE, orphan_nodes: 2000 });
    expect(out).toContain("Moderate orphan ratio");
  });

  it("两句结论不再自相矛盾", () => {
    // 旧实现同时输出「连接良好」（orphan=0）与「平均连接过低」（avg=0），
    // 而两者都是零值的产物。真值下这对组合不该出现。
    const out = formatSchemaReport(REAL_RESPONSE);
    const contradictory =
      out.includes("Good connectivity") &&
      out.includes("Low average connections");
    expect(contradictory).toBe(false);
  });
});

describe("向后兼容与健壮性", () => {
  it("旧键名仍可读（后端若改回长名不会失效）", () => {
    const out = formatSchemaReport({
      total_nodes: 100,
      avg_connections_per_node: 3.5,
      orphan_node_count: 7,
      edge_type_distribution: { RELATE: 10 },
      memory_type_distribution: { fact: 20 },
    });
    expect(out).toContain("**Avg Connections/Node**: 3.50");
    expect(out).toContain("**Orphan Nodes**: 7");
    expect(out).toContain("**RELATE**: 10");
    expect(out).toContain("fact: 20");
  });

  it("新键优先于旧键", () => {
    const out = formatSchemaReport({
      total_nodes: 10,
      avg_connections: 9.9,
      avg_connections_per_node: 1.1,
    });
    expect(out).toContain("**Avg Connections/Node**: 9.90");
  });

  it("空响应不崩且不输出空区块", () => {
    const out = formatSchemaReport({});
    expect(out).toContain("**Total Nodes**: 0");
    expect(out).toContain("**Avg Connections/Node**: 0.00");
    expect(out).not.toContain("### Time Range");
    expect(out).not.toContain("### Relationship Types");
    expect(out).not.toContain("### Memory Types");
  });

  it("脏值不产生 NaN", () => {
    const out = formatSchemaReport({
      total_nodes: "abc",
      avg_connections: null,
      max_connections: undefined,
      orphan_nodes: {},
      edge_types: "not-an-object",
      time_range: null,
    });
    expect(out).not.toContain("NaN");
    expect(out).not.toContain("undefined");
    expect(out).toContain("**Avg Connections/Node**: 0.00");
  });

  it("top_tags 兼容列表与字典两种形态", () => {
    const asList = formatSchemaReport({
      total_nodes: 1,
      top_tags: ["bugfix", "config"],
    });
    expect(asList).toContain("`bugfix`");

    const asPairs = formatSchemaReport({
      total_nodes: 1,
      top_tags: [["bugfix", 12]],
    });
    expect(asPairs).toContain("`bugfix`: 12");

    const asDict = formatSchemaReport({
      total_nodes: 1,
      tag_frequency: { config: 5 },
    });
    expect(asDict).toContain("`config`: 5");
  });

  it("总节点为 0 时不做除法，也不输出孤立比例判断", () => {
    const out = formatSchemaReport({ total_nodes: 0, orphan_nodes: 0 });
    expect(out).not.toContain("orphan ratio");
    expect(out).not.toContain("Good connectivity");
  });
});

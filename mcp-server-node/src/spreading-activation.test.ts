/**
 * 一跳图扩散联想（P4）的契约测试。
 *
 * 断言的是**设计取舍**，不是实现细节：一跳深度、上界 12、边类型优先级、
 * 可解释标记、不覆盖直接命中。这些取舍每一条都有前置测量或论文支撑
 * （见 spreading-activation.ts 文件头），改动它们应当是显式决定而非顺手。
 */
import { describe, expect, it } from "vitest";
import {
  SPREAD_EDGE_TYPES,
  SPREAD_FROM_KEY,
  SPREAD_LIMIT,
  SPREAD_RELATIVITY_FLOOR,
  SPREAD_VIA_KEY,
  buildSpreadCypher,
  isSpreadNode,
  mergeSpread,
  rankNeighbours,
  spreadRelativity,
  toSpreadNode,
  type SpreadNeighbour,
} from "./spreading-activation.js";
import { applyMemoryQualityPolicy } from "./memory-quality.js";
import type { MemoryNode } from "./types.js";

const NOW = Date.parse("2026-08-21T00:00:00Z");
const daysAgo = (d: number): string =>
  new Date(NOW - d * 86_400_000).toISOString();

const nb = (
  id: string,
  via: string,
  degree = 5,
  from = "seed-1",
): SpreadNeighbour => ({
  id,
  memory: `[DECISION] ${id} 内容`,
  via,
  from,
  degree,
});

describe("Cypher 约束", () => {
  const cypher = buildSpreadCypher();

  it("只走参与扩散的边类型", () => {
    for (const t of SPREAD_EDGE_TYPES) {
      expect(cypher).toContain(`'${t}'`);
    }
    // FOLLOWS / PARENT / MERGED_TO / CONFLICT 是结构性边，不是语义关联。
    for (const t of ["FOLLOWS", "PARENT", "MERGED_TO", "CONFLICT"]) {
      expect(cypher).not.toContain(`'${t}'`);
    }
  });

  it("排除种子自身 —— 否则把已命中的记忆当联想重复带回", () => {
    expect(cypher).toContain("NOT m.id IN $seeds");
  });

  it("同 cube 收敛 —— 跨 cube 串味是 9.6 节的教训", () => {
    expect(cypher).toContain("m.user_name = $user_name");
  });

  it("排除 WorkingMemory 层，与 9.6 节一致", () => {
    expect(cypher).toContain("<> 'WorkingMemory'");
  });

  it("排除 reasoning 推断节点（该 cube 占 3495/6534）", () => {
    expect(cypher).toContain("<> 'reasoning'");
  });

  it("只取 activated", () => {
    expect(cypher).toContain("'activated'");
  });

  it("无向匹配 —— 联想不分方向，只算出边会漏一半", () => {
    expect(cypher).toContain("(n:Memory)-[r]-(m:Memory)");
    expect(cypher).not.toContain("-[r]->(m:Memory)");
  });

  it("只扩散一跳 —— 不出现变长路径", () => {
    // 多跳会让候选集爆炸（一跳中位 10 → 两跳 100 量级），
    // 且 arXiv 2606.24948 的多跳负面结果同样适用于相关性衰减。
    expect(cypher).not.toMatch(/\*\s*\d*\s*\.\.|\*\d/);
  });

  it("带回度数用于抑制枢纽", () => {
    expect(cypher).toContain("size([(m)--() | 1]) AS degree");
  });
});

describe("排序与上界", () => {
  it("边类型优先级 CAUSE > CONDITION > RELATE", () => {
    const out = rankNeighbours([
      nb("r", "RELATE"),
      nb("c", "CAUSE"),
      nb("n", "CONDITION"),
    ]);
    expect(out.map((n) => n.id)).toEqual(["c", "n", "r"]);
  });

  it("同类型内低度数优先 —— 低度数邻居更专属", () => {
    const out = rankNeighbours([
      nb("hub", "CAUSE", 75),
      nb("mid", "CAUSE", 10),
      nb("rare", "CAUSE", 2),
    ]);
    expect(out.map((n) => n.id)).toEqual(["rare", "mid", "hub"]);
  });

  it("优先级压过度数 —— 高度数的 CAUSE 仍在低度数的 RELATE 之前", () => {
    const out = rankNeighbours([nb("r", "RELATE", 1), nb("c", "CAUSE", 99)]);
    expect(out.map((n) => n.id)).toEqual(["c", "r"]);
  });

  it("截到上界 12", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      nb(`n${String(i).padStart(2, "0")}`, "RELATE", i),
    );
    expect(rankNeighbours(many)).toHaveLength(SPREAD_LIMIT);
    expect(SPREAD_LIMIT).toBe(12);
  });

  it("上界覆盖实测的中位 10 到 p90 33 之间", () => {
    // 前置测量：一跳候选中位 10、p90 33。上界必须 ≥ 中位，否则常态被截；
    // 又不该 ≥ p90，否则那 388 个 31+ 度节点能灌满 top_k。
    expect(SPREAD_LIMIT).toBeGreaterThanOrEqual(10);
    expect(SPREAD_LIMIT).toBeLessThan(33);
  });

  it("排序确定 —— 同分靠 id 兜底，不依赖 Neo4j 返回序", () => {
    const a = rankNeighbours([nb("b", "CAUSE", 5), nb("a", "CAUSE", 5)]);
    const b = rankNeighbours([nb("a", "CAUSE", 5), nb("b", "CAUSE", 5)]);
    expect(a.map((n) => n.id)).toEqual(b.map((n) => n.id));
    expect(a.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("空输入与 limit 0 不崩", () => {
    expect(rankNeighbours([])).toEqual([]);
    expect(rankNeighbours([nb("x", "CAUSE")], 0)).toEqual([]);
    expect(rankNeighbours([nb("x", "CAUSE")], -5)).toEqual([]);
  });

  it("未知边类型排在已知类型之后", () => {
    const out = rankNeighbours([
      nb("weird", "UNKNOWN_EDGE"),
      nb("r", "RELATE"),
    ]);
    expect(out.map((n) => n.id)).toEqual(["r", "weird"]);
  });

  it("不改动入参", () => {
    const input = [nb("r", "RELATE"), nb("c", "CAUSE")];
    const snapshot = input.map((n) => n.id);
    rankNeighbours(input);
    expect(input.map((n) => n.id)).toEqual(snapshot);
  });
});

describe("可解释标记", () => {
  it("扩散节点带 via 与 from", () => {
    const node = toSpreadNode(nb("x", "CAUSE", 3, "seed-9"));
    const meta = node.metadata as Record<string, unknown>;
    expect(meta[SPREAD_VIA_KEY]).toBe("CAUSE");
    expect(meta[SPREAD_FROM_KEY]).toBe("seed-9");
  });

  it("relativity 低于直接命中 —— 联想是旁证不是答案", () => {
    const meta = toSpreadNode(nb("x", "CAUSE")).metadata as Record<
      string,
      unknown
    >;
    expect(Number(meta.relativity)).toBeLessThan(0.8);
    expect(Number(meta.relativity)).toBeGreaterThan(0);
  });

  it("isSpreadNode 能区分扩散与直接命中", () => {
    expect(isSpreadNode(toSpreadNode(nb("x", "CAUSE")))).toBe(true);
    expect(
      isSpreadNode({ id: "d", memory: "m", metadata: {} } as MemoryNode),
    ).toBe(false);
    expect(isSpreadNode({ id: "d", memory: "m" } as MemoryNode)).toBe(false);
    expect(
      isSpreadNode({
        id: "d",
        memory: "m",
        metadata: { spread_via: "" },
      } as MemoryNode),
    ).toBe(false);
  });
});

describe("并入候选集", () => {
  const direct = (id: string, relativity: number): MemoryNode =>
    ({
      id,
      memory: `[DECISION] direct ${id}`,
      metadata: { relativity, status: "activated" },
    }) as MemoryNode;

  it("追加不重复的扩散节点", () => {
    const out = mergeSpread(
      [direct("a", 0.9)],
      [toSpreadNode(nb("b", "CAUSE"))],
    );
    expect(out.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("已命中的 id 不被扩散节点覆盖", () => {
    // 直接命中带真实 relativity；被 0.45 覆盖会让它掉出应有位置。
    const out = mergeSpread(
      [direct("a", 0.95)],
      [toSpreadNode(nb("a", "CAUSE"))],
    );
    expect(out).toHaveLength(1);
    expect(
      Number((out[0].metadata as Record<string, unknown>).relativity),
    ).toBe(0.95);
    expect(isSpreadNode(out[0])).toBe(false);
  });

  it("扩散节点之间也不重复", () => {
    const dup = toSpreadNode(nb("b", "CAUSE"));
    const out = mergeSpread([], [dup, dup]);
    expect(out).toHaveLength(1);
  });

  it("空 id 被丢弃", () => {
    const bad = { ...toSpreadNode(nb("x", "CAUSE")), id: "" } as MemoryNode;
    expect(mergeSpread([], [bad])).toHaveLength(0);
  });

  it("两侧皆空不崩", () => {
    expect(mergeSpread([], [])).toEqual([]);
  });
});

// 「联想绝不压过直接命中」—— 维护者决定（[DECISION] a4b3ed39）。
// 固定 relativity 做不到这件事：直接命中的值来自后端，弱匹配可能只有 0.3。
describe("spreadRelativity 动态上界", () => {
  const hit = (id: string, relativity: number): MemoryNode =>
    ({ id, memory: `direct ${id}`, metadata: { relativity } }) as MemoryNode;

  it("压到最低直接命中之下", () => {
    expect(spreadRelativity([hit("a", 0.9), hit("b", 0.3)])).toBeLessThan(0.3);
  });

  it("弱匹配也不被压过 —— 这是决定的核心", () => {
    // 旧的固定 0.45 在这里会让联想排到 0.3 的直接命中之前。
    for (const weakest of [0.9, 0.5, 0.31, 0.2, 0.1]) {
      expect(
        spreadRelativity([hit("a", 0.95), hit("w", weakest)]),
      ).toBeLessThan(weakest);
    }
  });

  it("触地板：全都很低时不归零，联想仍在结果里", () => {
    const r = spreadRelativity([hit("a", 0.05), hit("b", 0.02)]);
    expect(r).toBe(SPREAD_RELATIVITY_FLOOR);
    expect(r).toBeGreaterThan(0);
  });

  it("忽略已有的扩散节点 —— 否则第二轮会逐级压低", () => {
    const already = toSpreadNode(nb("s", "CAUSE"), 0.05);
    expect(spreadRelativity([hit("a", 0.8), already])).toBeCloseTo(0.79, 6);
  });

  it("无直接命中时退回地板值", () => {
    expect(spreadRelativity([])).toBe(SPREAD_RELATIVITY_FLOOR);
    expect(spreadRelativity([toSpreadNode(nb("s", "CAUSE"))])).toBe(
      SPREAD_RELATIVITY_FLOOR,
    );
  });

  it("脏 relativity 被跳过，不产生 NaN", () => {
    // 不含 null —— `Number(null)` 是 **0** 而非 NaN，所以它是合法的 finite 值、
    // 会成为最小值。归错类会让断言值算错（实测过：期望 0.59 实得 0.05）。
    for (const bad of [Number.NaN, "abc", undefined, {}]) {
      // 脏节点放在**有效节点之前**。放在之后时 Math.min 已经定了最小值，
      // 去掉 Number.isFinite 守卫也照样通过 —— 变异验证暴露过这一点（R6）。
      const r = spreadRelativity([
        { id: "x", memory: "", metadata: { relativity: bad } } as MemoryNode,
        hit("a", 0.6),
      ]);
      expect(Number.isFinite(r)).toBe(true);
      expect(r).toBeCloseTo(0.59, 6);
    }
  });

  it("relativity 为 null / 0 时视为合法的 0，压到地板", () => {
    // `Number(null) === 0`。一条 relativity 0 的直接命中意味着"完全不相关但
    // 仍是命中"，联想必须排在它之后 → 只能落到地板值。
    expect(spreadRelativity([hit("z", 0), hit("a", 0.6)])).toBe(
      SPREAD_RELATIVITY_FLOOR,
    );
    expect(
      spreadRelativity([
        { id: "n", memory: "", metadata: { relativity: null } } as MemoryNode,
        hit("a", 0.6),
      ]),
    ).toBe(SPREAD_RELATIVITY_FLOOR);
  });

  it("脏值出现在两侧都不污染", () => {
    const r = spreadRelativity([
      {
        id: "d1",
        memory: "",
        metadata: { relativity: Number.NaN },
      } as MemoryNode,
      hit("ok", 0.5),
      { id: "d2", memory: "", metadata: { relativity: "junk" } } as MemoryNode,
    ]);
    expect(r).toBeCloseTo(0.49, 6);
  });

  it("端到端：扩散节点排在所有直接命中之后", () => {
    const hits = [hit("strong", 0.95), hit("weak", 0.32)];
    const spread = rankNeighbours([nb("n1", "CAUSE"), nb("n2", "RELATE")]).map(
      (n) => toSpreadNode(n, spreadRelativity(hits)),
    );
    const merged = mergeSpread(hits, spread);
    const rel = (n: MemoryNode) =>
      Number((n.metadata as Record<string, unknown>).relativity);
    const lowestHit = Math.min(
      ...merged.filter((n) => !isSpreadNode(n)).map(rel),
    );
    for (const s of merged.filter(isSpreadNode)) {
      expect(rel(s)).toBeLessThan(lowestHit);
    }
  });
});

// 「绝不压过直接命中」的**顺序**不变量。
//
// 这一组与 spreadRelativity 那组的区别很要紧：那组测的是一个数值函数，
// 这组测的是决定真正关心的性质 —— 排序后的相对位置。
//
// 缺了这组，就出现过实测反例：spreadRelativity 完全正确（0.89 < 0.9），
// 但陈旧直接命中 score 0.7030 < 新鲜联想 0.8400，联想排到了前面。
// quality_score 是六项加权和，约束一个输入代理不等于约束最终顺序。
describe("排序不变量：联想恒在直接命中之后", () => {
  const hit = (id: string, meta: Record<string, unknown>): MemoryNode =>
    ({
      id,
      // 正文各异且够长，避免被近重复折叠干扰顺序断言。
      memory: `direct hit ${id} with distinct filler ${id.repeat(6)}`,
      metadata: { status: "activated", ...meta },
    }) as MemoryNode;

  const spreadOf = (
    id: string,
    meta: Record<string, unknown> = {},
  ): MemoryNode =>
    ({
      ...toSpreadNode(nb(id, "CAUSE"), 0.89),
      memory: `spread ${id} with distinct filler ${id.repeat(6)}`,
      metadata: {
        ...(toSpreadNode(nb(id, "CAUSE"), 0.89).metadata as Record<
          string,
          unknown
        >),
        ...meta,
      },
    }) as MemoryNode;

  const order = (nodes: MemoryNode[]): boolean[] => {
    const out = applyMemoryQualityPolicy(
      { text_mem: [{ cube_id: "c", memories: nodes }] },
      { now: NOW },
    );
    return (out.text_mem![0].memories as MemoryNode[]).map(isSpreadNode);
  };

  /** 所有 false（直接命中）必须排在所有 true（联想）之前。 */
  const partitioned = (flags: boolean[]): boolean => {
    const firstSpread = flags.indexOf(true);
    return firstSpread === -1 || !flags.slice(firstSpread).includes(false);
  };

  it("联想分数更高时仍排在后面 —— 这是实测过的反例场景", () => {
    // 陈旧的 PROGRESS 直接命中（freshness 低 + PROGRESS 惩罚）
    const stale = hit("stale", {
      relativity: 0.9,
      type: "PROGRESS",
      updated_at: daysAgo(400),
    });
    // 新鲜的联想（freshness 满分）
    const fresh = spreadOf("fresh", { updated_at: daysAgo(0) });
    const flags = order([fresh, stale]);
    expect(partitioned(flags)).toBe(true);
    expect(flags).toEqual([false, true]);
  });

  it("联想 relativity 被设成最高也不上位", () => {
    // 覆盖 R8：接线处若忘了传 relativity（或传错），顺序仍然正确。
    const flags = order([
      spreadOf("s", { relativity: 0.99, updated_at: daysAgo(0) }),
      hit("weak", {
        relativity: 0.1,
        type: "DECISION",
        updated_at: daysAgo(0),
      }),
    ]);
    expect(flags).toEqual([false, true]);
  });

  it("多条混合时严格分区", () => {
    const flags = order([
      spreadOf("s1", { updated_at: daysAgo(0) }),
      hit("h1", {
        relativity: 0.2,
        type: "PROGRESS",
        updated_at: daysAgo(500),
      }),
      spreadOf("s2", { updated_at: daysAgo(0) }),
      hit("h2", { relativity: 0.95, type: "DECISION", updated_at: daysAgo(0) }),
      spreadOf("s3", { updated_at: daysAgo(0) }),
    ]);
    expect(partitioned(flags)).toBe(true);
    expect(flags.filter((f) => !f)).toHaveLength(2);
    expect(flags.filter((f) => f)).toHaveLength(3);
  });

  it("组内仍按 quality_score 排序", () => {
    const out = applyMemoryQualityPolicy(
      {
        text_mem: [
          {
            cube_id: "c",
            memories: [
              hit("low", {
                relativity: 0.3,
                type: "DECISION",
                updated_at: daysAgo(0),
              }),
              hit("high", {
                relativity: 0.95,
                type: "DECISION",
                updated_at: daysAgo(0),
              }),
            ],
          },
        ],
      },
      { now: NOW },
    );
    expect(
      (out.text_mem![0].memories as MemoryNode[]).map((n) => n.id),
    ).toEqual(["high", "low"]);
  });

  it("全是联想时不崩", () => {
    const flags = order([spreadOf("a"), spreadOf("b")]);
    expect(flags).toEqual([true, true]);
  });

  it("全是直接命中时行为不变", () => {
    const flags = order([
      hit("a", { relativity: 0.8, type: "DECISION", updated_at: daysAgo(0) }),
      hit("b", { relativity: 0.6, type: "DECISION", updated_at: daysAgo(0) }),
    ]);
    expect(flags).toEqual([false, false]);
  });
});

/**
 * memoryQualityScore 评测基准
 *
 * 设计约束：本文件的断言必须在评分权重调整前后**都成立**。
 * 断言的是不变量与敏感度（哪个维度必须影响排序），而非具体分值快照 ——
 * 后者会让任何权重微调都变成红灯，失去回归价值。
 *
 * 与 memory-quality.test.ts 的分工：
 *   - memory-quality.test.ts  行为示例（auto-capture 降权、lite 过滤等）
 *   - 本文件                  不变量 + 敏感度守卫 + 权重和守卫
 *
 * 设计文档：docs/design/memory-retrieval-optimization.md
 */
import { describe, expect, it } from "vitest";
import {
  applyMemoryQualityPolicy,
  memoryQualityScore,
} from "./memory-quality.js";
import type { MemoryNode, SearchData } from "./types.js";

const NOW = Date.parse("2026-08-21T00:00:00Z");
const daysAgo = (days: number): string =>
  new Date(NOW - days * 86_400_000).toISOString();

/** 构造记忆节点。默认值刻意全部显式给出，避免依赖实现里的 fallback。 */
const mem = (id: string, meta: Record<string, unknown> = {}): MemoryNode => ({
  id,
  memory: `[TEST] ${id}`,
  metadata: {
    relativity: 0.8,
    confidence: 0.8,
    type: "DECISION",
    status: "activated",
    updated_at: daysAgo(0),
    ...meta,
  },
});

/**
 * 各维度全部取满的节点，预期得分恰好 1.0。
 *
 * 这是**权重和守卫**：任何维度权重漂移、新增未归一化的权重项，
 * 都会让这个断言失败。access_count 显式给满，使守卫在引入访问强化后依然成立。
 */
const perfect = (): MemoryNode =>
  mem("perfect", {
    relativity: 1,
    confidence: 1,
    type: "DECISION",
    status: "activated",
    updated_at: daysAgo(0),
    access_count: 20,
    last_accessed_at: daysAgo(0),
  });

const score = (node: MemoryNode): number => memoryQualityScore(node, NOW);

/** a 必须严格高于 b，且差值不小于 minDelta（防止「权重接上但影响可忽略」的静默失效）。 */
const expectHigher = (a: MemoryNode, b: MemoryNode, minDelta = 0): void => {
  const [sa, sb] = [score(a), score(b)];
  expect(sa).toBeGreaterThan(sb);
  if (minDelta > 0) expect(sa - sb).toBeGreaterThanOrEqual(minDelta);
};

/** 经过完整 policy 后，ids 的相对顺序必须与给出的顺序一致。 */
const expectPolicyOrder = (nodes: MemoryNode[], expected: string[]): void => {
  const data: SearchData = { text_mem: [{ cube_id: "c", memories: nodes }] };
  const out = applyMemoryQualityPolicy(data, { now: NOW });
  const ids = (out.text_mem![0].memories as MemoryNode[]).map((m) => m.id);
  expect(ids.filter((id) => expected.includes(id))).toEqual(expected);
};

describe("memoryQualityScore 不变量", () => {
  it("权重和守卫：各维度取满时得分恰好 1.0", () => {
    expect(score(perfect())).toBeCloseTo(1, 6);
  });

  it("得分恒在 (0, 1] 区间内", () => {
    const extremes = [
      perfect(),
      mem("floor", {
        relativity: 0,
        confidence: 0,
        type: "PROGRESS",
        status: "archived",
        tags: ["auto-capture"],
        updated_at: daysAgo(4000),
        expires_at: daysAgo(1),
      }),
      mem("bare", {}),
      { id: "empty", memory: "", metadata: {} } as MemoryNode,
      { id: "nometa", memory: "" } as MemoryNode,
    ];
    for (const node of extremes) {
      const s = score(node);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(1);
      expect(Number.isFinite(s)).toBe(true);
    }
  });

  it("脏输入不产生 NaN", () => {
    const dirty = [
      mem("nan-rel", { relativity: Number.NaN }),
      mem("str-conf", { confidence: "not-a-number" }),
      mem("bad-date", { updated_at: "definitely-not-a-date" }),
      mem("bad-expiry", { expires_at: "???" }),
      mem("neg-rel", { relativity: -5 }),
      mem("over-rel", { relativity: 99 }),
    ];
    for (const node of dirty) {
      const s = score(node);
      expect(Number.isNaN(s)).toBe(false);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it("relativity 与 confidence 越界值被夹到 [0,1]", () => {
    expect(score(mem("a", { relativity: 99 }))).toBeCloseTo(
      score(mem("b", { relativity: 1 })),
      6,
    );
    expect(score(mem("c", { relativity: -99 }))).toBeCloseTo(
      score(mem("d", { relativity: 0 })),
      6,
    );
  });
});

describe("memoryQualityScore 维度敏感度", () => {
  it("relativity 是最强信号", () => {
    expectHigher(
      mem("hi", { relativity: 0.95 }),
      mem("lo", { relativity: 0.2 }),
      0.35,
    );
  });

  it("confidence 影响排序", () => {
    expectHigher(
      mem("hi", { confidence: 1 }),
      mem("lo", { confidence: 0 }),
      0.1,
    );
  });

  it("过期记忆排在同等未过期记忆之后", () => {
    expectHigher(
      mem("live", { expires_at: daysAgo(-30) }),
      mem("dead", { expires_at: daysAgo(1) }),
      0.3,
    );
  });

  it("activated 优于 archived", () => {
    expectHigher(
      mem("on", { status: "activated" }),
      mem("off", { status: "archived" }),
    );
  });

  it("人工记忆优于 auto-capture", () => {
    expectHigher(mem("curated", {}), mem("auto", { tags: ["auto-capture"] }));
    expectHigher(mem("curated2", {}), mem("auto2", { capture_stage: "auto" }));
  });

  it("PROGRESS 低于同等条件的 DECISION", () => {
    expectHigher(
      mem("dec", { type: "DECISION" }),
      mem("prog", { type: "PROGRESS" }),
    );
  });

  it("年龄单调：越旧的记忆得分不会更高", () => {
    const ages = [0, 7, 30, 90, 365, 730, 1095, 2000];
    const scores = ages.map((d) =>
      score(mem(`age-${d}`, { updated_at: daysAgo(d) })),
    );
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  it("时间维度必须真实影响排序，不能形同虚设", () => {
    // 守卫「衰减接上了但影响可忽略」这类静默失效。
    // 一年的时间差在总分里至少要值 0.01 —— 否则 confidence 的一次抖动就能盖过它。
    expectHigher(
      mem("fresh", { updated_at: daysAgo(0) }),
      mem("year-old", { updated_at: daysAgo(365) }),
      0.01,
    );
  });

  it("缺少时间字段不得优于新鲜记忆", () => {
    const noTime = mem("no-time", { updated_at: undefined });
    expect(score(noTime)).toBeLessThanOrEqual(
      score(mem("fresh", { updated_at: daysAgo(0) })) + 1e-9,
    );
  });

  it("updated_at 缺失时回退到 created_at", () => {
    const viaCreated = mem("created-only", {
      updated_at: undefined,
      created_at: daysAgo(1200),
    });
    expectHigher(mem("fresh", {}), viaCreated, 0.01);
  });
});

describe("applyMemoryQualityPolicy 端到端排序", () => {
  it("固定语料的关键成对顺序", () => {
    // 全部同龄，隔离出 relativity / auto-capture / type 三个维度的相对强度。
    // 「年龄 vs relativity」的张力见衰减测试，不放这里 —— 那对关系会被 P1 改变。
    expectPolicyOrder(
      [
        mem("prime-decision", { relativity: 0.95, confidence: 0.9 }),
        mem("weak-gotcha", { type: "GOTCHA", relativity: 0.3 }),
        mem("auto-noise", { tags: ["auto-capture"], relativity: 0.6 }),
      ],
      ["prime-decision", "auto-noise", "weak-gotcha"],
    );
  });

  it("freshness 标签与阈值一致", () => {
    const data: SearchData = {
      text_mem: [
        {
          cube_id: "c",
          memories: [
            mem("f", { updated_at: daysAgo(10) }),
            mem("s", { updated_at: daysAgo(400) }),
            mem("e", { expires_at: daysAgo(1) }),
          ],
        },
      ],
    };
    const out = applyMemoryQualityPolicy(data, { now: NOW });
    const byId = new Map(
      (out.text_mem![0].memories as MemoryNode[]).map((m) => [
        m.id,
        m.metadata?.freshness,
      ]),
    );
    expect(byId.get("f")).toBe("fresh");
    expect(byId.get("s")).toBe("stale");
    expect(byId.get("e")).toBe("expired");
  });

  it("quality_score 落在 metadata 上且与直接调用一致", () => {
    const node = mem("x", { relativity: 0.77 });
    const data: SearchData = { text_mem: [{ cube_id: "c", memories: [node] }] };
    const out = applyMemoryQualityPolicy(data, { now: NOW });
    const got = Number(
      (out.text_mem![0].memories as MemoryNode[])[0].metadata?.quality_score,
    );
    expect(got).toBeCloseTo(score(node), 6);
  });

  it("跨 cube 全局排序，输出合并为单一 bucket", () => {
    const data: SearchData = {
      text_mem: [
        { cube_id: "one", memories: [mem("low", { relativity: 0.2 })] },
        { cube_id: "two", memories: [mem("high", { relativity: 0.95 })] },
      ],
    };
    const out = applyMemoryQualityPolicy(data, { now: NOW });
    expect(out.text_mem).toHaveLength(1);
    expect(out.text_mem![0].cube_id).toBe("merged");
    expect(
      (out.text_mem![0].memories as MemoryNode[]).map((m) => m.id),
    ).toEqual(["high", "low"]);
  });

  it("空输入不抛异常", () => {
    expect(
      applyMemoryQualityPolicy({ text_mem: [] }, { now: NOW }).text_mem,
    ).toHaveLength(1);
    expect(applyMemoryQualityPolicy({}, { now: NOW }).text_mem).toHaveLength(1);
  });
});

describe("惩罚项强度守卫", () => {
  // 新增评分维度时，容易顺手从惩罚项挪权重凑和为 1 —— 那会静默削弱产品策略
  // （auto-capture 不可信、archived 已退役）。这三条断言把惩罚强度钉住。
  // 数值来自惩罚系数与权重的乘积，容差留在系数侧，权重被削会立刻失败。
  const gap = (
    a: Record<string, unknown>,
    b: Record<string, unknown>,
  ): number => score(mem("a", a)) - score(mem("b", b));

  it("auto-capture 惩罚不得被稀释", () => {
    // (1 - 0.45) × 0.05 = 0.0275
    expect(gap({}, { tags: ["auto-capture"] })).toBeGreaterThanOrEqual(0.025);
  });

  it("status 惩罚不得被稀释", () => {
    // (1 - 0.25) × 0.05 = 0.0375
    expect(
      gap({ status: "activated" }, { status: "archived" }),
    ).toBeGreaterThanOrEqual(0.035);
  });

  it("PROGRESS 惩罚不得被稀释", () => {
    // (1 - 0.82) × 0.05 = 0.009，与衰减无关（两者同龄）
    expect(
      gap({ type: "DECISION" }, { type: "PROGRESS" }),
    ).toBeGreaterThanOrEqual(0.0085);
  });
});

// P1: 按类型分档的指数衰减 + 访问强化
// 设计依据见 docs/design/memory-retrieval-optimization.md 第 6 节
describe("按类型分档的指数衰减", () => {
  const aged = (type: string, days: number): MemoryNode =>
    mem(`${type}-${days}`, { type, updated_at: daysAgo(days) });

  it("衰减曲线是指数形：半衰期处掉一半，两个半衰期处再掉一半", () => {
    // 这个断言与 freshness 权重无关 —— 只检验曲线形状。
    // 线性衰减会让两段落差相等，比值 1；指数衰减比值为 2。
    const hl = 1095; // DECISION
    const s0 = score(aged("DECISION", 0));
    const s1 = score(aged("DECISION", hl));
    const s2 = score(aged("DECISION", hl * 2));
    const s3 = score(aged("DECISION", hl * 3));
    expect((s0 - s1) / (s1 - s2)).toBeCloseTo(2, 1);
    // 第三段同样要减半。只检验前两段时，旧线性实现会因触底而偶然凑出比值 2，
    // 造成假通过；加上第三段后线性实现必然失败（触底后落差为 0）。
    expect((s1 - s2) / (s2 - s3)).toBeCloseTo(2, 1);
  });

  it("PROGRESS 衰减远快于 DECISION", () => {
    const dropProgress =
      score(aged("PROGRESS", 0)) - score(aged("PROGRESS", 30));
    const dropDecision =
      score(aged("DECISION", 0)) - score(aged("DECISION", 30));
    expect(dropProgress).toBeGreaterThan(dropDecision * 5);
  });

  it("各类型半衰期符合设计的相对次序", () => {
    // 同样 180 天后，衰减幅度应满足 PROGRESS > CONFIG > BUGFIX > MILESTONE > DECISION
    const drop = (type: string): number =>
      score(aged(type, 0)) - score(aged(type, 180));
    const order = ["PROGRESS", "CONFIG", "BUGFIX", "MILESTONE", "DECISION"];
    const drops = order.map(drop);
    for (let i = 1; i < drops.length; i += 1) {
      expect(drops[i]).toBeLessThan(drops[i - 1]);
    }
  });

  it("未知类型走保守默认档，介于 CONFIG 与 DECISION 之间", () => {
    const drop = (type: string): number =>
      score(aged(type, 0)) - score(aged(type, 180));
    const unknown = drop("SOMETHING_NEW");
    expect(unknown).toBeLessThan(drop("CONFIG"));
    expect(unknown).toBeGreaterThan(drop("DECISION"));
  });

  it("充分衰减但不归零：极老记忆仍有正分且触及 floor", () => {
    const ancient = score(aged("PROGRESS", 5000));
    const ancient2 = score(aged("PROGRESS", 9000));
    expect(ancient).toBeGreaterThan(0);
    expect(ancient).toBeCloseTo(ancient2, 6); // 已触底，不再继续掉
    // 触底本身不足以说明衰减有效 —— floor 定在 0.55 也会让上面两个断言通过。
    // 必须同时要求衰减在总分里付出实际代价。
    expect(score(aged("PROGRESS", 0)) - ancient).toBeGreaterThan(0.1);
  });

  it("旧 PROGRESS 不再压过新 GOTCHA（P1 修正的核心场景）", () => {
    // 改造前：400 天的 PROGRESS 得 0.665，全新 GOTCHA 得 0.575 —— 顺序是错的。
    // 400 天在旧曲线上只值 0.011，PROGRESS 惩罚只值 0.009，盖不住 relativity 的 0.11 差距。
    expectHigher(
      mem("fresh-gotcha", {
        type: "GOTCHA",
        relativity: 0.3,
        updated_at: daysAgo(0),
      }),
      mem("stale-progress", {
        type: "PROGRESS",
        relativity: 0.5,
        updated_at: daysAgo(400),
      }),
    );
  });
});

describe("访问强化", () => {
  it("被访问过的记忆优于从未被访问的同等记忆", () => {
    expectHigher(mem("used", { access_count: 10 }), mem("unused", {}));
  });

  it("强化随访问次数单调不减", () => {
    const counts = [0, 1, 2, 5, 10, 20, 50, 200];
    const scores = counts.map((c) => score(mem(`c-${c}`, { access_count: c })));
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
    }
  });

  it("对数饱和：低次数的边际收益远大于高次数", () => {
    const at = (c: number): number => score(mem(`s-${c}`, { access_count: c }));
    const earlyGain = at(2) - at(1);
    const lateGain = at(20) - at(19);
    expect(earlyGain).toBeGreaterThan(lateGain * 3);
  });

  it("20 次达到满值，之后不再增长", () => {
    expect(score(mem("a", { access_count: 20 }))).toBeCloseTo(
      score(mem("b", { access_count: 500 })),
      6,
    );
  });

  it("last_accessed_at 唤回旧记忆：近期用过的旧记忆优于同龄未访问的", () => {
    expectHigher(
      mem("revived", {
        updated_at: daysAgo(900),
        last_accessed_at: daysAgo(3),
      }),
      mem("dormant", { updated_at: daysAgo(900) }),
    );
  });

  it("last_accessed_at 不会让旧记忆超过同等条件的新记忆", () => {
    const revived = mem("revived", {
      updated_at: daysAgo(900),
      last_accessed_at: daysAgo(0),
    });
    const brandNew = mem("new", { updated_at: daysAgo(0) });
    expect(score(revived)).toBeLessThanOrEqual(score(brandNew) + 1e-9);
  });

  it("脏 access_count 不产生 NaN", () => {
    for (const bad of [Number.NaN, -5, "abc", null, {}]) {
      const s = score(mem("bad", { access_count: bad }));
      expect(Number.isNaN(s)).toBe(false);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

describe("relativity 缺失改为惩罚", () => {
  it("缺 relativity 的记忆低于显式 0.5 的记忆", () => {
    expectHigher(
      mem("explicit", { relativity: 0.5 }),
      mem("missing", { relativity: undefined }),
    );
  });

  it("缺 relativity 仍高于显式 0", () => {
    expectHigher(
      mem("missing", { relativity: undefined }),
      mem("zero", { relativity: 0 }),
    );
  });
});

describe("向后兼容", () => {
  it("完全没有新字段时，排序与旧实现一致", () => {
    // 旧实现下的预期顺序（人工核算）：relativity 主导，同 relativity 时 confidence 次之。
    expectPolicyOrder(
      [
        mem("c", { relativity: 0.4, confidence: 0.9 }),
        mem("a", { relativity: 0.9, confidence: 0.5 }),
        mem("b", { relativity: 0.7, confidence: 0.7 }),
      ],
      ["a", "b", "c"],
    );
  });

  it("只有 metadata.type 一个字段也不崩", () => {
    for (const t of ["DECISION", "PROGRESS", "", "UNKNOWN_TYPE"]) {
      const s = memoryQualityScore(
        { id: t, memory: "", metadata: { type: t } },
        NOW,
      );
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

// P2: 近重复折叠
// 设计依据见 docs/design/memory-retrieval-optimization.md 第 7 节
describe("近重复折叠", () => {
  /** 带正文的节点 —— 折叠判定看的是 memory 文本而非 id。 */
  const doc = (
    id: string,
    text: string,
    extra: Record<string, unknown> = {},
  ): MemoryNode => ({
    id,
    memory: text,
    metadata: {
      relativity: 0.8,
      confidence: 0.8,
      type: "GOTCHA",
      status: "activated",
      updated_at: daysAgo(0),
      ...extra,
    },
  });

  const fold = (nodes: MemoryNode[], opts = {}): MemoryNode[] => {
    const out = applyMemoryQualityPolicy(
      { text_mem: [{ cube_id: "c", memories: nodes }] },
      { now: NOW, ...opts },
    );
    return out.text_mem![0].memories as MemoryNode[];
  };

  // 项目真实记忆里的措辞，只差标点与尾句 —— 典型近重复。
  const A1 = "PreToolUse 阻断必须 exit 2，exit 1 不算 blocking error";
  const A2 = "PreToolUse 阻断必须 exit 2；exit 1 不算 blocking error，拦不住";

  // 同为 Windows 陷阱但内容完全不同 —— 信息互补，误合会丢东西。
  const B1 = "sed on Git Bash 会把 CRLF 文件改成 LF，进而打断架构图漂移测试";
  const B2 = "hooks matcher 含特殊字符会被当作非锚定正则，从而静默失效";

  it("近重复被折叠，保留得分更高的那条", () => {
    const kept = fold([
      doc("weak", A1, { relativity: 0.4 }),
      doc("strong", A2, { relativity: 0.9 }),
    ]);
    expect(kept.map((m) => m.id)).toEqual(["strong"]);
  });

  it("被折叠的 id 保留在 metadata，信息不丢", () => {
    const kept = fold([
      doc("strong", A2, { relativity: 0.9 }),
      doc("weak", A1, { relativity: 0.4 }),
    ]);
    expect(kept[0].metadata?.duplicates_folded).toEqual(["weak"]);
    expect(kept[0].metadata?.duplicates_folded_count).toBe(1);
  });

  it("完全相同的正文被折叠", () => {
    expect(fold([doc("a", A1), doc("b", A1), doc("c", A1)])).toHaveLength(1);
  });

  it("语义相关但内容不同的记忆不得折叠（CJK 关键场景）", () => {
    expect(fold([doc("crlf", B1), doc("matcher", B2)])).toHaveLength(2);
  });

  it("归一化：markdown 标记与多余空白不影响折叠判定", () => {
    // 同一条记忆经不同书写（加粗、行内代码、多空格、全角空格）后仍须折叠。
    // 缺了归一化，这些纯排版差异会让 n-gram 大量错位，判成两条不同记忆。
    // 同时含大小写差异 —— 真实记忆里 exit/EXIT、error/Error 混用很常见。
    const noisy =
      "**PreToolUse**  阻断必须　`EXIT 2`，exit　1 不算   Blocking  ERROR";
    expect(fold([doc("plain", A1), doc("noisy", noisy)])).toHaveLength(1);
  });

  it("不跨 memory_type 折叠：同一件事的 BUGFIX 与 DECISION 是不同产物", () => {
    const kept = fold([
      doc("bug", A1, { type: "BUGFIX" }),
      doc("dec", A1, { type: "DECISION" }),
    ]);
    expect(kept).toHaveLength(2);
  });

  it("短文本要求完全一致才折叠", () => {
    // 字符 n-gram 在极短串上不稳定，容易把「端口 18000」和「端口 18010」判成近重复。
    expect(
      fold([doc("p1", "端口 18000"), doc("p2", "端口 18010")]),
    ).toHaveLength(2);
    expect(
      fold([doc("s1", "端口 18000"), doc("s2", "端口 18000")]),
    ).toHaveLength(1);
  });

  it("英文近逐字重复同样折叠", () => {
    const base =
      "The archiver marks PROGRESS memories as archived after the configured TTL expires, and the vector store is updated in the same ";
    expect(
      fold([doc("e1", `${base}pass.`), doc("e2", `${base}run.`)]),
    ).toHaveLength(1);
  });

  it("改述不折叠 —— 刻意保守，不是缺陷", () => {
    // "seven days" vs "7 days" 的字符 n-gram Jaccard 约 0.79，低于 0.82 阈值。
    // 保留这条断言是为了把边界钉死：过度折叠丢互补信息，代价高于多占一个 top_k 位。
    // 若确认要更激进，应当调 dedupeThreshold 并显式改写这条断言，而不是悄悄删掉它。
    const e1 =
      "The archiver marks PROGRESS memories as archived after seven days.";
    const e2 = "The archiver marks PROGRESS memories as archived after 7 days.";
    expect(fold([doc("e1", e1), doc("e2", e2)])).toHaveLength(2);
    // 放宽到 0.7 时必须折叠 —— 证明差距只是阈值，判定逻辑本身是有效的。
    expect(
      fold([doc("e1", e1), doc("e2", e2)], { dedupeThreshold: 0.7 }),
    ).toHaveLength(1);
  });

  it("可关闭：dedupe: false 时保留全部", () => {
    expect(fold([doc("a", A1), doc("b", A1)], { dedupe: false })).toHaveLength(
      2,
    );
  });

  it("无折叠发生时不写入多余 metadata 键", () => {
    const kept = fold([doc("crlf", B1), doc("matcher", B2)]);
    for (const node of kept) {
      expect(node.metadata).not.toHaveProperty("duplicates_folded");
      expect(node.metadata).not.toHaveProperty("duplicates_folded_count");
    }
  });

  it("折叠不改变保留项的 quality_score", () => {
    const solo = fold([doc("x", A1, { relativity: 0.9 })])[0];
    const withDup = fold([
      doc("x", A1, { relativity: 0.9 }),
      doc("y", A2, { relativity: 0.3 }),
    ])[0];
    expect(Number(withDup.metadata?.quality_score)).toBeCloseTo(
      Number(solo.metadata?.quality_score),
      6,
    );
  });

  it("空正文与缺 memory 字段不崩、不互相折叠", () => {
    const nodes = [
      { id: "e1", memory: "", metadata: {} } as MemoryNode,
      { id: "e2", metadata: {} } as MemoryNode,
      doc("real", A1),
    ];
    const kept = fold(nodes);
    expect(kept.map((m) => m.id).sort()).toEqual(["e1", "e2", "real"]);
  });

  it("多条近重复折叠成一条，全部 id 都被记录", () => {
    const kept = fold([
      doc("best", A2, { relativity: 0.95 }),
      doc("d1", A1, { relativity: 0.5 }),
      doc("d2", A1 + "。", { relativity: 0.4 }),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe("best");
    expect((kept[0].metadata?.duplicates_folded as string[]).sort()).toEqual([
      "d1",
      "d2",
    ]);
  });
});

// 按 memory_type 分档的折叠阈值（维护者决定，见 docs/design 第 7 节）。
// 每个 Jaccard 值都是**实测**的，不是估的 —— 猜错 0.03 就会让用例落到
// 错误的档位区间，测试变成空断言（本会话已有先例）。
describe("折叠阈值按类型分档", () => {
  const BASE =
    "归档任务把 PROGRESS 类型的记忆在配置的 TTL 之后标记为 archived，向量库同步更新";
  /** 实测 Jaccard 0.7547 —— 只高于 PROGRESS 的 0.70，低于其余三档。 */
  const J75 =
    "归档任务把 PROGRESS 类型的记忆在配置的 7 天之后标记为 archived，向量库同步更新";
  /** 实测 0.8431 —— 高于 0.82，低于 DECISION 的 0.88。 */
  const J84 =
    "归档任务把 PROGRESS 类型的记忆在配置的 TTL 之后标记为 archived，向量库一并更新";
  /** 实测 0.9400 —— 高于全部四档。 */
  const J94 =
    "已确认：归档任务把 PROGRESS 类型的记忆在配置的 TTL 之后标记为 archived，向量库同步更新";
  /** 实测 0.6316 —— 低于全部四档。 */
  const J63 =
    "归档流程把 PROGRESS 类型的记忆在配置的 TTL 之后置为 archived，向量库同步刷新";

  /** 正文里不加 [TYPE] 前缀 —— 前缀会给两条加入共享 n-gram，抬高 Jaccard。 */
  const pair = (type: string, other: string): MemoryNode[] => [
    {
      id: "a",
      memory: BASE,
      metadata: { relativity: 0.9, type, status: "activated", updated_at: daysAgo(0) },
    } as MemoryNode,
    {
      id: "b",
      memory: other,
      metadata: { relativity: 0.5, type, status: "activated", updated_at: daysAgo(0) },
    } as MemoryNode,
  ];

  const kept = (type: string, other: string): number =>
    (
      applyMemoryQualityPolicy(
        { text_mem: [{ cube_id: "c", memories: pair(type, other) }] },
        { now: NOW },
      ).text_mem![0].memories as MemoryNode[]
    ).length;

  it("J≈0.75：PROGRESS 折叠，DECISION 不折叠 —— 分档的核心断言", () => {
    // 同一对文本，只有 memory_type 不同 → 结果必须不同。
    // 退回单一阈值时这一条必红。
    expect(kept("PROGRESS", J75)).toBe(1);
    expect(kept("DECISION", J75)).toBe(2);
  });

  it("J≈0.75：中间两档也不折叠", () => {
    expect(kept("MILESTONE", J75)).toBe(2);
    expect(kept("BUGFIX", J75)).toBe(2);
  });

  it("J≈0.84：BUGFIX 折叠，DECISION 不折叠 —— 钉住 0.82 与 0.88 的差别", () => {
    expect(kept("BUGFIX", J84)).toBe(1);
    expect(kept("CONFIG", J84)).toBe(1);
    expect(kept("DECISION", J84)).toBe(2);
    expect(kept("GOTCHA", J84)).toBe(2);
  });

  it("J≈0.94：最保守档也折叠", () => {
    for (const t of ["DECISION", "GOTCHA", "CODE_PATTERN", "SYNTHESIS"]) {
      expect(kept(t, J94)).toBe(1);
    }
  });

  it("J≈0.63：最激进档也不折叠", () => {
    expect(kept("PROGRESS", J63)).toBe(2);
  });

  it("未知类型走 0.82 兜底 —— 与改动前的单一阈值一致", () => {
    expect(kept("SOMETHING_NEW", J84)).toBe(1);
    expect(kept("SOMETHING_NEW", J75)).toBe(2);
  });

  it("显式 dedupeThreshold 覆盖全部分档", () => {
    const out = applyMemoryQualityPolicy(
      { text_mem: [{ cube_id: "c", memories: pair("DECISION", J75) }] },
      { now: NOW, dedupeThreshold: 0.7 },
    );
    expect((out.text_mem![0].memories as MemoryNode[]).length).toBe(1);
  });
});

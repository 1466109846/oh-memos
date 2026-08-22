/**
 * memos_context_resume 的分层过滤守卫，以及 temporal 查询的 Cypher 契约。
 *
 * ## 存在理由：这是 §9.6 漏掉的第四条路径
 *
 * §9.6 把 WorkingMemory 过滤铺到了 search（经 applyMemoryQualityPolicy）与
 * list_v2（经 prepareListMemories），**漏了 context_resume**。用户在真实会话里
 * 发现：3.1.0 下 search 与 list_v2 都正常，唯独 context_resume 每条记忆仍成对
 * 出现（10 条 = 5 对）。
 *
 * ## 更深的一层：Cypher 不返回 memory_type，下游过滤全部空转
 *
 * `buildTemporalCypher` 原先不 RETURN `memory_type`，构造的 metadata 只有
 * relativity/temporal_rank/source。于是 `isEphemeralTier()` 永远读到 undefined
 * 并判为可见 —— 受害的不只是 context_resume，还有 memos_search 的 temporal
 * intent（两处）与 memos_think。那三处**有**过滤代码，但读不到字段。
 *
 * 所以修法是在 Cypher 里排除 + RETURN 该字段，而不只是在 handler 层加过滤。
 * 附带好处：Cypher 的 LIMIT 在过滤之后，要 10 条就得 10 条真记忆，不必超额取。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildTemporalCypher,
  prepareResumeMemories,
} from "./handlers/search.js";
import type { MemoryNode } from "./types.js";

const rec = (id: string, tier?: string): MemoryNode => ({
  id,
  memory: `mem ${id}`,
  metadata: tier === undefined ? {} : { memory_type: tier },
});

/** 用户实测的形态：每条记忆一个 LongTerm + 一个 Working 副本，内容相同。 */
const paired = (n: number): MemoryNode[] =>
  Array.from({ length: n }, (_, i) => [
    rec(`long${i}`, "LongTermMemory"),
    rec(`work${i}`, "WorkingMemory"),
  ]).flat();

const ids = (nodes: readonly MemoryNode[]): string[] => nodes.map((n) => n.id!);

describe("prepareResumeMemories", () => {
  it("配对输入只留 LongTermMemory —— 用户实测看到的正是这个", () => {
    const out = prepareResumeMemories(paired(5), 10, {});
    expect(ids(out)).toEqual(["long0", "long1", "long2", "long3", "long4"]);
  });

  it("滤层级在 slice 之前：20 条配对输入要 10 条，得 10 条真记忆", () => {
    // 顺序反了就只有 5 条 —— limit 被随即隐藏的副本吃掉。
    // 这正是 prepareListMemories 当初栽过的那个缺陷。
    const out = prepareResumeMemories(paired(10), 10, {});
    expect(out).toHaveLength(10);
    expect(out.every((m) => m.metadata?.memory_type !== "WorkingMemory")).toBe(
      true,
    );
  });

  it("MEMOS_SHOW_WORKING_MEMORY=true 时不过滤", () => {
    const out = prepareResumeMemories(paired(3), 10, {
      MEMOS_SHOW_WORKING_MEMORY: "true",
    });
    expect(ids(out)).toEqual([
      "long0",
      "work0",
      "long1",
      "work1",
      "long2",
      "work2",
    ]);
  });

  it("缺 memory_type 视为可见 —— Lite 的 JSONL 不写该字段", () => {
    // 判成 ephemeral 会让整个 Lite cube 变空。
    const out = prepareResumeMemories([rec("a"), rec("b")], 10, {});
    expect(ids(out)).toEqual(["a", "b"]);
  });

  it("全是 WorkingMemory 时原样返回，不返回空", () => {
    // 「一条都没有」比「多一层」伤害大。
    const all = [rec("w1", "WorkingMemory"), rec("w2", "WorkingMemory")];
    expect(ids(prepareResumeMemories(all, 10, {}))).toEqual(["w1", "w2"]);
  });

  it("空输入返回空", () => {
    expect(prepareResumeMemories([], 10, {})).toEqual([]);
  });

  it("不足 limit 时全部返回", () => {
    const out = prepareResumeMemories(paired(2), 10, {});
    expect(ids(out)).toEqual(["long0", "long1"]);
  });

  it("limit 小于可见数时截断到 limit", () => {
    const out = prepareResumeMemories(paired(8), 3, {});
    expect(ids(out)).toEqual(["long0", "long1", "long2"]);
  });

  it("不改动入参数组", () => {
    const input = paired(3);
    const snapshot = ids(input);
    prepareResumeMemories(input, 10, {});
    expect(ids(input)).toEqual(snapshot);
  });
});

/**
 * 接线守卫。
 *
 * 上面那批断言只证明 `prepareResumeMemories` 本身正确 —— 切断 handler 里的调用，
 * 它们照样全绿。§9.6 与 P1.5 已两次栽在这个形态上（handler 内联逻辑被切断时
 * 全部单测通过），本次 context_resume 被漏掉本身就是第三次。
 *
 * 项目里已有同形先例：Python 侧 `test_graph_schema_stats.py` 断言
 * `handler.handle_export_schema(req)` 出现在源码中，并进一步提取**所有**
 * `handler.handle_*(` 调用逐个 hasattr 检查 —— 这样任何新增的坏调用都会被挡住，
 * 而不只是当初那一个。这里沿用后者的思路：提取 handler 里每一处给
 * `recentMemories` 赋值的位置，要求它们最终都经过 prepareResumeMemories。
 */
describe("handler 接线", () => {
  const src = readFileSync(
    new URL("./handlers/search.ts", import.meta.url),
    "utf8",
  );
  const handlerBody = (() => {
    const start = src.indexOf("export async function handleMemosContextResume");
    expect(start).toBeGreaterThan(0);
    // 到下一个顶层 export 为止
    const rest = src.slice(start + 1);
    const end = rest.indexOf("\nexport ");
    return end > 0 ? rest.slice(0, end) : rest;
  })();

  it("两条路径都经过 prepareResumeMemories", () => {
    // 本地 provider 路径 + API/temporal 路径
    const calls = handlerBody.match(/prepareResumeMemories\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("渲染前的 recentMemories 不来自未过滤的直接赋值", () => {
    // 提取每一处 `recentMemories = ...`（含 let 声明），要求其右侧要么是
    // prepareResumeMemories 的结果，要么是取数调用（随后必有一次过滤赋值）。
    const assigns = [
      ...handlerBody.matchAll(/recentMemories\s*=\s*([^;]+);/g),
    ].map((m) => m[1].trim());
    expect(assigns.length).toBeGreaterThan(0);
    const lastAssign = assigns[assigns.length - 1];
    // 最后一次赋值必须是过滤后的结果 —— 否则渲染用的是未过滤数据
    expect(lastAssign).toContain("prepareResumeMemories");
  });

  it("本地 provider 路径把过滤结果传给 renderContextResume", () => {
    // 形态：renderContextResume(cubeId, prepareResumeMemories(...))
    expect(handlerBody).toMatch(
      /renderContextResume\(\s*cubeId,\s*prepareResumeMemories\(/,
    );
  });

  it("temporal 取数用 RESUME_LIMIT 而非硬编码字面量", () => {
    // Cypher 的 LIMIT 在过滤之后，所以这里不需要超额取 —— 但也不能是裸的 10，
    // 否则与显示上限脱钩后无人察觉。
    expect(handlerBody).toMatch(/getTemporalMemories\(cubeId,\s*RESUME_LIMIT,/);
  });

  it("API 回退路径超额取数 —— 服务端 limit 无法先过滤", () => {
    expect(handlerBody).toMatch(
      /limit:\s*RESUME_LIMIT\s*\*\s*RESUME_OVERFETCH/,
    );
  });
});

describe("buildTemporalCypher", () => {
  it("默认排除 WorkingMemory", () => {
    const c = buildTemporalCypher(undefined, {});
    expect(c).toContain("coalesce(n.memory_type, '') <> 'WorkingMemory'");
  });

  it("RETURN memory_type —— 否则下游 filterEphemeralTier 空转", () => {
    // 这是本次缺陷的根：三处有过滤代码的路径都因为读不到该字段而失效。
    expect(buildTemporalCypher(undefined, {})).toContain(
      "n.memory_type AS memory_type",
    );
  });

  it("MEMOS_SHOW_WORKING_MEMORY=true 时不加排除条件", () => {
    const c = buildTemporalCypher(undefined, {
      MEMOS_SHOW_WORKING_MEMORY: "true",
    });
    expect(c).not.toContain("<> 'WorkingMemory'");
    // 但仍然 RETURN 该字段 —— 逃生开关只关过滤，不关可观测性。
    expect(c).toContain("n.memory_type AS memory_type");
  });

  it("LIMIT 在层级过滤之后 —— 要 N 条就得 N 条真记忆", () => {
    const c = buildTemporalCypher(24, {});
    const tier = c.indexOf("<> 'WorkingMemory'");
    const limit = c.indexOf("LIMIT $top_k");
    expect(tier).toBeGreaterThan(0);
    expect(limit).toBeGreaterThan(tier);
  });

  it("时间窗为真值时加时间过滤，缺省时不加", () => {
    expect(buildTemporalCypher(24, {})).toContain("duration({hours: 24})");
    expect(buildTemporalCypher(undefined, {})).not.toContain("duration(");
  });

  it("时间窗与层级过滤共存", () => {
    const c = buildTemporalCypher(72, {});
    expect(c).toContain("duration({hours: 72})");
    expect(c).toContain("<> 'WorkingMemory'");
  });

  it("保留原有的 user_name 与 status 约束", () => {
    // 这两条是 cube 隔离与归档过滤，改 Cypher 时最容易顺手弄丢。
    const c = buildTemporalCypher(24, {});
    expect(c).toContain("n.user_name = $user_name");
    expect(c).toContain("n.status = 'activated'");
  });

  it("仍按 updated_at 降序 —— 这是「最近」的定义", () => {
    expect(buildTemporalCypher(24, {})).toContain("ORDER BY n.updated_at DESC");
  });
});

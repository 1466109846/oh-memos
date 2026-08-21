/**
 * 检索期注解的显示层测试。
 *
 * 存在理由：P1.5 时发现 `formatters.ts` 的改动会整体逃出单测（只有驱动真实
 * MCP server 的 lite smoke 能覆盖），而 quality policy 往 metadata 写的字段
 * 若不显示就等于没算。这里把「算出来的东西真的到了输出」钉住。
 */
import { describe, expect, it } from "vitest";
import { formatMemoriesForDisplay, memoryAnnotations } from "./formatters.js";
import { compactedResultToText, toMinimal } from "./models.js";
import type { MemoryNode, SearchData } from "./types.js";

describe("memoryAnnotations", () => {
  it("干净记忆无任何附加", () => {
    expect(memoryAnnotations({})).toBe("");
    expect(memoryAnnotations(undefined)).toBe("");
    expect(memoryAnnotations(null)).toBe("");
    expect(memoryAnnotations({ freshness: "fresh" })).toBe("");
    expect(memoryAnnotations({ access_count: 0 })).toBe("");
    expect(memoryAnnotations({ duplicates_folded: [] })).toBe("");
  });

  it("显示 access_count", () => {
    expect(memoryAnnotations({ access_count: 3 })).toBe(" · access_count 3");
  });

  it("stale 与 expired 显示，fresh 不显示", () => {
    expect(memoryAnnotations({ freshness: "stale" })).toBe(" · stale");
    expect(memoryAnnotations({ freshness: "expired" })).toBe(" · expired");
    expect(memoryAnnotations({ freshness: "fresh" })).toBe("");
  });

  it("显示折叠数量与被折叠的 id —— 这是「信息不丢」的唯一出口", () => {
    expect(memoryAnnotations({ duplicates_folded: ["a", "b"] })).toBe(
      " · folded 2: a, b",
    );
  });

  it("多个注解按固定顺序拼接", () => {
    expect(
      memoryAnnotations({
        access_count: 5,
        freshness: "stale",
        duplicates_folded: ["x"],
      }),
    ).toBe(" · access_count 5 · stale · folded 1: x");
  });

  it("脏值不产生 NaN / undefined 字样", () => {
    for (const bad of [Number.NaN, -3, "abc", null, {}, []]) {
      const out = memoryAnnotations({ access_count: bad });
      expect(out).not.toContain("NaN");
      expect(out).not.toContain("undefined");
    }
    expect(memoryAnnotations({ duplicates_folded: "not-an-array" })).toBe("");
    expect(memoryAnnotations({ access_count: 2.9 })).toBe(" · access_count 2");
  });
});

describe("formatMemoriesForDisplay 带上注解", () => {
  const data = (metadata: Record<string, unknown>): SearchData => ({
    text_mem: [
      {
        cube_id: "c",
        memories: [
          {
            id: "m1",
            memory: "[DECISION] some content",
            metadata,
          } as MemoryNode,
        ],
      },
    ],
  });

  it("注解出现在 ID 行上", () => {
    const out = formatMemoriesForDisplay(
      data({ type: "DECISION", access_count: 7 }),
    );
    expect(out).toContain("access_count 7");
    expect(out).toMatch(/ID: `m1`.*access_count 7/);
  });

  it("被折叠的 id 出现在输出里", () => {
    const out = formatMemoriesForDisplay(
      data({ type: "DECISION", duplicates_folded: ["dup-1", "dup-2"] }),
    );
    expect(out).toContain("dup-1");
    expect(out).toContain("dup-2");
  });

  it("干净记忆的 ID 行不带分隔符", () => {
    const out = formatMemoriesForDisplay(data({ type: "DECISION" }));
    expect(out).toContain("ID: `m1`");
    expect(out).not.toContain("ID: `m1` ·");
  });
});

// compact 路径。>15 条结果时只显示 5 条预览，走 toMinimal ——
// 它原本丢掉整个 metadata，而 compact 恰恰在结果量大时触发，
// 正是最需要 stale / access_count 信号的场合。
describe("compact 输出保留注解", () => {
  it("toMinimal 带出注解，干净记忆不带该字段", () => {
    const withMeta = toMinimal({
      id: "m1",
      memory: "[GOTCHA] something",
      metadata: { type: "GOTCHA", access_count: 4, freshness: "stale" },
    } as MemoryNode);
    expect(withMeta.annotations).toBe(" · access_count 4 · stale");

    const clean = toMinimal({
      id: "m2",
      memory: "[GOTCHA] other",
      metadata: { type: "GOTCHA", freshness: "fresh" },
    } as MemoryNode);
    expect(clean.annotations).toBeUndefined();
  });

  it("compactedResultToText 把注解渲染在 ID 行上", () => {
    const out = compactedResultToText({
      preview: [
        toMinimal({
          id: "m1",
          memory: "[BUGFIX] fixed it",
          metadata: { type: "BUGFIX", access_count: 9, duplicates_folded: ["d1"] },
        } as MemoryNode),
      ],
      totalCount: 20,
      omittedCount: 19,
      message: "use memos_get",
      query: "q",
      cubeId: "c",
    });
    expect(out).toContain("access_count 9");
    expect(out).toContain("folded 1: d1");
  });

  it("无注解时 compact 的 ID 行不带分隔符", () => {
    const out = compactedResultToText({
      preview: [toMinimal({ id: "m1", memory: "[DECISION] x", metadata: { type: "DECISION" } } as MemoryNode)],
      totalCount: 20,
      omittedCount: 19,
      message: "use memos_get",
      query: "q",
      cubeId: "c",
    });
    expect(out).toContain("ID: `m1`");
    expect(out).not.toContain("ID: `m1` ·");
  });
});

// P4 扩散来源标记。与 access_count / folded 同一诉求：算出来的必须显示，
// 否则等于没算 —— 这次差点重犯，smoke 报「0 处 via 标记」才暴露。
describe("扩散来源注解", () => {
  it("显示边类型与来源种子", () => {
    expect(
      memoryAnnotations({ spread_via: "CAUSE", spread_from: "49b59302-5bf2-4a42" }),
    ).toBe(" · via CAUSE from 49b59302");
  });

  it("缺 spread_from 时只显示边类型", () => {
    expect(memoryAnnotations({ spread_via: "RELATE" })).toBe(" · via RELATE");
  });

  it("非扩散节点不带该注解", () => {
    expect(memoryAnnotations({ spread_via: "" })).toBe("");
    expect(memoryAnnotations({ access_count: 3 })).not.toContain("via");
  });

  it("与其他注解共存，顺序稳定", () => {
    expect(
      memoryAnnotations({ access_count: 2, freshness: "stale", spread_via: "CONDITION" }),
    ).toBe(" · access_count 2 · stale · via CONDITION");
  });
});

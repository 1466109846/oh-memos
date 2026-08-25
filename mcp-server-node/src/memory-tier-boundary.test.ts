/**
 * 分层过滤强制机制的守卫。
 *
 * ## 这组测试与普通单测的区别
 *
 * 普通单测问"过滤函数算得对不对"。实测证明这个问题问错了：**切断
 * 所有层级过滤后，319 项 vitest 依然全绿**（`handlers/memory.ts` 的注释记录）。
 * 因为漏过滤的形态是"函数没被调用"，而不是"函数算错了"。
 *
 * 所以这里问的是另一个问题：**每条分派路由是否都被想过**。手段是源码扫描 +
 * 清单比对，形态沿用 `context-resume.test.ts` 的 `describe("handler 接线")`，
 * 但把覆盖面从单个 handler 扩到全部 28 条路由，并做成 fail-closed。
 *
 * ## fail-closed 的三条棘轮
 *
 * 1. 新增工具没在清单里分类 → 失败（清单 vs 分派表双向比对）
 * 2. 静默新增已知缺口 → 失败（KNOWN_GAPS 是冻结集合）
 * 3. 修好缺口却忘了从 KNOWN_GAPS 删 → 也失败（否则集合永久膨胀成豁免名单）
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  ROUTE_CONTRACTS,
  KNOWN_GAPS,
  CYPHER_PROJECTION_BASELINE,
  parseDispatchRoutes,
  hasTierSignal,
  extractMemoryReturns,
  cypherThreadsMemoryType,
} from "./memory-tier-boundary.js";

const HANDLER_DIR = fileURLToPath(new URL("./handlers/", import.meta.url));

const readHandler = (file: string): string =>
  readFileSync(join(HANDLER_DIR, file), "utf8");

const indexSource = readHandler("index.ts");

describe("清单 vs 分派表（棘轮 1：新增路由必须分类）", () => {
  const dispatched = parseDispatchRoutes(indexSource);
  const declared = ROUTE_CONTRACTS.map((c) => c.route);

  it("解析器确实解析出了路由 —— 防止正则失配导致守卫空转", () => {
    // 若解析器返回空数组，下面所有比对都会平凡通过 —— 守卫会变成装饰品。
    expect(dispatched.length).toBeGreaterThan(20);
    // 带数字后缀的路由必须在内：初版 [a-z_]+ 漏掉 memos_list_v2，
    // 清单会自称完整却实际缺一条。
    expect(dispatched).toContain("memos_list_v2");
  });

  it("分派表里的每条路由都在清单里", () => {
    const missing = dispatched.filter((r) => !declared.includes(r));
    expect(
      missing,
      `这些路由未在 ROUTE_CONTRACTS 里分类。新增工具时必须补一条，` +
        `说明它是否会把记忆 id 交给 agent：${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("清单里没有已不存在的路由 —— 删工具时清单要跟着删", () => {
    const stale = declared.filter((r) => !dispatched.includes(r));
    expect(stale, `这些路由在清单里但分派表已无：${stale.join(", ")}`).toEqual(
      [],
    );
  });

  it("每条 evidence 都非空且具体", () => {
    for (const c of ROUTE_CONTRACTS) {
      expect(c.evidence.length, `${c.route} 的 evidence 太短`).toBeGreaterThan(
        15,
      );
    }
  });

  it("没有重复条目", () => {
    expect(new Set(declared).size).toBe(declared.length);
  });
});

describe("已知缺口冻结（棘轮 2/3）", () => {
  it("KNOWN_GAPS 与清单里的 known-gap 完全一致", () => {
    const marked = ROUTE_CONTRACTS.filter(
      (c) => c.tierClass === "known-gap",
    ).map((c) => c.route);
    // 双向比对：新增缺口忘了登记 → 失败；修好了忘了摘掉 → 也失败。
    expect([...marked].sort()).toEqual([...KNOWN_GAPS].sort());
  });

  it("缺口数量不得增加", () => {
    // 硬编码上界让"又多一个缺口"必须显式改这行数字，无法顺手混过。
    expect(KNOWN_GAPS.length).toBeLessThanOrEqual(4);
  });

  it("每个缺口都说明了修复前提，而不只是承认存在", () => {
    for (const c of ROUTE_CONTRACTS.filter(
      (x) => x.tierClass === "known-gap",
    )) {
      // 缺口的 evidence 必须含实测依据（数字），否则无从判断修复代价。
      expect(/\d/.test(c.evidence), `${c.route} 的缺口说明缺实测依据`).toBe(
        true,
      );
    }
  });
});

describe("声明为已过滤的路由必须真有信号（形态 1）", () => {
  const needSignal = ROUTE_CONTRACTS.filter(
    (c) => c.tierClass === "filtered" || c.tierClass === "filtered-noop-risk",
  );

  it("有路由被声明为已过滤 —— 否则本组测试平凡通过", () => {
    expect(needSignal.length).toBeGreaterThan(0);
  });

  for (const c of needSignal) {
    it(`${c.route} 的 handler 里存在层级信号`, () => {
      expect(
        hasTierSignal(readHandler(c.file)),
        `${c.file} 声明为 ${c.tierClass}，但源码里查不到任何层级信号。` +
          `若过滤被移到别处，请更新 TIER_SIGNALS 或改分类。`,
      ).toBe(true);
    });
  }

  it("声明为 known-gap 的 handler 确实没有信号 —— 否则分类过时了", () => {
    // 反向断言：缺口被修好后这条会红，迫使分类跟着改。
    for (const route of KNOWN_GAPS) {
      const c = ROUTE_CONTRACTS.find((x) => x.route === route);
      expect(c).toBeDefined();
      if (!c) continue;
      // think.ts / graph.ts 各自独立；同文件多路由时只要文件里没信号即可。
      expect(
        hasTierSignal(readHandler(c.file)),
        `${c.file} 现在有层级信号了 —— ${route} 可能已修好，` +
          `请把它从 KNOWN_GAPS 移除并改 tierClass。`,
      ).toBe(false);
    }
  });
});

describe("Cypher 必须带出 memory_type（形态 2：过滤读不到字段）", () => {
  // 这是更隐蔽的复发形态：过滤接了，但构造 metadata 时漏掉 memory_type，
  // isEphemeralTier() 永远读到 undefined 判为可见 —— 四个调用点全部空转，
  // 且没有任何测试会红。search.ts:84-104 记录了这次实例。
  const cypherFiles = ["search.ts", "graph.ts"];

  for (const file of cypherFiles) {
    it(`${file} 里漏 memory_type 的 RETURN 数量等于冻结基线`, () => {
      const clauses = extractMemoryReturns(readHandler(file));
      const bad = clauses.filter((c) => !cypherThreadsMemoryType(c));
      const baseline = CYPHER_PROJECTION_BASELINE[file] ?? 0;

      expect(
        bad.length,
        bad.length > baseline
          ? `${file} 新增了漏 memory_type 的 RETURN（${baseline} → ${bad.length}）。` +
              `下游过滤会读到 undefined 并判为可见 —— 空转，且不会有别的测试报警。` +
              `首个未带字段的投影：\n${bad[0]?.trim().slice(0, 200)}`
          : `${file} 修好了 ${baseline - bad.length} 处（${baseline} → ${bad.length}）。` +
              `请把 CYPHER_PROJECTION_BASELINE["${file}"] 调到 ${bad.length}，棘轮不回退。`,
      ).toBe(baseline);
    });
  }

  it("基线表只覆盖真实存在的文件", () => {
    // 文件改名或删除后，基线条目会变成一个永远满足的空断言，
    // 悄悄给该文件发放豁免。
    for (const file of Object.keys(CYPHER_PROJECTION_BASELINE)) {
      expect(
        existsSync(join(HANDLER_DIR, file)),
        `CYPHER_PROJECTION_BASELINE 里的 ${file} 不存在了，请删掉这条或改名。`,
      ).toBe(true);
    }
  });

  it("基线不为 0 的文件必须都在 KNOWN_GAPS 里有对应路由", () => {
    // 非零基线是欠账，必须记在冻结缺口里，不能只藏在这张表。
    const gapFiles = new Set(
      ROUTE_CONTRACTS.filter((c) => c.tierClass === "known-gap").map(
        (c) => c.file,
      ),
    );
    for (const [file, n] of Object.entries(CYPHER_PROJECTION_BASELINE)) {
      if (n === 0) continue;
      expect(
        gapFiles.has(file),
        `${file} 基线为 ${n}（有漏字段的投影）却没有任何 known-gap 路由指向它 —— ` +
          `这笔欠账没被 KNOWN_GAPS 记录，会被遗忘。`,
      ).toBe(true);
    }
  });
});

/**
 * 原文取回的守卫。
 *
 * 数据形态取自实测：`MOS_TYPED_SAVE_FAST=false` 下一条 877 字原文被 LLM 切成 5 条，
 * 每条 `memory` 是约 200-250 字概括，`metadata.sources[0].content` 是同一份逐字原文
 * （5 条 sha 相同），`key` 与 `created_at` 各不相同。
 *
 * 同源判定必须用内容指纹：实测 5 条的 `session_id` 相同，但那是整个 MCP 会话的 id，
 * 用它分组会把同会话里无关的写入也归进来。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findSiblings,
  renderVerbatimSections,
  sourceFingerprint,
  verbatimOf,
} from "./verbatim-source.js";
import type { MemoryNode } from "./types.js";

/** LLM 抽取路径写出的节点：memory 是概括，sources[0].content 是原文。 */
const extracted = (
  id: string,
  key: string,
  original: string,
  summary = `概括 ${key}`,
): MemoryNode => ({
  id,
  memory: summary,
  metadata: {
    key,
    session_id: "same-session-for-all",
    sources: [
      { type: "chat", role: "user", chat_time: "03:53 AM", content: original },
    ],
  },
});

/** fast-path 写出的节点：memory 就是原文，没有 sources。 */
const verbatimStored = (id: string, text: string): MemoryNode => ({
  id,
  memory: text,
  metadata: { key: text.slice(0, 20) },
});

// 必须超过任何合理的截断阈值：初版用 30 字原文，截断到 200 字的变异改不动它，
// 于是「原文被截断」——正是本次要修的缺陷——没被抓住。现在 600+ 字。
const ORIGINAL = [
  "## 标题",
  "",
  "第一段内容。".repeat(20),
  "",
  "### 小节",
  "",
  "第二段内容。".repeat(20),
  "",
  "### 末节 —— 这一段必须出现在输出里，否则说明原文被截断了",
  "",
  "尾部标记 TAIL_MARKER_MUST_SURVIVE",
].join("\n");
const OTHER = "## 另一份原文\n\n完全不同的内容。";

describe("verbatimOf", () => {
  it("从 sources[0].content 取出原文", () => {
    expect(verbatimOf(extracted("a", "k1", ORIGINAL))).toBe(ORIGINAL);
  });

  it("fast-path 节点返回 null —— 调用方据此保持原有渲染", () => {
    expect(verbatimOf(verbatimStored("a", ORIGINAL))).toBeNull();
  });

  it("sources 为空数组返回 null", () => {
    expect(
      verbatimOf({ id: "a", memory: "x", metadata: { sources: [] } }),
    ).toBeNull();
  });

  it("sources 不是数组返回 null", () => {
    // 字符串没有判别力：`"str"[0]` 是字符 `"s"`，没有 .content，宽松实现也返回 null。
    // 对象伪装成数组才能区分 —— truthy 检查会取到 {0:{content}}[0].content。
    for (const bad of [
      "not-an-array",
      { 0: { content: "对象伪装成数组" }, length: 1 },
      42,
      true,
    ]) {
      expect(
        verbatimOf({ id: "a", memory: "x", metadata: { sources: bad } }),
      ).toBeNull();
    }
  });

  it("content 为空串或纯空白返回 null", () => {
    for (const bad of ["", "   ", "\n\t "]) {
      expect(
        verbatimOf({
          id: "a",
          memory: "x",
          metadata: { sources: [{ content: bad }] },
        }),
      ).toBeNull();
    }
  });

  it("content 不是字符串返回 null", () => {
    for (const bad of [null, 42, {}, []]) {
      expect(
        verbatimOf({
          id: "a",
          memory: "x",
          metadata: { sources: [{ content: bad }] },
        }),
      ).toBeNull();
    }
  });

  it("缺 metadata、缺 node 都返回 null 而不抛", () => {
    expect(verbatimOf({ id: "a", memory: "x" })).toBeNull();
    expect(verbatimOf(undefined)).toBeNull();
    expect(verbatimOf(null)).toBeNull();
  });
});

describe("sourceFingerprint", () => {
  it("同一份原文得到相同指纹", () => {
    const a = extracted("a", "k1", ORIGINAL);
    const b = extracted("b", "k2", ORIGINAL);
    expect(sourceFingerprint(a)).toBe(sourceFingerprint(b));
  });

  it("不同原文得到不同指纹", () => {
    expect(sourceFingerprint(extracted("a", "k", ORIGINAL))).not.toBe(
      sourceFingerprint(extracted("b", "k", OTHER)),
    );
  });

  it("无原文返回 null —— 否则所有 fast-path 记忆会归成一组", () => {
    expect(sourceFingerprint(verbatimStored("a", ORIGINAL))).toBeNull();
  });

  it("长度前缀参与指纹，前缀相同但长度不同不会碰撞", () => {
    const short = extracted("a", "k", "abc");
    const long = extracted("b", "k", "abcdef");
    expect(sourceFingerprint(short)).not.toBe(sourceFingerprint(long));
  });
});

describe("findSiblings", () => {
  const target = extracted("t", "目标节点", ORIGINAL);
  const sib1 = extracted("s1", "碎片一", ORIGINAL);
  const sib2 = extracted("s2", "碎片二", ORIGINAL);
  const unrelated = extracted("u", "无关", OTHER);
  const fastPath = verbatimStored("f", ORIGINAL);

  it("找出同源碎片", () => {
    const out = findSiblings(target, [target, sib1, sib2, unrelated]);
    expect(out.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("带上每条的 key —— 这是看清切分方式的依据", () => {
    const out = findSiblings(target, [sib1, sib2]);
    expect(out.map((s) => s.key)).toEqual(["碎片一", "碎片二"]);
  });

  it("排除自身", () => {
    expect(findSiblings(target, [target]).map((s) => s.id)).toEqual([]);
  });

  it("排除不同原文的节点", () => {
    expect(findSiblings(target, [unrelated]).map((s) => s.id)).toEqual([]);
  });

  it("排除 fast-path 节点，即使其 memory 恰好等于同一份原文", () => {
    // fastPath 的 memory 就是 ORIGINAL，但它没有 sources → 指纹 null，不该被归入。
    expect(findSiblings(target, [fastPath]).map((s) => s.id)).toEqual([]);
  });

  it("target 无原文时返回空 —— fast-path 记忆没有同源概念", () => {
    expect(findSiblings(fastPath, [sib1, sib2]).map((s) => s.id)).toEqual([]);
  });

  it("id 重复只取一次", () => {
    const out = findSiblings(target, [sib1, sib1, sib2]);
    expect(out.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("跳过缺 id 的节点", () => {
    const noId = {
      memory: "x",
      metadata: { sources: [{ content: ORIGINAL }] },
    };
    expect(findSiblings(target, [noId, sib1]).map((s) => s.id)).toEqual(["s1"]);
  });

  it("受 limit 约束", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      extracted(`s${i}`, `k${i}`, ORIGINAL),
    );
    expect(findSiblings(target, many, 12)).toHaveLength(12);
    expect(findSiblings(target, many, 3)).toHaveLength(3);
  });

  it("session_id 相同但原文不同的不算同源", () => {
    // 这是实现必须避开的陷阱：5 条碎片确实共享 session_id，
    // 但同一会话里的无关写入也共享它。
    expect(unrelated.metadata?.session_id).toBe(target.metadata?.session_id);
    expect(findSiblings(target, [unrelated])).toHaveLength(0);
  });

  it("空候选集返回空", () => {
    expect(findSiblings(target, [])).toEqual([]);
  });
});

describe("renderVerbatimSections", () => {
  it("无原文时返回空数组 —— 渲染层保持原有行为", () => {
    expect(renderVerbatimSections(null, [], "概括")).toEqual([]);
  });

  it("原文成段输出，且是完整原文不截断", () => {
    const out = renderVerbatimSections(ORIGINAL, [], "概括").join("\n");
    expect(out).toContain("### 原文 | Verbatim source");
    expect(out).toContain(ORIGINAL);
    // 尾部标记必须在 —— 任何截断都会把它切掉
    expect(out).toContain("TAIL_MARKER_MUST_SURVIVE");
    expect(ORIGINAL.length).toBeGreaterThan(300);
  });

  it("同时给出本节点的抽取概括 —— 它是向量化与建边的实际输入", () => {
    const out = renderVerbatimSections(ORIGINAL, [], "这是概括").join("\n");
    expect(out).toContain("抽取概括");
    expect(out).toContain("这是概括");
  });

  it("概括与原文相同时不重复输出该区块", () => {
    const out = renderVerbatimSections(ORIGINAL, [], ORIGINAL).join("\n");
    expect(out).not.toContain("抽取概括");
  });

  it("概括为空时不输出该区块", () => {
    for (const empty of ["", "   "]) {
      expect(
        renderVerbatimSections(ORIGINAL, [], empty).join("\n"),
      ).not.toContain("抽取概括");
    }
  });

  it("列出同源节点的 id 与 key，并报数量", () => {
    const out = renderVerbatimSections(
      ORIGINAL,
      [
        { id: "s1", key: "碎片一" },
        { id: "s2", key: "碎片二" },
      ],
      "概括",
    ).join("\n");
    expect(out).toContain("同源节点 | Sibling nodes (2)");
    expect(out).toContain("`s1` — 碎片一");
    expect(out).toContain("`s2` — 碎片二");
  });

  it("无同源节点时不输出该区块", () => {
    expect(
      renderVerbatimSections(ORIGINAL, [], "概括").join("\n"),
    ).not.toContain("同源节点");
  });

  it("key 缺失时只输出 id，不留悬空破折号", () => {
    const out = renderVerbatimSections(
      ORIGINAL,
      [{ id: "s1", key: "" }],
      "概括",
    ).join("\n");
    expect(out).toContain("`s1`");
    expect(out).not.toContain("`s1` —");
  });
});

/**
 * 接线守卫。
 *
 * 上面全部断言只证明这四个函数本身正确 —— 切断 handler 里的调用，它们照样全绿。
 * 本会话已三次栽在这个形态上（§9.6 分层过滤、P1.5 访问强化、context_resume），
 * 所以必须让 handler 与测试调用同一个函数，并断言调用确实存在。
 */
describe("handler 接线", () => {
  const src = readFileSync(
    new URL("./handlers/memory.ts", import.meta.url),
    "utf8",
  );
  const body = (() => {
    const start = src.indexOf("export async function handleMemosGet");
    expect(start).toBeGreaterThan(0);
    const rest = src.slice(start + 1);
    const end = rest.indexOf("\nexport ");
    return end > 0 ? rest.slice(0, end) : rest;
  })();

  // 按路径切开再各自断言。合计计数没有判别力：Lite 路径自己就有 2 次 verbatimOf
  // 调用，砍掉 Full 路径那次时 `>= 2` 依然成立 —— 变异实测放过了 W1。
  const liteBranch = (() => {
    const i = body.indexOf("const localProvider");
    const j = body.indexOf("ensureCubeRegistered(cubeId)");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    return body.slice(i, j);
  })();
  const fullBranch = (() => {
    const j = body.indexOf("ensureCubeRegistered(cubeId)");
    expect(j).toBeGreaterThan(-1);
    return body.slice(j);
  })();

  it("Full 路径读原文", () => {
    expect(fullBranch).toMatch(/verbatimOf\(resultData\)/);
  });

  it("Full 路径渲染原文区块", () => {
    expect(fullBranch).toMatch(/renderVerbatimSections\(/);
  });

  it("Lite 路径用原文的有无决定渲染分支", () => {
    // 必须断言**条件本身**：只查 `verbatimOf(node)` 出现过没有判别力 ——
    // 它在 renderVerbatimSections(verbatimOf(node), ...) 里也出现，
    // 所以把条件换成 `true` 时旧断言仍然通过（变异实测放过了 W3）。
    expect(liteBranch).toMatch(/\.\.\.\(verbatimOf\(node\) === null/);
  });

  it("Lite 路径渲染原文区块", () => {
    expect(liteBranch).toMatch(/renderVerbatimSections\(/);
  });

  it("Full 路径取同源碎片", () => {
    expect(body).toMatch(/fetchSiblings\(/);
  });

  it("fetchSiblings 用 findSiblings 而不是自己比对", () => {
    const fetchFn = (() => {
      const i = src.indexOf("async function fetchSiblings");
      expect(i).toBeGreaterThan(0);
      const rest = src.slice(i + 1);
      const end = rest.indexOf("\nexport ");
      return end > 0 ? rest.slice(0, end) : rest;
    })();
    expect(fetchFn).toMatch(/findSiblings\(/);
  });

  it("无原文时仍走原有 ### Content 分支", () => {
    // 回归守卫：fast-path 记忆的输出不能因为这次改动而变化。
    expect(body).toMatch(/### Content/);
  });
});

/**
 * canvas-format tests.
 *
 * The canvas file is the single source of truth, so the round-trip
 * (parse ∘ render === identity) is the property that matters most: anything that
 * survives a render but not a parse is silent data loss on the next update.
 */

import { describe, it, expect } from "vitest";

import {
  allocateNodeId,
  canvasName,
  escapeLabel,
  parseCanvas,
  renderCanvas,
  slugify,
  truncateSummary,
  type Canvas,
  type CanvasNode,
} from "./canvas-format.js";

// ============================================================================
// Fixtures
// ============================================================================

function node(overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: "000-N1",
    status: "todo",
    summary: "do the thing",
    ref: null,
    ...overrides,
  };
}

function canvas(overrides: Partial<Canvas> = {}): Canvas {
  return {
    prefix: "000",
    taskGoal: "ship the canvas",
    createdTime: "2026-08-13T10:00:00.000Z",
    updatedTime: "2026-08-13T10:00:00.000Z",
    nodes: [node()],
    ...overrides,
  };
}

// ============================================================================
// slugify
// ============================================================================

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Ship The Canvas")).toBe("ship-the-canvas");
  });

  it("strips characters outside the whitelist", () => {
    expect(slugify("a/b\\c:d*e?f")).toBe("a-b-c-d-e-f");
  });

  it("collapses runs of separators and trims them", () => {
    expect(slugify("  --a---b--  ")).toBe("a-b");
  });

  it("refuses to emit traversal sequences", () => {
    expect(slugify("../../etc/passwd")).toBe("etc-passwd");
    expect(slugify("..")).toBe("");
    expect(slugify(".")).toBe("");
  });

  it("returns empty for input with nothing usable", () => {
    expect(slugify("///")).toBe("");
    expect(slugify("")).toBe("");
  });

  it("caps length", () => {
    expect(slugify("x".repeat(200)).length).toBeLessThanOrEqual(60);
  });

  it("keeps CJK out of the filename rather than mangling it", () => {
    // Non-ASCII is dropped, so a purely CJK title yields no slug and the
    // caller must fall back — better than a filename that varies by codepage.
    expect(slugify("任务画布")).toBe("");
  });

  it("honours a narrower cap", () => {
    expect(slugify("abcdefghij", 4)).toBe("abcd");
  });

  it("clamps a wider cap to SLUG_MAX", () => {
    // Otherwise a caller could opt out of the one invariant this cap exists for.
    expect(slugify("x".repeat(200), 500).length).toBe(60);
  });

  it("does not leave a trailing hyphen when the cap lands on one", () => {
    // A slug ending in `-` would render a filename like `000-abc-.mmd`.
    expect(slugify("abc def", 4)).toBe("abc");
  });

  it("is a fixed point: slugging a slug changes nothing", () => {
    // canvasPath slugs again on the way to disk, so anything that is not a
    // fixed point is a name the caller was told but the filesystem never saw.
    const once = slugify("Ship The Canvas!! now", 12);
    expect(slugify(once)).toBe(once);
  });
});

// ============================================================================
// canvasName
// ============================================================================

describe("canvasName", () => {
  it("joins the prefix and the slugified goal", () => {
    expect(canvasName("000", "Ship The Canvas")).toBe("000-ship-the-canvas");
  });

  it("falls back to <prefix>-task for a goal with no ASCII", () => {
    expect(canvasName("007", "任务画布")).toBe("007-task");
  });

  it("keeps the whole name inside the slug cap", () => {
    const long =
      "verify canvas delete and ref escaping over a live mcp connection today";
    expect(canvasName("000", long).length).toBeLessThanOrEqual(60);
  });

  it("survives the second slugify unchanged — the reported name is the real one", () => {
    // The defect this function exists to fix: `open` reported a 61-char name,
    // canvasPath slugged it back to 60, and `list` showed a name the caller was
    // never given. Every composed name must be a fixed point of slugify.
    const goals = [
      "verify 3.1.6 canvas delete and ref escaping over live MCP",
      "x".repeat(200),
      "refactor the retrieval pipeline for cross encoder reranking phase one",
      "a b c d e f g h i j k l m n o p q r s t u v w x y z 0 1 2 3 4 5 6 7 8 9",
      "任务画布",
      "trailing hyphen bait ------",
    ];
    for (const prefix of ["000", "042", "999"]) {
      for (const goal of goals) {
        const name = canvasName(prefix, goal);
        expect(slugify(name), `${prefix} / ${goal.slice(0, 30)}`).toBe(name);
      }
    }
  });

  it("still distinguishes goals that share their first 60 characters", () => {
    // The prefix carries the distinction, so truncation must not merge them.
    const base = "refactor the retrieval pipeline for cross encoder reranking";
    expect(canvasName("000", `${base} phase one`)).not.toBe(
      canvasName("001", `${base} phase two`),
    );
  });
});

// ============================================================================
// escapeLabel
// ============================================================================

describe("escapeLabel", () => {
  it("neutralises quotes that would end a Mermaid label", () => {
    expect(escapeLabel('say "hi"')).not.toContain('"');
  });

  it("neutralises brackets that would close a node", () => {
    const out = escapeLabel("arr[0] and (x) and {y}");
    expect(out).not.toContain("[");
    expect(out).not.toContain("]");
  });

  it("flattens newlines so one node stays one line", () => {
    const out = escapeLabel("line1\nline2\r\nline3");
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\r");
  });

  it("survives a deliberate node-injection attempt", () => {
    // A summary crafted to break out and declare its own node/edge.
    const out = escapeLabel('x"] --> EVIL["pwned');
    expect(out).not.toContain('"');
    expect(out).not.toContain("]");
    expect(out).not.toContain("[");
    expect(out).not.toContain("-->");
  });

  it("leaves ordinary prose alone", () => {
    expect(escapeLabel("fix the parser")).toBe("fix the parser");
  });
});

// ============================================================================
// truncateSummary
// ============================================================================

describe("truncateSummary", () => {
  it("leaves short text unchanged", () => {
    expect(truncateSummary("short", 20)).toBe("short");
  });

  it("truncates and marks elision within the budget", () => {
    const out = truncateSummary("x".repeat(50), 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith("…")).toBe(true);
  });

  it("counts by code point, not UTF-16 unit", () => {
    // Astral chars are 2 UTF-16 units each; a naive slice would cut one in half
    // and emit a lone surrogate.
    const out = truncateSummary("👍".repeat(10), 5);
    expect([...out].length).toBeLessThanOrEqual(5);
    expect(out).not.toMatch(/[\uD800-\uDFFF]$/);
  });

  it("handles a budget too small for the ellipsis", () => {
    expect(truncateSummary("abcdef", 1).length).toBeLessThanOrEqual(1);
  });
});

// ============================================================================
// allocateNodeId
// ============================================================================

describe("allocateNodeId", () => {
  it("starts at N1 on an empty canvas", () => {
    expect(allocateNodeId(canvas({ nodes: [] }))).toBe("000-N1");
  });

  it("continues past the highest existing number", () => {
    const c = canvas({
      nodes: [node({ id: "000-N1" }), node({ id: "000-N2" })],
    });
    expect(allocateNodeId(c)).toBe("000-N3");
  });

  it("does not reuse an id after a gap", () => {
    // Reusing N2 would silently repoint any ref that still cites it.
    const c = canvas({
      nodes: [node({ id: "000-N1" }), node({ id: "000-N3" })],
    });
    expect(allocateNodeId(c)).toBe("000-N4");
  });

  it("respects the canvas prefix", () => {
    expect(allocateNodeId(canvas({ prefix: "007", nodes: [] }))).toBe("007-N1");
  });

  it("ignores ids belonging to another prefix", () => {
    const c = canvas({ prefix: "001", nodes: [node({ id: "999-N9" })] });
    expect(allocateNodeId(c)).toBe("001-N1");
  });
});

// ============================================================================
// render → parse round trip
// ============================================================================

describe("renderCanvas / parseCanvas round trip", () => {
  it("preserves a single-node canvas", () => {
    const c = canvas();
    expect(parseCanvas(renderCanvas(c))).toEqual(c);
  });

  it("preserves every status and a null ref", () => {
    const c = canvas({
      nodes: [
        node({
          id: "000-N1",
          status: "done",
          summary: "a",
          ref: "mem:abc-123",
        }),
        node({
          id: "000-N2",
          status: "doing",
          summary: "b",
          ref: "file:G:/x/y.json",
        }),
        node({ id: "000-N3", status: "todo", summary: "c", ref: null }),
        node({
          id: "000-N4",
          status: "blocked",
          summary: "d",
          ref: "note:waiting on api",
        }),
      ],
    });
    expect(parseCanvas(renderCanvas(c))).toEqual(c);
  });

  it("preserves a goal containing quotes and braces", () => {
    // The goal rides in the %%{...}%% JSON header, so it must survive JSON
    // escaping independently of the label escaping used for nodes.
    const c = canvas({ taskGoal: 'fix {"a":"b"} parsing' });
    expect(parseCanvas(renderCanvas(c))).toEqual(c);
  });

  it("does not lose a windows path ref to backslash escaping", () => {
    const c = canvas({
      nodes: [node({ ref: "file:C:\\Users\\x\\tool-results\\a.json" })],
    });
    expect(parseCanvas(renderCanvas(c))).toEqual(c);
  });

  it("round trips a quote inside a ref", () => {
    // The quote must leave the label (it would close the Mermaid `["..."]`), but
    // it has to come back. Escaping it twice writes `\\u0022`, which parses as a
    // literal backslash plus `u0022` — the ref then reads back visibly mangled.
    const c = canvas({
      nodes: [node({ ref: 'note:returned "No canvases yet."' })],
    });
    expect(parseCanvas(renderCanvas(c))).toEqual(c);
  });

  it("keeps a quoted ref out of the rendered label", () => {
    const out = renderCanvas(
      canvas({ nodes: [node({ ref: 'note:say "hi"' })] }),
    );
    const refLine = out.split("\n").find((l) => l.includes("ref:")) ?? "";
    // One `"` on each end of the label, and none in between.
    expect(refLine.match(/"/g)).toHaveLength(2);
    expect(refLine).toContain("\\u0022");
    expect(refLine).not.toContain("\\\\u0022");
  });

  it("round trips a ref mixing quotes and backslashes", () => {
    const c = canvas({
      nodes: [node({ ref: 'note:C:\\a\\b said "ok" then \\' })],
    });
    expect(parseCanvas(renderCanvas(c))).toEqual(c);
  });

  it("round trips a ref containing a literal backslash-u sequence", () => {
    // `\u0022` written out by hand must survive as those six characters rather
    // than being decoded into a quote on the way back.
    const c = canvas({
      nodes: [node({ ref: "note:literal \\u0022 stays put" })],
    });
    expect(parseCanvas(renderCanvas(c))).toEqual(c);
  });

  it("is idempotent across two renders", () => {
    const once = renderCanvas(canvas());
    expect(renderCanvas(parseCanvas(once))).toBe(once);
  });

  it("keeps an empty canvas parseable", () => {
    const c = canvas({ nodes: [] });
    expect(parseCanvas(renderCanvas(c))).toEqual(c);
  });

  it("renders valid mermaid for an empty canvas", () => {
    // `graph LR` with no nodes is still valid; a stray edge arrow would not be.
    const out = renderCanvas(canvas({ nodes: [] }));
    expect(out).toContain("graph LR");
    expect(out).not.toContain("-->");
  });

  it("chains nodes in declaration order", () => {
    const out = renderCanvas(
      canvas({ nodes: [node({ id: "000-N1" }), node({ id: "000-N2" })] }),
    );
    expect(out).toMatch(/000-N1[^\n]*-->[^\n]*000-N2/);
  });

  it("survives a summary that tries to inject mermaid, losing only the syntax", () => {
    const c = canvas({ nodes: [node({ summary: 'x"] --> EVIL["pwned' })] });
    const parsed = parseCanvas(renderCanvas(c));
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0].summary).not.toContain('"]');
  });
});

// ============================================================================
// parseCanvas on hostile / damaged input
// ============================================================================

describe("parseCanvas resilience", () => {
  it("returns an empty canvas for junk rather than throwing", () => {
    const parsed = parseCanvas("this is not a canvas at all");
    expect(parsed.nodes).toEqual([]);
  });

  it("tolerates a corrupt metadata header", () => {
    const parsed = parseCanvas("%%{ not json at all }%%\ngraph LR\n");
    expect(parsed.nodes).toEqual([]);
    expect(parsed.taskGoal).toBe("");
  });

  it("skips malformed node lines but keeps the good ones", () => {
    const text = [
      '%%{"taskGoal":"g","createdTime":null,"updatedTime":null,"prefix":"000"}%%',
      "graph LR",
      '    000-N1["status: todo<br/>summary: kept"]',
      "    garbage line without a node",
      '    000-N2["status: done<br/>summary: also kept"]',
    ].join("\n");
    const parsed = parseCanvas(text);
    expect(parsed.nodes.map((n) => n.id)).toEqual(["000-N1", "000-N2"]);
  });

  it("defaults an unrecognised status to todo", () => {
    const text = [
      '%%{"taskGoal":"g","createdTime":null,"updatedTime":null,"prefix":"000"}%%',
      "graph LR",
      '    000-N1["status: bogus<br/>summary: s"]',
    ].join("\n");
    expect(parseCanvas(text).nodes[0].status).toBe("todo");
  });

  it("does not treat a node id inside a summary as a new node", () => {
    const text = [
      '%%{"taskGoal":"g","createdTime":null,"updatedTime":null,"prefix":"000"}%%',
      "graph LR",
      '    000-N1["status: todo<br/>summary: see 000-N9 for detail"]',
    ].join("\n");
    expect(parseCanvas(text).nodes.map((n) => n.id)).toEqual(["000-N1"]);
  });

  it("deduplicates a repeated node id, keeping the first", () => {
    const text = [
      '%%{"taskGoal":"g","createdTime":null,"updatedTime":null,"prefix":"000"}%%',
      "graph LR",
      '    000-N1["status: todo<br/>summary: first"]',
      '    000-N1["status: done<br/>summary: second"]',
    ].join("\n");
    const parsed = parseCanvas(text);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0].summary).toBe("first");
  });

  it("recovers the prefix from node ids when the header lacks it", () => {
    const text = [
      '%%{"taskGoal":"g","createdTime":null,"updatedTime":null}%%',
      "graph LR",
      '    042-N1["status: todo<br/>summary: s"]',
    ].join("\n");
    expect(parseCanvas(text).prefix).toBe("042");
  });
});

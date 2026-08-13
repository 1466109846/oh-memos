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
    const c = canvas({ nodes: [node({ id: "000-N1" }), node({ id: "000-N2" })] });
    expect(allocateNodeId(c)).toBe("000-N3");
  });

  it("does not reuse an id after a gap", () => {
    // Reusing N2 would silently repoint any ref that still cites it.
    const c = canvas({ nodes: [node({ id: "000-N1" }), node({ id: "000-N3" })] });
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
        node({ id: "000-N1", status: "done", summary: "a", ref: "mem:abc-123" }),
        node({ id: "000-N2", status: "doing", summary: "b", ref: "file:G:/x/y.json" }),
        node({ id: "000-N3", status: "todo", summary: "c", ref: null }),
        node({ id: "000-N4", status: "blocked", summary: "d", ref: "note:waiting on api" }),
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
    const c = canvas({ nodes: [node({ ref: "file:C:\\Users\\x\\tool-results\\a.json" })] });
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
      canvas({ nodes: [node({ id: "000-N1" }), node({ id: "000-N2" })] })
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
    const parsed = parseCanvas('%%{ not json at all }%%\ngraph LR\n');
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


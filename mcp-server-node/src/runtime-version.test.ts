import { describe, expect, it } from "vitest";

import { unsupportedNodeMessage } from "./runtime-version.js";

describe("Node runtime gate", () => {
  it("rejects Node 18 with an actionable upgrade message", () => {
    expect(unsupportedNodeMessage("18.20.8")).toBe(
      "oh-memos-mcp requires Node.js >=20.0.0; detected 18.20.8. Upgrade Node.js and retry."
    );
  });

  it("accepts supported Node releases", () => {
    expect(unsupportedNodeMessage("20.0.0")).toBeNull();
    expect(unsupportedNodeMessage("22.14.0")).toBeNull();
    expect(unsupportedNodeMessage("24.12.0")).toBeNull();
  });

  it("rejects an unparseable version instead of silently continuing", () => {
    expect(unsupportedNodeMessage("unknown")).toContain("detected unknown");
  });
});

import { describe, expect, it } from "vitest";
import { parseMemoryMode, shouldAutoCapture } from "./policy.js";

describe("runtime memory policy", () => {
  it("defaults to full mode and disabled capture", () => {
    expect(parseMemoryMode({})).toEqual({ mode: "full", autoCapture: false });
  });
  it("enables capture explicitly", () => {
    expect(parseMemoryMode({ MEMOS_AUTO_CAPTURE: "true" })).toEqual({ mode: "full", autoCapture: true });
    expect(shouldAutoCapture({ MEMOS_AUTO_CAPTURE: "true" })).toBe(true);
  });
  it("keeps lite capture disabled unless explicitly enabled", () => {
    expect(parseMemoryMode({ MEMOS_MODE: "lite", MEMOS_AUTO_CAPTURE: "true" })).toEqual({ mode: "lite", autoCapture: false });
    expect(shouldAutoCapture({ MEMOS_MODE: "lite", MEMOS_AUTO_CAPTURE: "true" })).toBe(false);
  });
  it("rejects unknown modes", () => {
    expect(parseMemoryMode({ MEMOS_MODE: "weird" }).mode).toBe("full");
  });
});

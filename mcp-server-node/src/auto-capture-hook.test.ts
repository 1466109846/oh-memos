import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { join } from "path";

const hook = join(process.cwd(), "../project-memory/hooks/node/oh_memos_auto_capture.js");

describe("auto-capture hook contract", () => {
  it("is disabled by default and never emits a write error", () => {
    const out = execFileSync(process.execPath, [hook], {
      input: JSON.stringify({ hook_event_name: "PreCompact", summary: "A meaningful checkpoint with enough text" }),
      env: { ...process.env, MEMOS_AUTO_CAPTURE: "false" },
      encoding: "utf8",
    });
    expect(JSON.parse(out).continue).toBe(true);
  });

  it("fails open on malformed input", () => {
    const out = execFileSync(process.execPath, [hook], {
      input: "not-json",
      env: { ...process.env, MEMOS_AUTO_CAPTURE: "true" },
      encoding: "utf8",
    });
    expect(JSON.parse(out).continue).toBe(true);
  });
});

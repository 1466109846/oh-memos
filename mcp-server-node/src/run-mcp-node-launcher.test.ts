import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const launcher = readFileSync(
  resolve(process.cwd(), "run_mcp_node.sh"),
  "utf8",
);

describe("WSL MCP launcher contract", () => {
  it("probes host candidates and reports a failed endpoint discovery", () => {
    expect(launcher).toContain("host.docker.internal");
    expect(launcher).toContain("/etc/resolv.conf");
    expect(launcher).toMatch(/API health check failed/i);
  });

  it("uses an available Node binary instead of a machine-specific path", () => {
    expect(launcher).toContain("MEMOS_NODE_BIN");
    expect(launcher).toMatch(/command -v node/);
  });

  it("forwards the selected endpoint as a CLI override", () => {
    expect(launcher).toContain("--memos-url");
    expect(launcher).toMatch(/CAN_DISCOVER.*=.*1/);
    expect(launcher).toMatch(/HAS_ENV_FILE/);
    expect(launcher).toContain("--noproxy '*'");
    expect(launcher).toContain("process.versions.node");
  });

  it("keeps explicit URL sources and custom endpoint details authoritative", () => {
    expect(launcher).toContain("--memos-env-file");
    expect(launcher).toContain("is_loopback_url");
    expect(launcher).toContain("MEMOS_BASE_URL");
    expect(launcher).toMatch(/if \[ \"\$HAS_URL_ARG\" -eq 1 \]/);
    expect(launcher).toContain("Preserve scheme, port, path, and query");
    expect(launcher).toContain("add_loopback_alias");
  });

  it("validates the MemOS health payload before selecting a candidate", () => {
    expect(launcher).toContain("value?.code === 200");
    expect(launcher).toContain("value?.data?.overall_status");
    expect(launcher).toContain('status === "degraded"');
    expect(launcher).toContain('status === "down"');
    expect(launcher).toContain("health_url_for");
    expect(launcher).toContain("HEALTHY_URL");
  });
});

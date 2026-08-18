/**
 * MemOS MCP Server — McpServer setup + background init
 */
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { MEMOS_DEFAULT_CUBE, MEMOS_ENABLE_DELETE, MEMOS_PROVIDER, logger } from "./config.js";
import { waitForApiReady } from "./api-client.js";
import { ensureCubeRegistered } from "./cube-manager.js";
import { toolSchemas, toolAnnotations } from "./tools-registry.js";
import { dispatchTool, handleApiUnreachable } from "./handlers/index.js";
import { recordRawArgKeys } from "./handlers/arg-contract.js";
import type { TextContent } from "./types.js";

// ============================================================================
// Register All Tools
// ============================================================================

function registerTools(server: McpServer): void {
  for (const [name, schema] of Object.entries(toolSchemas)) {
    // Skip delete tool if not enabled
    if (name === "memos_delete" && !MEMOS_ENABLE_DELETE) {
      logger.debug("Delete tool skipped (MEMOS_ENABLE_DELETE=false)");
      continue;
    }

    server.registerTool(
      name,
      {
        description: schema.description,
        inputSchema: schema.inputSchema,
        // Lets a client tell retrieval from mutation without parsing prose.
        // The practical win is plan mode: without readOnlyHint every
        // `memos_search` raises a permission prompt, and CLAUDE.md asks for a
        // search before coding — so the friction was quietly training the
        // rule away.
        annotations: toolAnnotations[name],
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await dispatchTool(name, args);
          return {
            content: result.map((r: TextContent) => ({ type: "text" as const, text: r.text })),
          };
        } catch (err: unknown) {
          const errStr = String(err);
          if (errStr.includes("ECONNREFUSED") || errStr.includes("fetch failed")) {
            const unreachable = await handleApiUnreachable();
            return {
              content: unreachable.map((r) => ({ type: "text" as const, text: r.text })),
            };
          }
          logger.exception("Tool call failed", err);
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `❌ [UNEXPECTED_ERROR] ${errStr}`,
                  "",
                  "💡 Suggestions:",
                  "- Check MCP server logs for details",
                  "- Verify MemOS API is healthy: `curl http://localhost:18000/health/detail`",
                ].join("\n"),
              },
            ],
          };
        }
      }
    );
  }

  if (MEMOS_ENABLE_DELETE) {
    logger.debug("Delete tool enabled (MEMOS_ENABLE_DELETE=true)");
  }
}

// ============================================================================
// Background Init
// ============================================================================

async function backgroundInit(): Promise<void> {
  if (MEMOS_PROVIDER === "local") {
    logger.info("Local memory provider enabled; skipping API readiness and cube registration");
    return;
  }
  try {
    const apiReady = await waitForApiReady();

    if (apiReady) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const [regSuccess, regError] = await ensureCubeRegistered(MEMOS_DEFAULT_CUBE, true);
          if (regSuccess) {
            logger.debug(`Default cube '${MEMOS_DEFAULT_CUBE}' ready`);
            return;
          }
          logger.warning(`Cube registration attempt ${attempt + 1} failed: ${regError}`);
          await sleep(2000);
        } catch (err) {
          logger.warning(`Registration attempt ${attempt + 1} error: ${err}`);
          await sleep(2000);
        }
      }
    } else {
      logger.warning("API not ready, will register cube on first tool call");
    }
  } catch (err) {
    logger.warning(`Background init failed: ${err}`);
  }
}

// ============================================================================
// Run Server
// ============================================================================

/**
 * Some MCP clients JSON-encode `params.arguments` instead of sending an object,
 * which the SDK rejects during validation ("expected record, received string")
 * before any tool handler runs. Normalize those requests at the transport
 * boundary so a client quirk doesn't make every tool call fail.
 *
 * This is also the last point where the arguments are still intact: zod strips
 * undeclared keys immediately after, without a trace. So the keys are recorded
 * here (by request id) for `checkArgContract` to report on later.
 */
function tolerateStringArguments(transport: StdioServerTransport): void {
  const downstream = transport.onmessage?.bind(transport);
  if (!downstream) return;
  transport.onmessage = (msg: unknown): void => {
    try {
      const m = msg as { id?: unknown; method?: string; params?: { arguments?: unknown } };
      if (m?.method === "tools/call") {
        if (typeof m.params?.arguments === "string") {
          const raw = m.params.arguments.trim();
          m.params.arguments = raw ? JSON.parse(raw) : {};
          logger.warning("Client sent tools/call arguments as a JSON string; parsed it into an object");
        }
        recordRawArgKeys(m.id, m.params?.arguments);
      }
    } catch (err) {
      logger.warning(`Could not normalize string tools/call arguments: ${err}`);
    }
    downstream(msg as never);
  };
}

// serverInfo 从 package.json 读取,而非硬编码 —— 硬编码会在每次发版后
// 悄悄漂移(2.0.0 发布时这里仍报 1.0.1)。dist/server.js 的上一级即包根。
const pkg: { name: string; version: string } = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf8",
  ),
);

export async function runServer(): Promise<void> {
  const server = new McpServer({
    name: pkg.name,
    version: pkg.version,
  });

  registerTools(server);

  const transport = new StdioServerTransport();

  // Connect FIRST (completes MCP handshake immediately),
  // then do background init to prevent Claude Code timeout.
  await server.connect(transport);
  // Must run after connect(): the SDK installs its own onmessage there, and we
  // wrap it so malformed-but-recoverable requests are fixed before validation.
  tolerateStringArguments(transport);

  // Background init — don't await
  backgroundInit().catch((err) => {
    logger.error(`Background init error: ${err}`);
  });

  logger.debug("MemOS MCP Server (Node.js) started");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

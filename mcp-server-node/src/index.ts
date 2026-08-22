#!/usr/bin/env node

/**
 * oh-memos-mcp — MCP Server for MemOS Intelligent Memory Management
 *
 * Usage:
 *   npx oh-memos-mcp
 *   node dist/index.js
 *
 * Configuration via environment variables or CLI args.
 * See README.md for full documentation.
 */

import { unsupportedNodeMessage } from "./runtime-version.js";

const runtimeError = unsupportedNodeMessage(process.versions.node);

if (runtimeError) {
  process.stderr.write(`${runtimeError}\n`);
  process.exitCode = 1;
} else {
  void startServer();
}

async function startServer(): Promise<void> {
  try {
    // Keep SDK v2 and config loading behind the Node version gate so an older
    // runtime gets an actionable message instead of an import-time crash.
    const [{ runServer }, { logger }] = await Promise.all([
      import("./server.js"),
      import("./config.js"),
    ]);
    await runServer().catch((err) => {
      logger.error(`Fatal error: ${err}`);
      process.exitCode = 1;
    });
  } catch (err) {
    process.stderr.write(`Fatal error: ${String(err)}\n`);
    process.exitCode = 1;
  }
}

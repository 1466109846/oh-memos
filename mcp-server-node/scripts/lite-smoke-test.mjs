// Standalone Lite-mode smoke test over real MCP stdio.
// No FastAPI, Neo4j, Qdrant, or Ollama is required.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "lite-mcp-smoke-"));
const cube = "lite_smoke_cube";
const child = spawn(process.execPath, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    MEMOS_MODE: "lite",
    MEMOS_PROVIDER: "local",
    MEMOS_USER: "lite-smoke",
    MEMOS_DEFAULT_CUBE: cube,
    MEMOS_CUBES_DIR: root,
    MEMOS_ENV_FILE: join(root, "missing.env"),
    MEMOS_LITE_EMBED: "off",
    MEMOS_URL: "",
    NEO4J_HTTP_URL: "",
  },
});

let stderr = "";
child.stderr.on("data", (data) => { stderr += data.toString(); });

let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    } catch {
      // MCP stdout should be JSON-RPC; leave malformed lines for the timeout/error.
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout on ${method}`));
    }, 10_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function text(response) {
  return response.result?.content?.map((content) => content.text).join("\n")
    ?? JSON.stringify(response.error ?? response);
}

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures += 1;
  }
}

try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "lite-smoke", version: "0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const tools = await rpc("tools/list", {});
  const names = (tools.result?.tools ?? []).map((tool) => tool.name);
  check("MCP server advertises memos_save", names.includes("memos_save"), names.join(","));
  check("MCP server advertises memos_search", names.includes("memos_search"), names.join(","));

  const save = text(await rpc("tools/call", {
    name: "memos_save",
    arguments: { cube_id: cube, content: "Lite mode persists without a backend", memory_type: "DECISION" },
  }));
  check("save succeeds without API", save.includes("Memory saved as [DECISION]"), save.slice(0, 240));

  const search = text(await rpc("tools/call", {
    name: "memos_search",
    arguments: { cube_id: cube, query: "without a backend", top_k: 5 },
  }));
  check("search finds the local memory", search.includes("Lite mode persists without a backend"), search.slice(0, 240));

  const store = join(root, cube, "memories.jsonl");
  check("memory is persisted as JSONL", existsSync(store), store);
  if (existsSync(store)) {
    const record = JSON.parse(readFileSync(store, "utf8").trim());
    check("JSONL record keeps its type", record.metadata?.type === "DECISION", JSON.stringify(record));
  }

  const graph = text(await rpc("tools/call", {
    name: "memos_graph",
    arguments: { cube_id: cube, mode: "related", query: "backend" },
  }));
  check("Full-only graph call explains Lite boundary", graph.includes("Lite mode") && graph.includes("MEMOS_MODE=full"), graph.slice(0, 240));
} catch (error) {
  console.log(`  FAIL harness error — ${error.message}`);
  console.log(`  stderr — ${stderr.slice(0, 800)}`);
  failures += 1;
} finally {
  child.kill();
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall Lite smoke checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

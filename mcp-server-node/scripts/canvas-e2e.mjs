// End-to-end smoke test for memos_canvas over real MCP stdio.
// Exercises the four actions plus the traversal guard, against a temp cubes dir.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "canvas-e2e-"));
const cube = "e2e_probe_cube";
mkdirSync(join(root, cube), { recursive: true });
writeFileSync(join(root, cube, "config.json"), "{}", "utf8");

const child = spawn(process.execPath, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    MEMOS_URL: "http://localhost:18000",
    MEMOS_USER: "dev_user",
    MEMOS_DEFAULT_CUBE: cube,
    MEMOS_CUBES_DIR: root,
    MEMOS_ENV_FILE: join(root, "nonexistent.env"),
  },
});

let stderr = "";
child.stderr.on("data", (d) => { stderr += d.toString(); });

let buf = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    } catch { /* not a JSON-RPC line */ }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 25000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const text = (r) => r.result?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(r.error ?? r);

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); failures++; }
}

try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "canvas-e2e", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = await rpc("tools/list", {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  check("memos_canvas is advertised", names.includes("memos_canvas"), names.join(","));

  const canvasTool = (tools.result?.tools ?? []).find((t) => t.name === "memos_canvas");
  check("declared as a write tool", canvasTool?.annotations?.readOnlyHint === false,
    JSON.stringify(canvasTool?.annotations));

  const call = (args) => rpc("tools/call", { name: "memos_canvas", arguments: args });

  const empty = text(await call({ action: "list", cube_id: cube }));
  check("list is empty initially", empty.includes("No canvases yet"), empty.slice(0, 120));

  const opened = text(await call({ action: "open", goal: "wire up the canvas", cube_id: cube }));
  check("open creates 000-wire-up-the-canvas", opened.includes("000-wire-up-the-canvas"), opened.slice(0, 200));

  const name = "000-wire-up-the-canvas";
  const n1 = text(await call({ action: "update", name, cube_id: cube, summary: "read the source", status: "done", ref: "note:done already" }));
  check("first append gets 000-N1", n1.includes("000-N1"), n1.slice(0, 160));

  const n2 = text(await call({ action: "update", name, cube_id: cube, summary: "write the tests", status: "doing" }));
  check("second append gets 000-N2", n2.includes("000-N2"), n2.slice(0, 160));

  const edited = text(await call({ action: "update", name, cube_id: cube, node_id: "000-N2", status: "done" }));
  check("node_id edits in place, no N3", edited.includes("000-N2") && !edited.includes("000-N3"), edited.slice(0, 200));

  const badRef = text(await call({ action: "update", name, cube_id: cube, summary: "x", ref: "/etc/passwd" }));
  check("schemeless ref rejected", badRef.includes("must start with a scheme"), badRef.slice(0, 160));

  const badStatus = text(await call({ action: "update", name, cube_id: cube, summary: "x", status: "sideways" }));
  check("invalid status rejected", badStatus.toLowerCase().includes("status"), badStatus.slice(0, 160));

  const traversal = text(await call({ action: "show", name: "../../../../etc/passwd", cube_id: cube }));
  check("traversal refused", /bare name|no usable characters|not a path/i.test(traversal), traversal.slice(0, 200));

  const missing = text(await call({ action: "show", name: "000-nope", cube_id: cube }));
  check("missing canvas reported", missing.includes("not found"), missing.slice(0, 160));

  const shown = text(await call({ action: "show", name, cube_id: cube }));
  check("show renders both nodes", shown.includes("000-N1") && shown.includes("000-N2"), shown.slice(0, 240));
  check("show reports 2 done", shown.includes("2 done"), shown.slice(0, 240));

  const listed = text(await call({ action: "list", cube_id: cube }));
  check("list shows the canvas", listed.includes(name), listed.slice(0, 200));

  const onDisk = join(root, cube, "canvas", `${name}.mmd`);
  check("file written to cube canvas dir", existsSync(onDisk), onDisk);
  if (existsSync(onDisk)) {
    const raw = readFileSync(onDisk, "utf8");
    check("file is mermaid with meta header", raw.startsWith("%%{") && raw.includes("graph LR"), raw.slice(0, 90));
    check("ref persisted", raw.includes("note:done already"), raw.slice(0, 300));
  }

  // The action enum is enforced by the SDK's schema validation, so a bad action
  // never reaches the handler. Assert the rejection, not the handler's message.
  const unknown = text(await call({ action: "teleport", cube_id: cube }));
  check("unknown action rejected", /validation|invalid/i.test(unknown), unknown.slice(0, 120));

} catch (err) {
  console.log(`  FAIL harness error — ${err.message}`);
  console.log(`  stderr: ${stderr.slice(0, 600)}`);
  failures++;
} finally {
  child.kill();
}

console.log(failures === 0 ? "\nall canvas e2e checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

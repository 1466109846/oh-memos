// 一跳图扩散的端到端 smoke：驱动真实 MCP server 走 JSON-RPC，
// 打真实 Neo4j（jincaizhaopin_cube，6534 节点 / 9133 条 typed 边）。
//
// 为什么必须有这个：接线在 handler 层，单测触达不到 —— 本会话已两次证明
// 切断 handler 接线时全部单测仍然通过（P1.5 的 W3/W4、9.6 的 list 过滤）。
// 这个 smoke 是扩散接线的唯一守卫。
//
// 需要跑起来的 Neo4j。不可达时明确跳过并以 rc=2 退出，不伪装成通过。
import { spawn } from "node:child_process";

const CUBE = "jincaizhaopin_cube";
const NEO =
  process.env.NEO4J_HTTP_URL || "http://localhost:7474/db/neo4j/tx/commit";
const NEO_USER = process.env.NEO4J_USER || "neo4j";
const NEO_PASS = process.env.NEO4J_PASSWORD || "12345678";

// ---- 前置：Neo4j 可达且该 cube 有边 ----
async function preflight() {
  const auth =
    "Basic " + Buffer.from(`${NEO_USER}:${NEO_PASS}`).toString("base64");
  try {
    const r = await fetch(NEO, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify({
        statements: [
          {
            statement:
              "MATCH (a:Memory)-[r]-(:Memory) WHERE a.user_name=$c AND type(r) IN ['CAUSE','CONDITION','RELATE'] RETURN count(r) AS c",
            parameters: { c: CUBE },
          },
        ],
      }),
    });
    if (!r.ok) return { ok: false, why: `Neo4j HTTP ${r.status}` };
    const j = await r.json();
    if (j.errors?.length)
      return { ok: false, why: `Neo4j ${j.errors[0].code}` };
    const edges = Number(j.results?.[0]?.data?.[0]?.row?.[0] ?? 0);
    if (edges === 0) return { ok: false, why: `cube ${CUBE} 无 typed 边` };
    return { ok: true, edges };
  } catch (err) {
    return { ok: false, why: `Neo4j 不可达: ${err.message}` };
  }
}

const pre = await preflight();
if (!pre.ok) {
  console.log(`SKIP 扩散 smoke —— ${pre.why}`);
  console.log("  这不是通过：接线未被验证。需要跑起来的 Neo4j。");
  process.exit(2);
}
console.log(`前置 ok：${CUBE} 有 ${pre.edges} 条可扩散边\n`);

// ---- MCP server 驱动 ----
function startServer(spreadOn) {
  const child = spawn(process.execPath, ["dist/index.js"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      MEMOS_MODE: "full",
      // 必须显式设 api：`isLocalProvider()` 看的是 MEMOS_PROVIDER，只有它缺失
      // 时才由 MEMOS_MODE 推导。继承外层 `MEMOS_PROVIDER=local` 会让检索走
      // Lite 分支并在 formatMemoriesForDisplay 处提前 return —— 永远到不了
      // 扩散接线（实测：15 条记忆全来自本地 JSONL，stderr 零条扩散日志）。
      MEMOS_PROVIDER: "api",
      // 必须用真实存在的 user：cube 注册按 user 隔离，编一个名字会让
      // 每次检索都返回 CUBE_REGISTRATION_FAILED，而不是记忆。
      // 实测：传 "spread-smoke" 时全部查询返回注册失败提示（372 字符，0 条 ID）。
      MEMOS_USER: process.env.MEMOS_USER || "dev_user",
      MEMOS_DEFAULT_CUBE: CUBE,
      MEMOS_URL: process.env.MEMOS_URL || "http://localhost:18000",
      NEO4J_HTTP_URL: NEO,
      NEO4J_USER: NEO_USER,
      NEO4J_PASSWORD: NEO_PASS,
      MEMOS_SPREAD_ACTIVATION: spreadOn ? "true" : "false",
    },
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let nlIdx;
    while ((nlIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nlIdx).trim();
      buffer = buffer.slice(nlIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const resolve = pending.get(msg.id);
        if (resolve) {
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch {
        /* 非 JSON 行（日志）忽略 */
      }
    }
  });
  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} 超时；stderr=${stderr.slice(0, 400)}`));
      }, 60_000);
      const wrapped = (m) => {
        clearTimeout(timer);
        resolve(m);
      };
      pending.set(id, wrapped);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  return { child, rpc, stderr: () => stderr };
}

async function search(spreadOn, query) {
  const { child, rpc } = startServer(spreadOn);
  try {
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "spread-smoke", version: "0" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const res = await rpc("tools/call", {
      name: "memos_search",
      arguments: { cube_id: CUBE, query, top_k: 8, compact: false },
    });
    const text =
      res.result?.content?.map((c) => c.text).join("\n") ??
      JSON.stringify(res.error ?? res);
    return text;
  } finally {
    child.kill();
  }
}

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures += 1;
  }
}

const QUERY = "admin-web 项目";

// ---- 1) 开关关闭：不应出现扩散标记 ----
const off = await search(false, QUERY);
// 先断言「真的检索到了记忆」，再谈扩散。
// 此前只查 `off.length > 40` —— 而 CUBE_REGISTRATION_FAILED 提示正好 372
// 字符，于是这条恒真，后面基于空数据的断言全部空转（实测 3 条空断言通过）。
const offIdsEarly = [...off.matchAll(/ID: `([^`]+)`/g)].map((m) => m[1]);
check(
  "开关关闭时检索到真实记忆（非错误提示）",
  offIdsEarly.length >= 3,
  `提取到 ${offIdsEarly.length} 条 ID；首 200 字：${off.slice(0, 200)}`,
);
if (offIdsEarly.length < 3) {
  console.log("\n基线检索没拿到记忆 —— 后续断言会空转，中止以免伪装成通过。");
  process.exit(1);
}
check(
  "开关关闭时无扩散标记",
  !/via\s+(CAUSE|CONDITION|RELATE)/.test(off),
  off.slice(0, 200),
);

// ---- 2) 开关打开：应出现扩散标记，且结果更多 ----
const on = await search(true, QUERY);
const viaHits = on.match(/via\s+(CAUSE|CONDITION|RELATE)/g) ?? [];
check(
  "开关打开时出现扩散标记",
  viaHits.length > 0,
  `匹配 ${viaHits.length} 处`,
);
check(
  "扩散只用允许的边类型",
  // 必须先要求非空 —— `[].every()` 恒真，空数据下这条是装饰（实测通过过）。
  viaHits.length > 0 && viaHits.every((h) => /CAUSE|CONDITION|RELATE/.test(h)),
  viaHits.slice(0, 4).join(", ") || "无扩散标记，断言无从成立",
);

const idsOf = (t) => [...t.matchAll(/ID: `([^`]+)`/g)].map((m) => m[1]);
const offIds = idsOf(off);
const onIds = idsOf(on);
check(
  "扩散带回了额外记忆",
  onIds.length > offIds.length,
  `off=${offIds.length} on=${onIds.length}`,
);
check(
  "直接命中仍在结果里（未被扩散挤掉）",
  // 同理要求非空：offIds 为空时 `.every()` 恒真。
  offIds.length >= 3 && offIds.slice(0, 3).every((id) => onIds.includes(id)),
  `off前3=${offIds.slice(0, 3).join(",") || "（空）"}`,
);
check(
  "结果无重复 id",
  new Set(onIds).size === onIds.length,
  `${onIds.length} 条`,
);
// 上下界都要：只查 `<= 12` 时 0 也满足，是空断言（实测通过过）。
check(
  "扩散数量在 1..12 之间",
  viaHits.length >= 1 && viaHits.length <= 12,
  `${viaHits.length} 处`,
);

console.log(
  failures === 0
    ? "\nall spreading-activation smoke checks passed"
    : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);

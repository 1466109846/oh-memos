// 用 MCP host 配置里的**原样 env** 驱动 server，验证扩散在真实部署下确实生效。
//
// 为什么 spread-smoke-test.mjs 不够（这个脚本存在的唯一理由）：
// 那个 smoke 自己显式传 NEO4J_HTTP_URL/USER/PASSWORD，并带硬编码兜底值。于是
// 「host 拿不到 Neo4j 凭据」这个失败形态它**测不出来** —— 凭据由脚本自己供给，
// 与 host 能否读到无关。
//
// 实测踩过：host 配置里没有 NEO4J_PASSWORD，靠 MEMOS_ENV_FILE 间接读 .env。
// 少设 MEMOS_ENV_FILE 时检索正常返回记忆、但扩散标注为 0 —— 静默降级，
// 看起来「功能没开」而非「配置错了」。spread smoke 此时仍然 8/8 通过。
//
// 这个脚本只给 host env（不继承外层 process.env），所以任何「靠默认推导」或
// 「靠 .env 兜住」的变量断了都会暴露：
//   MEMOS_MODE / MEMOS_PROVIDER  → 靠 config.ts 默认推导出 full/api
//   NEO4J_PASSWORD               → 靠 MEMOS_ENV_FILE 读 .env
//   MEMOS_SPREAD_ACTIVATION      → 同上
//
// 用法：
//   node scripts/host-env-smoke.mjs
//   SPREAD_SMOKE_ENTRY=<path> node scripts/host-env-smoke.mjs   # 打 npm 装下来的包
//
// 退出码：0 通过 / 1 失败 / 2 无从验证（找不到 host 配置、cube 无边），不伪装成通过。
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const ENTRY = process.env.SPREAD_SMOKE_ENTRY || "dist/index.js";
const CUBE = process.env.SMOKE_CUBE || "jincaizhaopin_cube";
const QUERY = process.env.SMOKE_QUERY || "admin-web 项目";
const HOST_CFG =
  process.env.SMOKE_HOST_CONFIG ||
  `${process.env.USERPROFILE || process.env.HOME}/.claude.json`;

if (!existsSync(ENTRY)) {
  console.log(`入口不存在：${ENTRY}`);
  console.log("这不是通过：先 npm run build，或设 SPREAD_SMOKE_ENTRY。");
  process.exit(2);
}
if (!existsSync(HOST_CFG)) {
  console.log(`找不到 host 配置：${HOST_CFG}`);
  console.log("这不是通过：无从取得真实部署环境。");
  process.exit(2);
}

// ---- 从 host 配置里取出 oh-memos 的 env，原样使用 ----
let hostEnv = null;
let hostArgs = null;
(function walk(o) {
  if (!o || typeof o !== "object" || hostEnv) return;
  for (const [k, v] of Object.entries(o)) {
    if (k === "oh-memos" && v && v.args) {
      hostEnv = v.env ?? {};
      hostArgs = v.args;
      return;
    }
    walk(v);
  }
})(JSON.parse(readFileSync(HOST_CFG, "utf8")));

if (!hostEnv) {
  console.log(`${HOST_CFG} 里没有 oh-memos 配置 —— 无从验证。`);
  process.exit(2);
}

console.log(`host args : ${hostArgs.join(" ")}`);
console.log(`host env  : ${Object.keys(hostEnv).sort().join(", ")}`);
const implicit = [
  "MEMOS_MODE",
  "MEMOS_PROVIDER",
  "NEO4J_PASSWORD",
  "MEMOS_SPREAD_ACTIVATION",
].filter((k) => !(k in hostEnv));
console.log(`须靠默认或 .env 兜住: ${implicit.join(", ") || "无"}\n`);

// 只给 host env —— 继承外层会让外层残留替 host 兜住缺失项，验证就失去意义。
const child = spawn(process.execPath, [ENTRY], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    USERPROFILE: process.env.USERPROFILE,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    ...hostEnv,
  },
});

let stderr = "";
child.stderr.on("data", (d) => (stderr += d.toString()));

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      /* 非 JSON 行（日志）忽略 */
    }
  }
});

let seq = 0;
function rpc(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
    setTimeout(() => reject(new Error(`timeout on ${method}`)), 120000);
  });
}

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures += 1;
  }
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "host-env-smoke", version: "0" },
  });
  console.log(
    `server    : ${init?.result?.serverInfo?.name} ${init?.result?.serverInfo?.version}\n`,
  );
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );

  const res = await rpc("tools/call", {
    name: "memos_search",
    arguments: { cube_id: CUBE, query: QUERY, top_k: 8, compact: false },
  });
  const text = res?.result?.content?.map((c) => c.text).join("\n") ?? "";
  const ids = [...text.matchAll(/ID: `([^`]+)`/g)].map((m) => m[1]);
  const via = [
    ...text.matchAll(/via\s+(CAUSE|CONDITION|RELATE)\s+from\s+(\w+)/g),
  ];

  // 先立基线：没检索到记忆时后续断言全是空转，直接中止而非报通过。
  check(
    "host 环境下检索到真实记忆（非错误提示）",
    ids.length >= 3,
    `提取到 ${ids.length} 条 ID；首 200 字：${text.slice(0, 200)}`,
  );
  if (ids.length < 3) {
    console.log("\n基线没拿到记忆 —— 中止以免空断言伪装成通过。");
    process.exit(1);
  }

  check(
    "host 未显式设 MEMOS_SPREAD_ACTIVATION，仍从 .env 读到并生效",
    via.length > 0,
    `via 标注 ${via.length} 处；若为 0，检查 MEMOS_ENV_FILE 与 .env 里的 NEO4J_PASSWORD。stderr 尾部：${stderr.slice(-400)}`,
  );
  check(
    "扩散只用允许的边类型",
    via.length > 0 &&
      via.every((m) => ["CAUSE", "CONDITION", "RELATE"].includes(m[1])),
    [...new Set(via.map((m) => m[1]))].join(", "),
  );
  check(
    // 必须先要求非空 —— `0 <= 12` 恒真，零扩散时这条会伪装成通过（实测：抽掉
    // MEMOS_ENV_FILE 后 via=0，本条仍报 ok）。
    "扩散数量在 1..12 之间",
    via.length > 0 && via.length <= 12,
    `${via.length} 条`,
  );
  check(
    "直接命中排在扩散之前",
    (() => {
      const firstId = text.indexOf("ID: `");
      const firstVia = text.indexOf("via ");
      return firstId >= 0 && firstVia > firstId;
    })(),
    `首个 ID 位置 ${text.indexOf("ID: `")}，首个 via 位置 ${text.indexOf("via ")}`,
  );
  check(
    "结果无重复 id",
    new Set(ids).size === ids.length,
    `${ids.length} 条中 ${new Set(ids).size} 个唯一`,
  );

  console.log(
    `\n查询 "${QUERY}" → ${ids.length} 条记忆，其中 ${via.length} 条经扩散带回` +
      `（边类型 ${[...new Set(via.map((m) => m[1]))].sort().join(", ") || "无"}）`,
  );
} catch (e) {
  console.log(`  FAIL 驱动异常 — ${e.message}`);
  console.log(`stderr 尾部：\n${stderr.slice(-600)}`);
  failures += 1;
} finally {
  child.kill();
}

if (failures) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\nall host-env smoke checks passed");

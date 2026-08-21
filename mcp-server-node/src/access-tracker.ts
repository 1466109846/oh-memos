/**
 * 记忆访问追踪 —— 让 memoryQualityScore 的 reinforcement 项真正有数据。
 *
 * ## 为什么是本地 sidecar，而不是回写记忆存储
 *
 * 直接给记忆记录加 access_count 会让检索从只读变成读写：Full 模式需要一个
 * 不存在的后端端点；Lite 模式要在每次检索后重写 memories.jsonl，与既有的
 * withLock 抢锁（多 agent 并发检索同一 cube 就会 `store lock held`）。
 *
 * 这里改成本地 append-only 侧车日志：
 *   - 不碰记忆存储 → Full / Lite 行为一致，无需后端改动
 *   - 只追加、不读改写 → 不与 withLock 交互，并发安全
 *   - fire-and-forget → 追踪失败绝不让业务调用失败
 *
 * 语义上这也更诚实：访问次数是**本机使用度**，不是全局真相。同一条记忆在
 * 另一台机器上的使用情况与本机无关，也不该影响本机排序。
 *
 * ## 为什么只在 memos_get 记账，不在 search 记账
 *
 * 若「出现在检索结果里」就记账，会形成正反馈：高分记忆更常被返回 → 拿到更多
 * 访问计数 → 分数更高 → 更常被返回。富者愈富，且新记忆永远追不上。
 *
 * `memos_get(memory_id=...)` 是**明确的选择性读取** —— agent 从候选里挑了这一条
 * 看全文。它不参与排序输入，因此不构成回路。信号更稀疏但无偏。
 *
 * 设计文档：docs/design/memory-retrieval-optimization.md 第 6.4 节
 */
import * as fs from "fs";
import * as path from "path";

const LOG_FILE = "access-log.jsonl";

/** 超过这个行数就压实成一条快照，把增长界定在「去重记忆数」而非「累计访问数」。 */
const COMPACT_AFTER_LINES = 500;

/** 缓存有效期。同一次会话里连续检索不必反复读盘。 */
const CACHE_TTL_MS = 5_000;

export interface AccessStat {
  count: number;
  lastAt: string;
}

/** id → 统计。查不到即表示从未被显式读取过。 */
export type AccessStats = ReadonlyMap<string, AccessStat>;

const EMPTY: AccessStats = new Map();

interface CacheEntry {
  stats: AccessStats;
  readAt: number;
  size: number;
  mtimeMs: number;
}

const cache = new Map<string, CacheEntry>();

function logPath(cubesDir: string, cubeId: string): string {
  return path.join(cubesDir, cubeId, LOG_FILE);
}

function merge(
  target: Map<string, AccessStat>,
  id: string,
  at: string,
  count = 1,
): void {
  const prev = target.get(id);
  if (!prev) {
    target.set(id, { count, lastAt: at });
    return;
  }
  target.set(id, {
    count: prev.count + count,
    lastAt: prev.lastAt > at ? prev.lastAt : at,
  });
}

/**
 * 解析一行日志并累加进 target。
 *
 * 两种行格式：
 *   {"t":"<iso>","ids":["a","b"]}                 —— 一次访问事件
 *   {"t":"<iso>","snapshot":{"a":[3,"<iso>"]}}    —— 压实后的快照
 *
 * 无法解析的行**静默跳过**：并发追加理论上可能撕裂一行，跳过坏行让日志自愈，
 * 而抛异常会让一个坏字节永久废掉整份使用度数据。
 */
function applyLine(target: Map<string, AccessStat>, line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const record = parsed as Record<string, unknown>;

  const snapshot = record.snapshot;
  if (snapshot && typeof snapshot === "object") {
    for (const [id, value] of Object.entries(
      snapshot as Record<string, unknown>,
    )) {
      if (!Array.isArray(value)) continue;
      const count = Number(value[0]);
      const at = String(value[1] ?? "");
      if (!id || !Number.isFinite(count) || count <= 0 || !at) continue;
      merge(target, id, at, Math.floor(count));
    }
    return;
  }

  const at = String(record.t ?? "");
  const ids = record.ids;
  if (!at || !Array.isArray(ids)) return;
  for (const raw of ids) {
    const id = String(raw ?? "").trim();
    if (id) merge(target, id, at, 1);
  }
}

function parseLog(raw: string): AccessStats {
  const stats = new Map<string, AccessStat>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) applyLine(stats, trimmed);
  }
  return stats;
}

/**
 * 读取某个 cube 的访问统计。任何失败都返回空 map —— 使用度是软数据，
 * 读不到只意味着「没有强化信号」，绝不该让检索失败。
 */
export function readAccessStats(cubesDir: string, cubeId: string): AccessStats {
  const file = logPath(cubesDir, cubeId);
  const key = file;
  try {
    const stat = fs.statSync(file);
    const hit = cache.get(key);
    // mtime + size 双条件：单看 mtime 在粗粒度时间戳的文件系统上会漏掉同秒内的追加。
    if (
      hit &&
      hit.mtimeMs === stat.mtimeMs &&
      hit.size === stat.size &&
      Date.now() - hit.readAt < CACHE_TTL_MS
    ) {
      return hit.stats;
    }
    const stats = parseLog(fs.readFileSync(file, "utf8"));
    cache.set(key, {
      stats,
      readAt: Date.now(),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
    return stats;
  } catch {
    return EMPTY;
  }
}

/**
 * 把当前统计压实成单行快照。
 *
 * 写临时文件再 rename —— rename 在同一文件系统内是原子的（Windows 亦然，
 * 用 fs.renameSync 覆盖目标）。两个进程同时压实时后者胜出，可能丢掉几条
 * 刚追加的访问；对软数据可接受，换来的是日志大小有界。
 */
function compact(file: string, stats: AccessStats): void {
  const snapshot: Record<string, [number, string]> = {};
  for (const [id, stat] of stats) snapshot[id] = [stat.count, stat.lastAt];
  const line = `${JSON.stringify({ t: new Date().toISOString(), snapshot })}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, line, "utf8");
  fs.renameSync(tmp, file);
}

function countLines(raw: string): number {
  let lines = 0;
  for (const ch of raw) if (ch === "\n") lines += 1;
  return lines;
}

/**
 * 记一次显式读取。**永不抛异常** —— 追踪是尽力而为的旁路，
 * 磁盘满、权限不足、目录不存在都不该影响 memos_get 的返回。
 *
 * 单次 append 的载荷远小于 4 KB，在 POSIX 与 Windows 上都是原子写入，
 * 因此多进程并发追加不需要加锁。
 */
export function recordAccess(
  cubesDir: string,
  cubeId: string,
  ids: readonly string[],
): void {
  // trim 而非裸 filter(Boolean)：全空白的 id 无意义，且带首尾空白的 id
  // 会与 readAccessStats 的查找键不一致，导致记了账却查不到。
  const clean = ids.map((id) => String(id ?? "").trim()).filter(Boolean);
  if (clean.length === 0) return;
  const file = logPath(cubesDir, cubeId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `${JSON.stringify({ t: new Date().toISOString(), ids: clean })}\n`,
      "utf8",
    );
    cache.delete(file);

    const raw = fs.readFileSync(file, "utf8");
    if (countLines(raw) > COMPACT_AFTER_LINES) compact(file, parseLog(raw));
  } catch {
    // 尽力而为：使用度数据的价值不足以让业务调用失败。
  }
}

/** 仅供测试：清掉进程内缓存，让下一次读取真的落盘。 */
export function resetAccessCache(): void {
  cache.clear();
}

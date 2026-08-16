import type { MemoryNode, SearchData } from "./types.js";

export type MemoryMode = "full" | "lite";

export interface QualityOptions {
  mode?: MemoryMode;
  now?: number;
  includeAutoCapture?: boolean;
}

function meta(node: MemoryNode): Record<string, unknown> {
  return (node.metadata ?? {}) as Record<string, unknown>;
}

function tags(node: MemoryNode): string[] {
  const value = node.tags ?? meta(node).tags;
  return Array.isArray(value) ? value.map(String) : [];
}

function isAutoCapture(node: MemoryNode): boolean {
  return tags(node).some((tag) => tag.toLowerCase() === "auto-capture") || meta(node).capture_stage === "auto";
}

function ageDays(node: MemoryNode, now: number): number | null {
  const raw = node.updated_at ?? node.created_at ?? String(meta(node).updated_at ?? meta(node).created_at ?? "");
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : Math.max(0, (now - parsed) / 86_400_000);
}

export function memoryQualityScore(node: MemoryNode, now = Date.now()): number {
  const m = meta(node);
  const semantic = Math.max(0, Math.min(1, Number(m.relativity ?? 0.5)));
  const confidence = m.confidence === undefined ? 0.7 : Math.max(0, Math.min(1, Number(m.confidence)));
  const type = String(m.type ?? "");
  const progressPenalty = type === "PROGRESS" ? 0.82 : 1;
  const autoPenalty = isAutoCapture(node) ? 0.45 : 1;
  const statusPenalty = String(m.status ?? "activated") === "activated" ? 1 : 0.25;
  const age = ageDays(node, now);
  const freshness = age === null ? 1 : Math.max(0.55, 1 - age / 3650);
  const expiresAt = Date.parse(String(m.expires_at ?? ""));
  const expiredPenalty = Number.isNaN(expiresAt) || expiresAt > now ? 1 : 0.2;
  const baseScore = semantic * 0.55 + confidence * 0.2 + freshness * 0.1 + progressPenalty * 0.05 + autoPenalty * 0.05 + statusPenalty * 0.05;
  return baseScore * expiredPenalty;
}

function extract(data: SearchData): MemoryNode[] {
  const out: MemoryNode[] = [];
  for (const bucket of data.text_mem ?? []) {
    const memories = bucket.memories;
    if (Array.isArray(memories)) out.push(...memories as MemoryNode[]);
    else if (memories?.nodes) out.push(...memories.nodes);
  }
  return out;
}

export function applyMemoryQualityPolicy(data: SearchData, options: QualityOptions = {}): SearchData {
  const now = options.now ?? Date.now();
  const includeAuto = options.includeAutoCapture === true;
  const candidates = extract(data).filter((node) => !(options.mode === "lite" && isAutoCapture(node) && !includeAuto));
  const ranked = candidates.map((node) => {
    const score = memoryQualityScore(node, now);
    const m = { ...meta(node) };
    const age = ageDays(node, now);
    const expires = Date.parse(String(m.expires_at ?? ""));
    m.quality_score = Number(score.toFixed(6));
    m.freshness = !Number.isNaN(expires) && expires <= now ? "expired" : age !== null && age > 365 ? "stale" : "fresh";
    return { ...node, metadata: m };
  }).sort((a, b) => Number(b.metadata?.quality_score ?? 0) - Number(a.metadata?.quality_score ?? 0));
  return { text_mem: [{ cube_id: "merged", memories: ranked, _source: "quality_policy" }] };
}

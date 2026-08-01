/**
 * memos_think — evidence pack + gap analysis (no server-side synthesis)
 *
 * Retrieval-only "think": gathers evidence for a question, annotates
 * contradiction/evolution candidates, staleness and coverage gaps, and returns
 * a numbered evidence pack. Synthesis is deliberately left to the CALLER —
 * the calling model is far stronger than anything this local stack runs, so
 * the server packages evidence instead of writing prose. Persisting the
 * synthesized answer back is the caller's move too: memos_save with
 * memory_type="SYNTHESIS", keeping the [n]→memory_id map in the content.
 * (Decision record: docs/plans/2026-08-01-memos-think-wiki-export.md)
 *
 * Contradiction detection here is rule-level on the retrieved set, NOT a read
 * of CONFLICT edges: those edges are only created by the reorganizer pipeline,
 * which is disabled by default, so in practice they rarely exist.
 */

import { MEMOS_URL, MEMOS_USER } from "../config.js";
import { apiCallWithRetry } from "../api-client.js";
import { ensureCubeRegistered } from "../cube-manager.js";
import { extractKeywords, extractMcpType } from "../query-processing.js";
import { levenshteinDistance } from "../keyword-enhancer.js";
import { getTypeIcon } from "../models.js";
import { getTemporalMemories } from "./search.js";
import type { TextContent, MemoryNode, SearchData, GraphEdge } from "../types.js";
import {
  ERR_PARAM_MISSING,
  apiErrorResponse,
  cubeRegistrationError,
  errorResponse,
  getCubeIdFromArgs,
} from "./utils.js";

const SNIPPET_MAX = 700;
const MAX_PAIR_FINDINGS = 8;

interface Evidence {
  n: number;
  id: string;
  type: string;
  key: string;
  text: string;
  tags: string[];
  status: string;
  updatedAt: string;
  ageDays: number | null;
}

// ============================================================================
// Collection
// ============================================================================

function collectNodesAndEdges(data: SearchData): { nodes: MemoryNode[]; edges: GraphEdge[] } {
  const nodes: MemoryNode[] = [];
  const edges: GraphEdge[] = [];
  for (const bucket of data.text_mem ?? []) {
    const memData = bucket.memories;
    if (memData && !Array.isArray(memData)) {
      if (memData.nodes) nodes.push(...memData.nodes);
      if (memData.edges) edges.push(...memData.edges);
    } else if (Array.isArray(memData)) {
      nodes.push(...(memData as MemoryNode[]));
    }
  }
  return { nodes, edges };
}

function ageInDays(iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function toEvidence(node: MemoryNode, n: number): Evidence {
  const meta = node.metadata ?? {};
  const updatedAt = node.updated_at ?? (meta.updated_at as string) ?? node.created_at ?? (meta.created_at as string) ?? "";
  const rawTags = node.tags ?? (meta.tags as string[]) ?? [];
  const rawKey = node.key ?? String((meta as Record<string, unknown>).key ?? "") ?? "";
  return {
    n,
    id: node.id ?? String((meta as Record<string, unknown>).id ?? ""),
    type: extractMcpType(node),
    key: rawKey.replace(/^\[[A-Z_]+\]\s*/, "").slice(0, 80),
    text: (node.memory ?? "").replace(/^\[[A-Z_]+\]\s*/, ""),
    tags: Array.isArray(rawTags) ? rawTags.map(String) : [],
    status: String((meta as Record<string, unknown>).status ?? "activated"),
    updatedAt,
    ageDays: ageInDays(updatedAt),
  };
}

// ============================================================================
// Pairwise analysis (contradiction / evolution candidates)
// ============================================================================

function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/[\s_\-.:,;'"`()[\]{}]/g, "");
}

function keysSimilar(a: string, b: string): boolean {
  const na = normalizeKey(a);
  const nb = normalizeKey(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const minLen = Math.min(na.length, nb.length);
  if (minLen < 6) return false;
  return levenshteinDistance(na, nb) <= Math.max(2, Math.floor(minLen / 5));
}

function tagOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b.map((t) => t.toLowerCase()));
  return a.filter((t) => setB.has(t.toLowerCase())).length;
}

interface PairFinding {
  kind: "evolution" | "same_topic";
  older: Evidence;
  newer: Evidence;
}

function findPairCandidates(evidences: Evidence[], freshDays: number): PairFinding[] {
  const findings: PairFinding[] = [];
  for (let i = 0; i < evidences.length && findings.length < MAX_PAIR_FINDINGS; i++) {
    for (let j = i + 1; j < evidences.length && findings.length < MAX_PAIR_FINDINGS; j++) {
      const a = evidences[i];
      const b = evidences[j];
      const related = tagOverlap(a.tags, b.tags) >= 2 || keysSimilar(a.key, b.key);
      if (!related) continue;
      const [older, newer] = (a.ageDays ?? 0) >= (b.ageDays ?? 0) ? [a, b] : [b, a];
      const gap = Math.abs((a.ageDays ?? 0) - (b.ageDays ?? 0));
      findings.push({ kind: gap > freshDays ? "evolution" : "same_topic", older, newer });
    }
  }
  return findings;
}

// ============================================================================
// Handler
// ============================================================================

export async function handleMemosThink(arguments_: Record<string, unknown>): Promise<TextContent[]> {
  const cubeId = getCubeIdFromArgs(arguments_);
  const query = String(arguments_.query ?? "").trim();
  const topK = Math.min(Math.max(Number(arguments_.top_k ?? 15), 3), 30);
  const freshDays = Math.max(Number(arguments_.fresh_days ?? 30), 1);

  if (!query) {
    return errorResponse("query parameter is required", ERR_PARAM_MISSING, [
      'Example: `memos_think(query="为什么 BM25 默认是关的?", project_path="...")`',
    ]);
  }

  const [regSuccess, regError] = await ensureCubeRegistered(cubeId);
  if (!regSuccess) return cubeRegistrationError(cubeId, regError);

  // Two recall paths in parallel: semantic search + recent temporal slice.
  const [apiResult, temporal] = await Promise.all([
    apiCallWithRetry(
      "POST",
      `${MEMOS_URL}/search`,
      cubeId,
      { body: { user_id: MEMOS_USER, query, install_cube_ids: [cubeId], top_k: topK } },
      ensureCubeRegistered
    ),
    getTemporalMemories(cubeId, 5, 72).catch(() => [] as MemoryNode[]),
  ]);

  if (!apiResult.success) {
    const msg = apiResult.data
      ? String((apiResult.data as Record<string, unknown>).message ?? "Unknown error")
      : `HTTP ${apiResult.status}`;
    return apiErrorResponse("Think (evidence retrieval)", msg);
  }

  const resultData = ((apiResult.data as Record<string, unknown>).data as SearchData) ?? {};
  const { nodes, edges } = collectNodesAndEdges(resultData);

  // Merge + dedup by id (semantic first, temporal fills the tail).
  const seen = new Set<string>();
  const merged: MemoryNode[] = [];
  for (const node of [...nodes, ...temporal]) {
    const id = node.id ?? String(node.metadata?.id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(node);
  }

  const evidences = merged.slice(0, topK + 5).map((node, i) => toEvidence(node, i + 1));
  const byId = new Map(evidences.map((e) => [e.id, e]));

  const lines: string[] = [
    `## 🧠 Think: ${query}`,
    "",
    `**Cube**: \`${cubeId}\` · **证据**: ${evidences.length} 条(语义 + 最近 72h 双路去重)`,
    "",
  ];

  // ---- Evidence ------------------------------------------------------------
  lines.push("### 📚 证据", "");
  if (evidences.length === 0) {
    lines.push("*(检索不到任何相关记忆)*", "");
  }
  for (const e of evidences) {
    const date = e.updatedAt ? e.updatedAt.slice(0, 10) : "无日期";
    const age = e.ageDays !== null ? ` · ${e.ageDays}d` : "";
    const head = e.key ? ` ${e.key}` : "";
    lines.push(`**[${e.n}]** ${getTypeIcon(e.type)} ${e.type}${head} · ${date}${age}`);
    const snippet = e.text.length > SNIPPET_MAX
      ? `${e.text.slice(0, SNIPPET_MAX)}…(截断,完整内容用 memos_get)`
      : e.text;
    lines.push(...snippet.split("\n").map((l) => `> ${l}`));
    lines.push(`> id: \`${e.id}\``, "");
  }

  // ---- Graph relations within the evidence set ------------------------------
  const innerEdges = edges.filter((ed) => ed.source && ed.target && byId.has(ed.source) && byId.has(ed.target));
  if (innerEdges.length > 0) {
    lines.push("### 🔗 证据间的图关系", "");
    for (const ed of innerEdges.slice(0, 10)) {
      const s = byId.get(ed.source!)!;
      const t = byId.get(ed.target!)!;
      lines.push(`- [${s.n}] ──${ed.type ?? "RELATE"}──▶ [${t.n}]`);
    }
    lines.push("");
  }

  // ---- Contradiction / evolution candidates ---------------------------------
  const pairs = findPairCandidates(evidences, freshDays);
  if (pairs.length > 0) {
    lines.push("### ⚖️ 矛盾与演进候选(规则级标注,请合成时人工对照)", "");
    for (const p of pairs) {
      if (p.kind === "evolution") {
        lines.push(`- 🕰️ **演进对**: [${p.older.n}](${p.older.updatedAt.slice(0, 10)}) → [${p.newer.n}](${p.newer.updatedAt.slice(0, 10)}) — 同主题新旧记忆,以新为准,或确认旧条目是否已过时`);
      } else {
        lines.push(`- ⚖️ **同主题**: [${p.older.n}] ↔ [${p.newer.n}] — 内容可能重复或互相矛盾,合成前请对照`);
      }
    }
    lines.push("");
  }

  // ---- Staleness -------------------------------------------------------------
  const stale = evidences.filter(
    (e) => e.status !== "activated" || (e.type === "PROGRESS" && e.ageDays !== null && e.ageDays > freshDays)
  );
  if (stale.length > 0) {
    lines.push("### ⏳ 可能过期", "");
    for (const e of stale) {
      const reason = e.status !== "activated" ? `status=${e.status}` : `PROGRESS 已 ${e.ageDays}d(阈值 ${freshDays}d)`;
      lines.push(`- [${e.n}] ${reason}`);
    }
    lines.push("");
  }

  // ---- Gap analysis -----------------------------------------------------------
  // CJK keywords often arrive as whole clauses ("检索为什么默认是关闭的"), which a
  // literal includes() would always miss. Strip function words, split the
  // clause into content chunks (≥2 chars) and report only the chunks the
  // corpus truly lacks.
  const CJK_FUNCTION_WORDS =
    /为什么|什么时候|什么|怎么样|怎么|怎样|如何|是否|是不是|哪些|哪个|哪里|多少|吗|呢|吧|的|了|着|以及|或者|对于|与|和|或|及|在|把|被|从|向|里|中|要|能|会|可以|没有|不|没|是/g;
  const corpus = evidences.map((e) => `${e.text} ${e.key} ${e.tags.join(" ")}`).join(" ").toLowerCase();
  const missingParts = (kw: string): string[] => {
    const lower = kw.toLowerCase();
    if (corpus.includes(lower)) return [];
    if (!/[一-鿿]/.test(lower)) return [lower];
    const parts = lower
      .replace(CJK_FUNCTION_WORDS, " ")
      .split(/[^一-鿿a-z0-9]+/)
      .filter((p) => p.length >= 2);
    if (parts.length === 0) return []; // only function words — not a real gap
    return parts.filter((p) => !corpus.includes(p));
  };
  const missing = [...new Set(extractKeywords(query).flatMap(missingParts))];
  lines.push("### 🕳️ 缺口 — 记忆库可能没有的信息", "");
  if (evidences.length === 0) {
    lines.push("- 记忆库对这个问题**没有任何覆盖**。回答时请明确说明,不要虚构记忆依据。");
  } else if (missing.length > 0) {
    lines.push(`- 问题关键词未在任何证据中出现: ${missing.map((k) => `\`${k}\``).join(", ")}`);
    lines.push("- 涉及这些方面时,请明确说\"记忆库中没有相关记录\",不要编造。");
  } else {
    lines.push("- 问题关键词均有证据覆盖(不代表证据充分,仅代表词面命中)。");
  }
  lines.push("");

  // ---- Next steps for the caller ---------------------------------------------
  lines.push(
    "---",
    "### ✍️ 下一步(由你完成)",
    "1. 基于以上证据合成回答,句末用 [n] 标注依据;缺口部分如实说明。",
    "2. 若结论有沉淀价值,回灌: `memos_save(memory_type=\"SYNTHESIS\", content=\"<问题>\\n<结论>\\n\\n依据: " +
      evidences.slice(0, 5).map((e) => `[${e.n}]=${e.id.slice(0, 8)}…`).join(" ") +
      "\")` — 内容里保留 [n]→id 映射。"
  );

  return [{ type: "text", text: lines.join("\n") }];
}

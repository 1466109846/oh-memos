/**
 * Local, API-free memory store for MEMOS_PROVIDER=local.
 *
 * One append-only `memories.jsonl` per cube, Node built-ins only: durable
 * append with fsync, a cross-process lock beside the store, and deterministic
 * lexical search. It offers no embeddings, no graph, and no LLM extraction, so
 * capability reporting must stay honest about that.
 */

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { extractKeywords, keywordMatchScore } from "../query-processing.js";
import type { MemoryNode, SearchData } from "../types.js";
import type { MemoryProvider, SaveInput } from "./memory-provider.js";
import { noneEmbedder, type LiteEmbedder } from "./lite-embedding.js";

const STORE_FILE = "memories.jsonl";
const LOCK_SUFFIX = ".lock";
const LOCK_STALE_MS = 5 * 60 * 1000;
export const LOCAL_SCHEMA_VERSION = 1;

/**
 * Hybrid ranking weights when a query embedding is available. Both components
 * are normalized to [0,1] before blending so neither scale dominates the other.
 */
const SEMANTIC_WEIGHT = 0.6;
const LEXICAL_WEIGHT = 0.4;

/** A stored record; `embedding` is private to the store and never leaves it. */
type StoredRecord = MemoryNode & { embedding?: number[] };

function stripEmbedding(record: StoredRecord): MemoryNode {
  const { embedding: _embedding, ...node } = record;
  return node;
}

function cosineSimilarity(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class LocalJsonlProvider implements MemoryProvider {
  constructor(
    private readonly cubesDir: string,
    private readonly embedder: LiteEmbedder = noneEmbedder
  ) {}

  private storePath(cubeId: string): string {
    return path.join(this.cubesDir, cubeId, STORE_FILE);
  }

  private ensureManifest(cubeId: string): void {
    const dir = path.join(this.cubesDir, cubeId);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = path.join(dir, "manifest.json");
    if (!fs.existsSync(manifest)) {
      fs.writeFileSync(manifest, JSON.stringify({ schema_version: LOCAL_SCHEMA_VERSION, provider: "local-lite", cube_id: cubeId }, null, 2), "utf8");
    }
  }

  private readAll(cubeId: string): StoredRecord[] {
    this.ensureManifest(cubeId);
    const file = this.storePath(cubeId);
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n");
    const trailingIncomplete = raw.endsWith("\n") ? "" : lines.pop() ?? "";
    if (trailingIncomplete.trim() && isParsable(trailingIncomplete)) lines.push(trailingIncomplete);
    const records: StoredRecord[] = [];
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as StoredRecord);
      } catch {
        throw new Error(`corrupt record in ${file} at line ${index + 1}; repair or restore the store before writing`);
      }
    }
    return records;
  }

  private withLock<T>(cubeId: string, run: () => T): T {
    const dir = path.join(this.cubesDir, cubeId);
    fs.mkdirSync(dir, { recursive: true });
    const lockPath = `${this.storePath(cubeId)}${LOCK_SUFFIX}`;
    if (fs.existsSync(lockPath)) {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age < LOCK_STALE_MS) throw new Error(`store lock held by another process: ${lockPath}`);
      fs.unlinkSync(lockPath);
    }
    const fd = fs.openSync(lockPath, "wx");
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      return run();
    } finally {
      fs.closeSync(fd);
      try { fs.unlinkSync(lockPath); } catch { /* another owner cleaned it */ }
    }
  }

  async save(input: SaveInput): Promise<MemoryNode> {
    const now = new Date().toISOString();
    const content = input.content.startsWith(`[${input.memoryType}]`)
      ? input.content
      : `[${input.memoryType}] ${input.content}`;
    const node: MemoryNode = {
      id: randomUUID(),
      memory: content,
      key: content.split("\n")[0].slice(0, 80),
      tags: input.tags ?? [input.memoryType],
      created_at: now,
      updated_at: now,
      relations: [],
      metadata: {
        schema_version: LOCAL_SCHEMA_VERSION,
        provider: "local-lite",
        type: input.memoryType,
        status: input.status ?? "activated",
        source: input.source ?? "local-lite",
        tags: input.tags ?? [input.memoryType],
        confidence: input.confidence,
        session_id: input.sessionId,
        source_ref: input.sourceRef,
        created_at: now,
        updated_at: now,
      },
    };
    this.ensureManifest(input.cubeId);
    // Embedding failure never blocks the save — the record simply joins the
    // lexical-only pool until rewritten.
    const embedding = await this.embedder.embed(content);
    const record: StoredRecord = embedding ? { ...node, embedding } : node;
    this.withLock(input.cubeId, () => {
      const file = this.storePath(input.cubeId);
      const fd = fs.openSync(file, "a");
      try {
        fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    });
    return node;
  }

  async get(cubeId: string, memoryId: string): Promise<MemoryNode | null> {
    const record = this.readAll(cubeId).find((node) => node.id === memoryId);
    return record ? stripEmbedding(record) : null;
  }

  async list(cubeId: string, limit: number, memoryType?: string): Promise<MemoryNode[]> {
    const active = this.readAll(cubeId).filter((node) => String(node.metadata?.status ?? "activated") !== "deleted");
    const typed = memoryType ? active.filter((node) => node.metadata?.type === memoryType) : active;
    return sortByUpdated(typed).map(stripEmbedding).slice(0, Math.max(0, limit));
  }

  async search(cubeId: string, query: string, topK: number): Promise<MemoryNode[]> {
    const keywords = extractKeywords(query);
    const candidates = await this.list(cubeId, Number.MAX_SAFE_INTEGER);
    // A null query embedding (no embedder, offline Ollama) keeps the pure
    // lexical ranking below untouched — the zero-config default behavior.
    const queryEmbedding = await this.embedder.embed(query);

    const scored = candidates.map((node) => {
      const haystack = `${node.memory ?? ""} ${node.key ?? ""} ${(node.tags ?? []).join(" ")}`;
      const score = keywords.length === 0 ? 0.1 : keywordMatchScore(haystack, keywords, node.metadata);
      return { node, score };
    });
    const max = Math.max(...scored.map((entry) => entry.score), 1);

    if (!queryEmbedding) {
      return scored
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(0, topK))
        .map(({ node, score }) => ({ ...node, metadata: { ...node.metadata, relativity: Number((score / max).toFixed(6)) } }));
    }

    // Candidates are already stripped of their embeddings; re-read the raw
    // records for the semantic pass so cosine works on stored vectors.
    const storedById = new Map(this.readAll(cubeId).map((record) => [record.id, record.embedding]));
    const blended = scored.map((entry) => {
      const stored = storedById.get(entry.node.id);
      const raw = stored && stored.length === queryEmbedding.length ? cosineSimilarity(stored, queryEmbedding) : null;
      // Clip cosine into [0,1]: unrelated text embeds near-orthogonally, so a
      // raw (cos+1)/2 mapping would give every record a free 0.5 base score.
      const semantic = raw === null ? null : Math.max(0, Math.min(1, raw));
      const lexical = entry.score / max;
      const finalScore = semantic !== null
        ? SEMANTIC_WEIGHT * semantic + LEXICAL_WEIGHT * lexical
        : LEXICAL_WEIGHT * lexical;
      return { node: entry.node, finalScore };
    });
    return blended
      .filter((entry) => entry.finalScore > 0)
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, Math.max(0, topK))
      .map(({ node, finalScore }) => ({ ...node, metadata: { ...node.metadata, relativity: Number(finalScore.toFixed(6)) } }));
  }

  async recent(cubeId: string, sinceHours: number, limit: number): Promise<MemoryNode[]> {
    const cutoff = Date.now() - sinceHours * 3600_000;
    const fresh = (await this.list(cubeId, Number.MAX_SAFE_INTEGER)).filter((node) => {
      const stamp = Date.parse(String(node.updated_at ?? node.created_at ?? ""));
      return !Number.isNaN(stamp) && stamp >= cutoff;
    });
    return sortByUpdated(fresh).slice(0, Math.max(0, limit));
  }

  toSearchData(cubeId: string, nodes: MemoryNode[]): SearchData {
    return { text_mem: [{ cube_id: cubeId, memories: { nodes, edges: [] }, _source: "local-lite" }] };
  }
}

function isParsable(line: string): boolean {
  try { JSON.parse(line); return true; } catch { return false; }
}

function sortByUpdated(nodes: MemoryNode[]): MemoryNode[] {
  return [...nodes].sort((a, b) => Date.parse(String(b.updated_at ?? b.created_at ?? "")) - Date.parse(String(a.updated_at ?? a.created_at ?? "")));
}

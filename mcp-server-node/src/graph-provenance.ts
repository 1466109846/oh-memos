/**
 * Provenance helpers shared by memory-graph responses and the Graphify
 * node-link importer.
 *
 * Graphify calls the categorical edge field `confidence` while oh-memos
 * memory records historically use `confidence`, `source` and `sources` for
 * several different purposes.  This module deliberately normalizes at the
 * boundary instead of changing old Neo4j properties in place.
 */

export const EVIDENCE_KINDS = ["EXTRACTED", "INFERRED", "AMBIGUOUS", "UNKNOWN"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface NormalizedProvenance {
  evidence_kind: EvidenceKind;
  confidence_score?: number;
  evidence_refs: string[];
  source_file?: string;
  source_location?: string;
  source_ref?: string;
  extractor_version?: string;
  last_verified_at?: string;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function firstString(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeKind(value: unknown): EvidenceKind {
  if (typeof value !== "string") return "UNKNOWN";
  const normalized = value.trim().toUpperCase();
  return (EVIDENCE_KINDS as readonly string[]).includes(normalized)
    ? normalized as EvidenceKind
    : "UNKNOWN";
}

function normalizeScore(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "string" && EVIDENCE_KINDS.includes(value.trim().toUpperCase() as EvidenceKind)) {
      continue;
    }
    const score = Number(value);
    if (!Number.isFinite(score)) continue;
    return Math.max(0, Math.min(1, score));
  }
  return undefined;
}

function addRef(refs: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const ref = value.trim();
  if (ref && !refs.includes(ref)) refs.push(ref);
}

function collectRefs(record: UnknownRecord, sourceFile?: string, sourceLocation?: string): string[] {
  const refs: string[] = [];
  const rawRefs = record.evidence_refs ?? record.evidenceRefs ?? record.sources;
  if (Array.isArray(rawRefs)) {
    for (const item of rawRefs) {
      if (typeof item === "string") {
        addRef(refs, item);
      } else {
        const nested = asRecord(item);
        const nestedFile = firstString(nested, ["source_file", "sourceFile", "file", "path"]);
        const nestedLocation = firstString(nested, ["source_location", "sourceLocation", "location", "line"]);
        if (nestedFile && nestedLocation) addRef(refs, `${nestedFile}:${nestedLocation}`);
        else addRef(refs, nestedFile ?? firstString(nested, ["ref", "uri", "source_ref"]));
      }
    }
  }

  addRef(refs, record.source_ref);
  addRef(refs, record.sourceRef);
  // An explicit evidence_refs/source_ref is authoritative.  Only synthesize
  // a file anchor when legacy data has no explicit reference at all; this
  // keeps output compact while retaining useful provenance for old records.
  if (refs.length === 0) {
    if (sourceFile && sourceLocation) addRef(refs, `${sourceFile}:${sourceLocation}`);
    else if (sourceFile) addRef(refs, sourceFile);
  }
  return refs;
}

/** Normalize old memory/Neo4j/Graphify fields without making provenance claims. */
export function normalizeProvenance(value: unknown): NormalizedProvenance {
  const record = asRecord(value);
  const nested = asRecord(record.provenance);
  const merged: UnknownRecord = { ...nested, ...record };

  const sourceFile = firstString(merged, ["source_file", "sourceFile"]);
  const sourceLocation = firstString(merged, ["source_location", "sourceLocation"]);
  const sourceRef = firstString(merged, ["source_ref", "sourceRef"]);
  const kind = normalizeKind(
    merged.evidence_kind
      ?? merged.evidenceKind
      ?? (typeof merged.confidence === "string" ? merged.confidence : undefined)
      ?? merged.kind
      ?? merged.provenance_kind,
  );
  const score = normalizeScore(merged.confidence_score, merged.confidence, merged.weight);

  const result: NormalizedProvenance = {
    evidence_kind: kind,
    evidence_refs: collectRefs(merged, sourceFile, sourceLocation),
  };
  if (score !== undefined) result.confidence_score = score;
  if (sourceFile) result.source_file = sourceFile;
  if (sourceLocation) result.source_location = sourceLocation;
  if (sourceRef) result.source_ref = sourceRef;

  const extractorVersion = firstString(merged, ["extractor_version", "extractorVersion"]);
  const lastVerifiedAt = firstString(merged, ["last_verified_at", "lastVerifiedAt"]);
  if (extractorVersion) result.extractor_version = extractorVersion;
  if (lastVerifiedAt) result.last_verified_at = lastVerifiedAt;
  return result;
}

/** Render a compact, deterministic explanation suitable for MCP Markdown. */
export function formatProvenance(value: unknown): string {
  const provenance = normalizeProvenance(value);
  const parts = [`evidence=${provenance.evidence_kind}`];
  if (provenance.confidence_score !== undefined) {
    parts.push(`confidence=${provenance.confidence_score.toFixed(2)}`);
  }
  const source = provenance.source_file
    ? provenance.source_location
      ? `${provenance.source_file}:${provenance.source_location}`
      : provenance.source_file
    : provenance.source_ref;
  if (source) parts.push(`source=${source}`);
  if (provenance.evidence_refs.length > 0) parts.push(`refs=${provenance.evidence_refs.join(",")}`);
  if (provenance.extractor_version) parts.push(`extractor=${provenance.extractor_version}`);
  if (provenance.last_verified_at) parts.push(`verified=${provenance.last_verified_at}`);
  return parts.join("; ");
}

/**
 * Normalize a project-relative path for a stable code-symbol identity.
 * Absolute paths and traversal segments are rejected before they can enter a
 * graph ID or an import plan.
 */
export function normalizeProjectRelativePath(value: string): string {
  const raw = value.trim().replaceAll("\\", "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw) || raw.startsWith("//")) {
    throw new Error("source path must be project-relative, not absolute");
  }
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error("source path must be project-relative and must not contain traversal segments");
    parts.push(part);
  }
  if (parts.length === 0) throw new Error("source path must be a non-empty project-relative path");
  return parts.join("/");
}

function slug(value: string): string {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
  return normalized
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

/** Stable, portable ID for a code node imported from an external graph. */
export function stableCodeNodeId(
  projectRelativePath: string,
  language: string,
  symbol: string,
  signature?: string,
): string {
  const path = normalizeProjectRelativePath(projectRelativePath);
  const parts = [path, language, symbol];
  if (signature?.trim()) parts.push(signature);
  return `code:${parts.map(slug).join(":")}`;
}

/**
 * Pure Graphify node-link importer boundary.
 *
 * This module intentionally produces a dry-run plan only.  A later adapter
 * may apply the plan to Neo4j, but parsing and safety checks must be testable
 * without a database or a filesystem write.
 */

import {
  normalizeProjectRelativePath,
  normalizeProvenance,
  stableCodeNodeId,
  type NormalizedProvenance,
} from "./graph-provenance.js";

export interface GraphifyNode {
  id: string;
  label?: string;
  file_type?: string;
  language?: string;
  source_file?: string;
  source_location?: string;
  community?: number | string;
  [key: string]: unknown;
}

export interface GraphifyLink {
  source?: string;
  target?: string;
  _src?: string;
  _tgt?: string;
  relation?: string;
  type?: string;
  confidence?: string | number;
  confidence_score?: number;
  source_file?: string;
  source_location?: string;
  weight?: number;
  [key: string]: unknown;
}

export interface GraphImportOptions {
  projectKey?: string;
  maxNodes?: number;
  maxEdges?: number;
}

export interface GraphImportNode {
  external_id: string;
  stable_id: string;
  label: string;
  node_type: "CODE_SYMBOL" | "DOCUMENT" | "CODE_NODE";
  file_type?: string;
  source_file?: string;
  source_location?: string;
  community?: number | string;
  provenance: NormalizedProvenance;
}

export interface GraphImportEdge {
  source_id: string;
  target_id: string;
  relation: string;
  weight?: number;
  provenance: NormalizedProvenance;
}

export interface GraphImportPlan {
  version: "graphify-node-link/v1";
  project_key: string;
  nodes: GraphImportNode[];
  edges: GraphImportEdge[];
  warnings: string[];
  stats: { nodes: number; edges: number; warnings: number };
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function safeCount(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error("import limits must be positive integers");
  return value;
}

function normalizeRelation(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "RELATED_TO";
  return raw.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "RELATED_TO";
}

function languageForNode(node: GraphifyNode, sourceFile?: string): string {
  if (typeof node.language === "string" && node.language.trim()) return node.language.trim();
  const fileType = typeof node.file_type === "string" ? node.file_type.trim() : "";
  if (fileType && fileType.toLowerCase() !== "code") return fileType;
  const extension = sourceFile?.split(".").pop();
  return extension || "code";
}

function nodeTypeFor(node: GraphifyNode): GraphImportNode["node_type"] {
  const fileType = String(node.file_type ?? "code").toLowerCase();
  if (fileType === "document" || fileType === "doc" || fileType === "pdf") return "DOCUMENT";
  if (fileType === "code" || fileType === "source") return "CODE_SYMBOL";
  return "CODE_NODE";
}

/** Validate and convert a Graphify node-link JSON value into a dry-run plan. */
export function buildGraphImportPlan(input: unknown, options: GraphImportOptions = {}): GraphImportPlan {
  const root = asRecord(input);
  if (!Array.isArray(root.nodes) || root.nodes.length === 0) {
    throw new Error("nodes must be a non-empty array");
  }

  const hasLinks = root.links !== undefined;
  const hasEdges = root.edges !== undefined;
  const rawEdges = hasLinks ? root.links : root.edges;
  if (rawEdges !== undefined && !Array.isArray(rawEdges)) {
    throw new Error("links/edges must be an array");
  }
  const links = (rawEdges ?? []) as unknown[];
  const maxNodes = safeCount(options.maxNodes, 50_000);
  const maxEdges = safeCount(options.maxEdges, 100_000);
  if (root.nodes.length > maxNodes) throw new Error(`graph has too many nodes (max ${maxNodes})`);
  if (links.length > maxEdges) throw new Error(`graph has too many edges (max ${maxEdges})`);

  const projectKey = requiredString(options.projectKey ?? "project", "projectKey");
  const warnings: string[] = [];
  if (hasLinks && hasEdges) warnings.push("both links and edges were supplied; links took precedence");

  const seenIds = new Set<string>();
  const nodes: GraphImportNode[] = [];
  const nodeByExternalId = new Map<string, GraphImportNode>();

  for (const rawNode of root.nodes) {
    const node = asRecord(rawNode) as GraphifyNode;
    const externalId = requiredString(node.id, "node id");
    if (seenIds.has(externalId)) throw new Error(`duplicate node id '${externalId}'`);
    seenIds.add(externalId);

    const sourceFile = node.source_file === undefined
      ? undefined
      : normalizeProjectRelativePath(requiredString(node.source_file, `source_file for '${externalId}'`));
    const label = typeof node.label === "string" && node.label.trim() ? node.label.trim() : externalId;
    const stableId = stableCodeNodeId(sourceFile ?? externalId, languageForNode(node, sourceFile), label, externalId);
    const provenance = normalizeProvenance({
      ...node,
      source_file: sourceFile,
      source_location: node.source_location,
    });
    const imported: GraphImportNode = {
      external_id: externalId,
      stable_id: stableId,
      label,
      node_type: nodeTypeFor(node),
      provenance,
    };
    if (typeof node.file_type === "string" && node.file_type.trim()) imported.file_type = node.file_type.trim();
    if (sourceFile) imported.source_file = sourceFile;
    if (typeof node.source_location === "string" && node.source_location.trim()) imported.source_location = node.source_location.trim();
    if (typeof node.community === "number" || typeof node.community === "string") imported.community = node.community;
    nodes.push(imported);
    nodeByExternalId.set(externalId, imported);
  }

  const seenEdges = new Set<string>();
  const edges: GraphImportEdge[] = [];
  for (const rawLink of links) {
    const link = asRecord(rawLink) as GraphifyLink;
    const source = requiredString(link.source ?? link._src, "edge source");
    const target = requiredString(link.target ?? link._tgt, "edge target");
    if (!nodeByExternalId.has(source)) throw new Error(`unknown source node '${source}'`);
    if (!nodeByExternalId.has(target)) throw new Error(`unknown target node '${target}'`);
    const relation = normalizeRelation(link.relation ?? link.type);
    const edgeKey = `${source}\u0000${target}\u0000${relation}`;
    if (seenEdges.has(edgeKey)) throw new Error(`duplicate edge '${source}' -> '${target}' (${relation})`);
    seenEdges.add(edgeKey);

    const provenance = normalizeProvenance(link);
    const edge: GraphImportEdge = {
      source_id: nodeByExternalId.get(source)!.stable_id,
      target_id: nodeByExternalId.get(target)!.stable_id,
      relation,
      provenance,
    };
    const weight = Number(link.weight);
    if (Number.isFinite(weight)) edge.weight = weight;
    edges.push(edge);
  }

  // Stable ordering makes review diffs and future cache keys reproducible.
  nodes.sort((a, b) => a.stable_id.localeCompare(b.stable_id));
  edges.sort((a, b) => `${a.source_id}:${a.relation}:${a.target_id}`.localeCompare(`${b.source_id}:${b.relation}:${b.target_id}`));
  return {
    version: "graphify-node-link/v1",
    project_key: projectKey,
    nodes,
    edges,
    warnings,
    stats: { nodes: nodes.length, edges: edges.length, warnings: warnings.length },
  };
}

function oneLine(value: string, max = 100): string {
  const flattened = value.replace(/[\r\n]+/g, " ").trim();
  return flattened.length > max ? `${flattened.slice(0, max - 1)}…` : flattened;
}

/** Render a human-auditable plan; this function never performs a write. */
export function renderGraphImportPlan(plan: GraphImportPlan): string {
  const lines = [
    "## Graphify Import Plan (dry-run)",
    "",
    `Project: \`${plan.project_key}\``,
    `Version: \`${plan.version}\``,
    `Nodes: **${plan.stats.nodes}** · Edges: **${plan.stats.edges}** · Warnings: **${plan.stats.warnings}**`,
    "",
    "> No Neo4j, Qdrant, or memory-cube data was written.",
    "",
  ];

  if (plan.warnings.length > 0) {
    lines.push("### Warnings", ...plan.warnings.map((warning) => `- ${oneLine(warning)}`), "");
  }
  if (plan.nodes.length > 0) {
    lines.push("### Node preview");
    for (const node of plan.nodes.slice(0, 8)) {
      const location = node.source_file
        ? ` (${node.source_file}${node.source_location ? `:${node.source_location}` : ""})`
        : "";
      lines.push(`- \`${node.stable_id}\` — ${oneLine(node.label)}${location}`);
    }
    if (plan.nodes.length > 8) lines.push(`- … ${plan.nodes.length - 8} more node(s)`);
    lines.push("");
  }
  if (plan.edges.length > 0) {
    lines.push("### Edge preview");
    for (const edge of plan.edges.slice(0, 8)) {
      lines.push(`- \`${edge.relation}\`: \`${edge.source_id}\` → \`${edge.target_id}\` (${formatProvenanceForPlan(edge.provenance)})`);
    }
    if (plan.edges.length > 8) lines.push(`- … ${plan.edges.length - 8} more edge(s)`);
  }
  return lines.join("\n");
}

function formatProvenanceForPlan(provenance: NormalizedProvenance): string {
  const score = provenance.confidence_score === undefined ? "n/a" : provenance.confidence_score.toFixed(2);
  const source = provenance.source_file
    ? `${provenance.source_file}${provenance.source_location ? `:${provenance.source_location}` : ""}`
    : "no source";
  return `${provenance.evidence_kind}, confidence ${score}, ${source}`;
}

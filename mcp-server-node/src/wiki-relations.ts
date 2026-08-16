/**
 * Wiki relation lines — the inverse of wiki-export's `## 关联` renderer.
 *
 * Export writes one line per edge, with the label localized and the direction
 * carried by an arrow plus an optional `被` prefix for inbound edges. Import has
 * to recover both the edge type and its original orientation, because writing an
 * inbound edge as if it were outbound would invert causality in the graph.
 *
 * Kept pure so the mapping can be property-tested against every exported label
 * without touching the filesystem or the API.
 */

import * as path from "path";

/** Single source of truth for the localized edge labels used by export/import. */
export const EDGE_LABELS: Record<string, string> = {
  CAUSE: "导致",
  RELATE: "相关",
  CONDITION: "前提",
  CONFLICT: "冲突",
  FOLLOWS: "后续",
  PARENT: "上级",
};

const LABEL_TO_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(EDGE_LABELS).map(([type, label]) => [label, type])
);

export interface ParsedRelation {
  relationType: string;
  targetFileBase: string;
  /** True when the exported line described an inbound edge (`被… ←`). */
  reverse: boolean;
}

const RELATED_LINE = /^-\s*(被)?\s*([^\s→←]+)\s*(→|←)\s*\[\[([^\]]+)\]\]\s*$/;

export function parseRelatedLine(line: string): ParsedRelation | null {
  const match = RELATED_LINE.exec(line.trim());
  if (!match) return null;
  const [, inboundPrefix, rawLabel, arrow, targetFileBase] = match;
  if (!targetFileBase.trim()) return null;
  return {
    relationType: LABEL_TO_TYPE[rawLabel] ?? "RELATE",
    targetFileBase: targetFileBase.trim(),
    reverse: Boolean(inboundPrefix) || arrow === "←",
  };
}

export interface PageIdentity {
  id: string;
  relPath: string;
}

/**
 * Wikilinks reference a page file name, not a memory id, so resolution needs an
 * index over the pages already parsed in this run. A file base that appears
 * twice is dropped rather than resolved arbitrarily: picking either id would
 * attach the edge to a memory the author did not point at.
 */
export function buildFileBaseIndex(pages: PageIdentity[]): Map<string, string> {
  const seen = new Map<string, string[]>();
  for (const page of pages) {
    const base = path.basename(page.relPath.replace(/\\/g, "/"), ".md");
    seen.set(base, [...(seen.get(base) ?? []), page.id]);
  }
  const index = new Map<string, string>();
  for (const [base, ids] of seen) {
    if (ids.length === 1) index.set(base, ids[0]);
  }
  return index;
}

export interface RelationEdge {
  sourceId: string;
  targetId: string;
  relationType: string;
}

export interface RelationEdgeResult {
  resolved: RelationEdge[];
  unresolved: string[];
  malformed: string[];
  skippedSelf: number;
}

export function relationEdges(
  memoryId: string,
  relatedLines: string[],
  fileBaseIndex: Map<string, string>
): RelationEdgeResult {
  const resolved: RelationEdge[] = [];
  const unresolved: string[] = [];
  const malformed: string[] = [];
  const seen = new Set<string>();
  let skippedSelf = 0;

  for (const line of relatedLines) {
    const parsed = parseRelatedLine(line);
    if (!parsed) {
      malformed.push(line);
      continue;
    }
    const otherId = fileBaseIndex.get(parsed.targetFileBase);
    if (!otherId) {
      unresolved.push(parsed.targetFileBase);
      continue;
    }
    if (otherId === memoryId) {
      skippedSelf += 1;
      continue;
    }
    const edge: RelationEdge = parsed.reverse
      ? { sourceId: otherId, targetId: memoryId, relationType: parsed.relationType }
      : { sourceId: memoryId, targetId: otherId, relationType: parsed.relationType };
    const key = `${edge.sourceId}|${edge.targetId}|${edge.relationType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push(edge);
  }

  return { resolved, unresolved, malformed, skippedSelf };
}

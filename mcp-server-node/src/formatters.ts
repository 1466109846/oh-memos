/**
 * MemOS MCP Server Formatters
 *
 * Formats memory search results and knowledge graphs for display.
 */

import type { SearchData, MemoryNode, GraphEdge } from "./types.js";

// ============================================================================
// Memory Display Formatter
// ============================================================================

/**
 * 附在 ID 行后的检索期注解。
 *
 * 为什么需要这个：quality policy 会往 metadata 写 `access_count`、`freshness`、
 * `duplicates_folded`，但显示层原本只输出 cube / type / 首行 / ID —— 这些字段
 * **算出来就被丢掉了**。后果分两类：
 *
 *   1. `duplicates_folded` 拿不到 → 设计文档声称「折叠后信息不丢，可用 memos_get
 *      展开」，实际上 agent 根本看不到被折叠的 id。这是我自己引入的缺陷。
 *   2. `freshness` 的 stale / expired 判定是可行动信号（该复核这条记忆了），
 *      不显示等于白算。
 *
 * 抽成纯函数是为了可单测 —— formatMemoriesForDisplay 的分支被 handler 层包着，
 * 上一轮 P1.5 的教训是改这个文件的东西会整体逃出单测。
 *
 * 输出刻意吝啬：只在字段真有内容时才占字符，全新且未被读过的记忆无任何附加。
 */
export function memoryAnnotations(metadata: unknown): string {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  const parts: string[] = [];

  const used = Number(meta.access_count);
  if (Number.isFinite(used) && used > 0)
    parts.push(`access_count ${Math.floor(used)}`);

  // fresh 是常态，不值得占字符；stale / expired 才是要 agent 注意的。
  const freshness = String(meta.freshness ?? "");
  if (freshness === "stale" || freshness === "expired") parts.push(freshness);

  const folded = meta.duplicates_folded;
  if (Array.isArray(folded) && folded.length > 0) {
    parts.push(`folded ${folded.length}: ${folded.map(String).join(", ")}`);
  }

  // 扩散来源。P4 的可解释性要求：agent 必须看得出哪条是直接命中、哪条是
  // 沿边联想带回的，以及经由什么边类型。不显示等于白算 —— 与本文件开头
  // 记的 duplicates_folded 是同一类缺陷（算出来没人读）。
  const via = String(meta.spread_via ?? "");
  if (via !== "") {
    const from = String(meta.spread_from ?? "");
    parts.push(
      from === "" ? `via ${via}` : `via ${via} from ${from.slice(0, 8)}`,
    );
  }

  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

export function formatMemoriesForDisplay(data: SearchData): string {
  const results: string[] = [];

  const textMems = data.text_mem ?? [];
  for (const cubeData of textMems) {
    const cubeId = cubeData.cube_id ?? "unknown";
    const memoriesData = cubeData.memories;

    let memories: MemoryNode[] = [];
    if (memoriesData && !Array.isArray(memoriesData) && memoriesData.nodes) {
      memories = memoriesData.nodes;
    } else if (Array.isArray(memoriesData)) {
      memories = memoriesData as MemoryNode[];
    }

    if (memories.length === 0) continue;

    results.push(`## 📦 Cube: ${cubeId}`);
    results.push("");

    // Group by type
    const grouped: Record<string, MemoryNode[]> = {};
    for (const mem of memories) {
      const memText = mem.memory ?? "";
      const typeMatch = memText.match(/^\[([A-Z_]+)\]/);
      const memType = typeMatch ? typeMatch[1] : "PROGRESS";
      if (!grouped[memType]) grouped[memType] = [];
      grouped[memType].push(mem);
    }

    // Display by type
    for (const [memType, items] of Object.entries(grouped)) {
      results.push(`### 🏷️ Type: ${memType}`);
      results.push("");

      for (let i = 0; i < items.length; i++) {
        const mem = items[i];
        const memText = mem.memory ?? "";
        const memId = mem.id ?? "";

        // Remove [TYPE] prefix
        const displayText = memText.replace(/^\[[A-Z_]+\]\s*/, "");
        const firstLine = displayText.split("\n")[0].slice(0, 100);

        if (displayText.split("\n").length > 1 || displayText.length > 100) {
          results.push(`#### ${i + 1}. ${firstLine}`);
        } else {
          results.push(`#### ${i + 1}. ${displayText}`);
        }

        results.push(`ID: \`${memId}\`${memoryAnnotations(mem.metadata)}`);
        results.push("");

        // Detect code blocks
        const hasCodeIndicator = displayText
          .split("\n")
          .some((line) =>
            /^(import |def |class |export |const |let |var )/.test(line.trim()),
          );
        if (!displayText.includes("```") && hasCodeIndicator) {
          results.push("```python");
          results.push(displayText);
          results.push("```");
        } else {
          results.push(displayText);
        }

        results.push("");
        results.push("---");
        results.push("");
      }
    }
  }

  if (results.length === 0) {
    return "No memories found matching your query.";
  }

  return results.join("\n");
}

// ============================================================================
// Graph Display Formatter
// ============================================================================

export interface GraphCubeData {
  cube_id?: string;
  memories?: Array<{
    nodes?: MemoryNode[];
    edges?: GraphEdge[];
  }>;
}

export function formatGraphForDisplay(data: GraphCubeData[]): string {
  const results: string[] = [];

  for (const cubeData of data) {
    const cubeId = cubeData.cube_id ?? "unknown";
    const memoriesList = cubeData.memories ?? [];

    if (memoriesList.length === 0) continue;

    results.push(`## 🧠 Knowledge Graph: ${cubeId}`);
    results.push("");

    for (const memData of memoriesList) {
      const nodes = memData.nodes ?? [];
      const edges = memData.edges ?? [];

      // Build node lookup
      const nodeLookup: Record<string, string> = {};
      for (const node of nodes) {
        const nodeId = node.id ?? "";
        const nodeMemory = node.memory ?? "";
        const cleanText = nodeMemory
          .replace(/\n/g, " ")
          .replace(/"/g, "'")
          .replace(/\[/g, "(")
          .replace(/\]/g, ")");
        nodeLookup[nodeId] =
          cleanText.length > 50 ? cleanText.slice(0, 50) + "..." : cleanText;
      }

      // Display nodes
      if (nodes.length > 0) {
        results.push("### 📝 Memory Nodes");
        results.push("");
        for (let i = 0; i < Math.min(nodes.length, 10); i++) {
          const node = nodes[i];
          const memory = node.memory ?? "";
          const firstLine = memory.split("\n")[0].slice(0, 100);
          const nodeId = node.id ?? "";
          results.push(`${i + 1}. **${firstLine}**`);
          results.push(`   ID: \`${nodeId}\``);
          results.push("");
        }
      }

      // Display relationships with Mermaid
      if (edges.length > 0) {
        results.push("### 📊 Relationship Diagram (Mermaid)");
        results.push("");
        results.push("```mermaid");
        results.push("graph TD");
        results.push(
          "    classDef cause fill:#f96,stroke:#333,stroke-width:2px;",
        );
        results.push(
          "    classDef relate fill:#bbf,stroke:#333,stroke-width:1px;",
        );
        results.push(
          "    classDef conflict fill:#f66,stroke:#333,stroke-width:2px,stroke-dasharray: 5 5;",
        );

        const addedEdges = new Set<string>();
        for (const edge of edges) {
          const sourceId = edge.source ?? "";
          const targetId = edge.target ?? "";
          const relType = edge.type ?? "UNKNOWN";

          if (relType === "PARENT") continue;

          const edgeKey = `${sourceId}-${targetId}-${relType}`;
          if (addedEdges.has(edgeKey)) continue;
          addedEdges.add(edgeKey);

          const sourceText = nodeLookup[sourceId] ?? sourceId.slice(0, 8);
          const targetText = nodeLookup[targetId] ?? targetId.slice(0, 8);
          const sId = `node_${sourceId.slice(0, 8)}`;
          const tId = `node_${targetId.slice(0, 8)}`;

          if (relType === "CAUSE") {
            results.push(
              `    ${sId}["${sourceText}"] -- CAUSE --> ${tId}["${targetText}"]:::cause`,
            );
          } else if (relType === "RELATE") {
            results.push(
              `    ${sId}["${sourceText}"] -. RELATE .- ${tId}["${targetText}"]:::relate`,
            );
          } else if (relType === "CONFLICT") {
            results.push(
              `    ${sId}["${sourceText}"] == CONFLICT == ${tId}["${targetText}"]:::conflict`,
            );
          } else if (relType === "CONDITION") {
            results.push(
              `    ${sId}["${sourceText}"] -- CONDITION --> ${tId}["${targetText}"]`,
            );
          } else {
            results.push(
              `    ${sId}["${sourceText}"] -- ${relType} --> ${tId}["${targetText}"]`,
            );
          }
        }

        results.push("```");
        results.push("");

        // Textual fallback
        results.push("### 🔗 Textual Relationships");
        results.push("");
        results.push("```");
        for (const edge of edges) {
          if (edge.type === "PARENT") continue;
          const sText = (nodeLookup[edge.source ?? ""] ?? "???").slice(0, 40);
          const tText = (nodeLookup[edge.target ?? ""] ?? "???").slice(0, 40);
          results.push(`[${sText}] --${edge.type}--> [${tText}]`);
        }
        results.push("```");
        results.push("");
      }
    }

    results.push("---");
  }

  if (results.length === 0) {
    return "No memories or relationships found.";
  }

  return results.join("\n");
}

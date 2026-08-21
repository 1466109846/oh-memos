/**
 * Graph Handlers
 *
 * memos_graph(mode="path"), memos_graph(mode="related"), memos_graph(mode="schema"), memos_graph(mode="impact")
 */

import {
  MEMOS_URL,
  MEMOS_USER,
  NEO4J_HTTP_URL,
  NEO4J_USER,
  NEO4J_PASSWORD,
  logger,
  registeredCubes,
} from "../config.js";
import { fetchWithTimeout } from "../api-client.js";
import { ensureCubeRegistered } from "../cube-manager.js";
import { formatProvenance } from "../graph-provenance.js";
import {
  buildGraphImportPlan,
  renderGraphImportPlan,
} from "../graphify-import.js";
import {
  detectQueryIntent,
  extractMemoriesFromResponse,
  getGraphsForIntent,
  getIntentDescription,
} from "../query-processing.js";
import type { TextContent, SearchData } from "../types.js";
import {
  ERR_NEO4J_CONFIG,
  ERR_PARAM_MISSING,
  apiErrorResponse,
  cubeRegistrationError,
  errorResponse,
  getCubeIdFromArgs,
} from "./utils.js";

// ============================================================================
// Neo4j Helper
// ============================================================================

/**
 * Validate a Graphify node-link document and return a dry-run report.
 *
 * The MCP surface accepts JSON rather than a filesystem path so an agent
 * cannot make the server read arbitrary local files.  Applying the plan to a
 * database is intentionally a separate future step.
 */
export function handleMemosGraphifyImport(
  arguments_: Record<string, unknown>,
): TextContent[] {
  const raw = arguments_.graph_json;
  if (
    raw === undefined ||
    raw === null ||
    (typeof raw === "string" && !raw.trim())
  ) {
    return errorResponse(
      "graph_json is required for Graphify import dry-run",
      ERR_PARAM_MISSING,
      [
        "Pass the contents of Graphify graph.json as graph_json",
        "No database write occurs in this mode",
      ],
    );
  }

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > 5_000_000) {
      return errorResponse(
        "graph_json exceeds the 5 MB safety limit",
        "PARAM_INVALID",
      );
    }
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (err) {
      return errorResponse(
        `graph_json is not valid JSON: ${String(err)}`,
        "PARAM_INVALID",
      );
    }
  }

  try {
    const plan = buildGraphImportPlan(parsed, {
      projectKey:
        typeof arguments_.project_key === "string"
          ? arguments_.project_key
          : undefined,
    });
    return [{ type: "text", text: renderGraphImportPlan(plan) }];
  } catch (err) {
    return errorResponse(
      `Graphify import validation failed: ${String(err)}`,
      "PARAM_INVALID",
      [
        "Use Graphify NetworkX node-link JSON with nodes and links (or edges)",
        "Ensure every edge endpoint refers to an existing node and source_file is project-relative",
      ],
    );
  }
}

function neo4jAuthHeader(): string {
  return `Basic ${Buffer.from(`${NEO4J_USER}:${NEO4J_PASSWORD}`).toString("base64")}`;
}

async function neo4jQuery(
  cypher: string,
  parameters: Record<string, unknown>,
): Promise<{
  ok: boolean;
  data: Record<string, unknown> | null;
  status: number;
}> {
  try {
    const response = await fetchWithTimeout(NEO4J_HTTP_URL!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: neo4jAuthHeader(),
      },
      body: JSON.stringify({
        statements: [{ statement: cypher, parameters }],
      }),
      timeoutMs: 15,
    });

    const data = (await response.json()) as Record<string, unknown>;
    return { ok: response.ok, data, status: response.status };
  } catch (err) {
    logger.error(`Neo4j query error: ${err}`);
    return { ok: false, data: null, status: 0 };
  }
}

// ============================================================================
// memos_graph(mode="path")
// ============================================================================

export async function handleMemosTracePath(
  arguments_: Record<string, unknown>,
): Promise<TextContent[]> {
  const cubeId = getCubeIdFromArgs(arguments_);
  const sourceId = String(arguments_.source_id ?? "");
  const targetId = String(arguments_.target_id ?? "");
  const maxDepth = Math.min(Number(arguments_.max_depth ?? 3), 10);

  if (!sourceId || !targetId) {
    return errorResponse(
      "Both source_id and target_id are required",
      ERR_PARAM_MISSING,
      [
        'Get node IDs from memos_search or memos_graph(mode="related")',
        '`memos_graph(mode="path", source_id="uuid-1", target_id="uuid-2")`',
      ],
    );
  }

  const [regSuccess, regError] = await ensureCubeRegistered(cubeId);
  if (!regSuccess) return cubeRegistrationError(cubeId, regError);

  try {
    const response = await fetchWithTimeout(
      `${MEMOS_URL}/product/graph/trace_path`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: MEMOS_USER,
          source_id: sourceId,
          target_id: targetId,
          max_depth: maxDepth,
          include_all_paths: false,
          mem_cube_id: cubeId,
        }),
      },
    );

    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>;
      if (data.code === 200) {
        const traceData = (data.data as Record<string, unknown>) ?? {};
        const found = traceData.path_found ?? traceData.found ?? false;
        const paths = (traceData.paths as unknown[]) ?? [];
        const sourceNode = (traceData.source as Record<string, unknown>) ?? {};
        const targetNode = (traceData.target as Record<string, unknown>) ?? {};

        const results: string[] = ["## 🔗 Path Trace Results", ""];

        if (sourceNode.memory) {
          results.push(
            `**Source**: ${String(sourceNode.memory).slice(0, 80)}...`,
          );
          results.push(`**Source evidence**: ${formatProvenance(sourceNode)}`);
        }
        if (targetNode.memory) {
          results.push(
            `**Target**: ${String(targetNode.memory).slice(0, 80)}...`,
          );
          results.push(`**Target evidence**: ${formatProvenance(targetNode)}`);
        }
        results.push("");

        if (!found) {
          results.push(`*No path found within ${maxDepth} hops.*`, "");
          results.push("Suggestions:");
          results.push("- Try increasing max_depth (up to 10)");
          results.push("- Verify the node IDs are correct");
          results.push("- The nodes may not be connected in the graph");
        } else {
          for (let i = 0; i < paths.length; i++) {
            const path = paths[i] as Record<string, unknown>;
            const length = path.length ?? 0;
            const nodes = (path.nodes as unknown[]) ?? [];
            const edges = (path.edges as unknown[]) ?? [];

            // If API returns empty nodes, fall back to Neo4j
            if (
              nodes.length === 0 &&
              NEO4J_HTTP_URL &&
              NEO4J_USER &&
              NEO4J_PASSWORD
            ) {
              throw new Error(
                "API returned empty path nodes, falling back to Neo4j",
              );
            }

            results.push(`### Path ${i + 1} (Length: ${length})`, "", "```");
            for (let j = 0; j < nodes.length; j++) {
              const node = nodes[j] as Record<string, unknown>;
              const nodeMem = String(node.memory ?? "").slice(0, 60);
              results.push(`[${j + 1}] ${nodeMem}...`);
              if (j < edges.length) {
                const edge = edges[j] as Record<string, unknown>;
                results.push("    │");
                results.push(`    └── ${edge.type ?? "UNKNOWN"} ──>`);
                results.push(`        Evidence: ${formatProvenance(edge)}`);
              }
            }
            results.push("```", "");
          }
        }

        return [{ type: "text", text: results.join("\n") }];
      } else {
        return apiErrorResponse(
          "Trace path",
          String((data as Record<string, unknown>).message ?? "Unknown error"),
        );
      }
    } else {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (err) {
    logger.warning(`Falling back to direct Neo4j query: ${err}`);

    if (!NEO4J_HTTP_URL || !NEO4J_USER || !NEO4J_PASSWORD) {
      return errorResponse("Neo4j configuration missing", ERR_NEO4J_CONFIG, [
        "Set NEO4J_HTTP_URL, NEO4J_USER, NEO4J_PASSWORD in .env",
        "Example: NEO4J_HTTP_URL=http://localhost:7474/db/neo4j/tx/commit",
      ]);
    }

    const cypher = `
      MATCH (source:Memory), (target:Memory)
      WHERE source.id = $source_id AND target.id = $target_id
      MATCH path = shortestPath((source)-[*1..${maxDepth}]-(target))
      RETURN [n IN nodes(path) | {id: n.id, memory: n.memory}] AS nodes,
             [r IN relationships(path) | {type: type(r), provenance: properties(r)}] AS rels
      LIMIT 1
    `;

    const { ok, data, status } = await neo4jQuery(cypher, {
      source_id: sourceId,
      target_id: targetId,
    });

    const results = ["## 🔗 Path Trace (Direct Query)", ""];

    if (ok && data) {
      const rows =
        ((data.results as Record<string, unknown>[])?.[0]?.data as Record<
          string,
          unknown
        >[]) ?? [];
      if (rows.length > 0) {
        const row = (rows[0].row as unknown[][]) ?? [[], []];
        const nodes = (row[0] as Record<string, unknown>[]) ?? [];
        const rels = (row[1] as Record<string, unknown>[]) ?? [];

        results.push("```");
        for (let j = 0; j < nodes.length; j++) {
          const nodeMem = String(nodes[j].memory ?? "").slice(0, 60);
          results.push(`[${j + 1}] ${nodeMem}...`);
          if (j < rels.length) {
            const rel = rels[j] as Record<string, unknown>;
            results.push(`    └── ${rel.type ?? "?"} ──>`);
            results.push(
              `        Evidence: ${formatProvenance(rel.provenance ?? rel)}`,
            );
          }
        }
        results.push("```");
      } else {
        results.push(`*No path found within ${maxDepth} hops.*`);
      }
    } else {
      results.push(`*Neo4j query error: ${status}*`);
    }

    return [{ type: "text", text: results.join("\n") }];
  }
}

// ============================================================================
// memos_graph(mode="related")
// ============================================================================

export async function handleMemosGetGraph(
  arguments_: Record<string, unknown>,
): Promise<TextContent[]> {
  const cubeId = getCubeIdFromArgs(arguments_);
  const query = String(arguments_.query ?? "");

  const intent = detectQueryIntent(query);
  const targetEdgeTypes = getGraphsForIntent(intent);

  const [regSuccess, regError] = await ensureCubeRegistered(cubeId);
  if (!regSuccess) return cubeRegistrationError(cubeId, regError);

  if (!NEO4J_HTTP_URL || !NEO4J_USER || !NEO4J_PASSWORD) {
    return errorResponse("Neo4j configuration missing", ERR_NEO4J_CONFIG, [
      "Set NEO4J_HTTP_URL, NEO4J_USER, NEO4J_PASSWORD in .env",
      "Example: NEO4J_HTTP_URL=http://localhost:7474/db/neo4j/tx/commit",
    ]);
  }

  // Search for relevant memories first
  let memories: ReturnType<typeof extractMemoriesFromResponse> = [];
  try {
    const searchResponse = await fetchWithTimeout(`${MEMOS_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: MEMOS_USER,
        query,
        install_cube_ids: [cubeId],
      }),
    });

    if (searchResponse.ok) {
      const data = (await searchResponse.json()) as Record<string, unknown>;
      if (data.code === 200) {
        memories = extractMemoriesFromResponse((data.data as SearchData) ?? {});
      } else {
        // Re-register and retry
        registeredCubes.delete(cubeId);
        const [retrySuccess] = await ensureCubeRegistered(cubeId, true);
        if (retrySuccess) {
          const retrySearch = await fetchWithTimeout(`${MEMOS_URL}/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              user_id: MEMOS_USER,
              query,
              install_cube_ids: [cubeId],
            }),
          });
          if (retrySearch.ok) {
            const retryData = (await retrySearch.json()) as Record<
              string,
              unknown
            >;
            if (retryData.code === 200) {
              memories = extractMemoriesFromResponse(
                (retryData.data as SearchData) ?? {},
              );
            }
          }
        }
      }
    }
  } catch (err) {
    logger.warning(`Graph search failed: ${err}`);
  }

  // Build Cypher query
  const edgeTypesCypher = targetEdgeTypes.join("|");
  const memIds = memories
    .slice(0, 10)
    .map((m) => m.id ?? (m.metadata?.id as string))
    .filter(Boolean);

  let cypher: string;
  let params: Record<string, unknown>;

  if (memIds.length > 0) {
    const idList = memIds.map((id) => `"${id}"`).join(", ");
    cypher = `
      MATCH (a)-[r:${edgeTypesCypher}]->(b)
      WHERE a.id IN [${idList}] OR b.id IN [${idList}]
      RETURN a.id as source_id, a.memory as source_memory,
             type(r) as relation_type,
             b.id as target_id, b.memory as target_memory,
             properties(r) as relation_provenance
      LIMIT 20
    `;
    params = {};
  } else {
    const firstWord = query.split(/\s+/)[0] ?? query;
    cypher = `
      MATCH (a)-[r:${edgeTypesCypher}]->(b)
      WHERE a.memory CONTAINS $keyword OR b.memory CONTAINS $keyword
      RETURN a.id as source_id, a.memory as source_memory,
             type(r) as relation_type,
             b.id as target_id, b.memory as target_memory,
             properties(r) as relation_provenance
      LIMIT 20
    `;
    params = { keyword: firstWord };
  }

  const { ok, data, status } = await neo4jQuery(cypher, params);

  const results: string[] = [];
  const intentDesc = getIntentDescription(intent);
  results.push(`## 🧠 Knowledge Graph: ${cubeId}`);
  results.push(`Query: \`${query}\` | ${intentDesc}`);
  results.push(`*Filtering edges: ${targetEdgeTypes.join(", ")}*`);
  results.push("");

  if (memories.length > 0) {
    results.push("### 📝 Related Memories", "");
    for (let i = 0; i < Math.min(memories.length, 5); i++) {
      const memory = memories[i].memory ?? "";
      const firstLine = memory.split("\n")[0].slice(0, 100);
      results.push(`${i + 1}. ${firstLine}`);
    }
    results.push("");
  }

  if (ok && data) {
    const rows =
      ((data.results as Record<string, unknown>[])?.[0]?.data as Record<
        string,
        unknown
      >[]) ?? [];

    if (rows.length > 0) {
      results.push("### 🔗 Relationships", "```");
      for (const row of rows) {
        const r = (row.row as unknown[]) ?? [];
        if (r.length >= 5) {
          const sourceMem = String(r[1] ?? "").slice(0, 50);
          const relType = String(r[2] ?? "UNKNOWN");
          const targetMem = String(r[4] ?? "").slice(0, 50);
          const relationProvenance = r[5] ?? {};

          let arrow: string;
          if (relType === "CAUSE") arrow = "──CAUSE──>";
          else if (relType === "RELATE") arrow = "──RELATE──";
          else if (relType === "CONFLICT") arrow = "══CONFLICT══";
          else arrow = `──${relType}──>`;

          results.push(`[${sourceMem}...]`);
          results.push(`    ${arrow}`);
          results.push(`[${targetMem}...]`);
          results.push(`    Evidence: ${formatProvenance(relationProvenance)}`);
          results.push("");
        }
      }
      results.push("```");
    } else {
      results.push("*No relationships found for this query.*");
    }
  } else {
    results.push(`*Neo4j query error: ${status}*`);
  }

  return [{ type: "text", text: results.join("\n") }];
}

// ============================================================================
// memos_graph(mode="schema")
// ============================================================================

/**
 * 把 /graph/schema 的响应渲染成报告。
 *
 * ## 为什么是导出的纯函数
 *
 * 这段逻辑原本内联在 handler 里，单测触达不到 —— 于是**五个字段名读错了
 * 却长期无人发现**。抽出来才能钉住字段契约。同一类漏洞本轮已出现过两次
 * （list 路径的层级过滤、access-tracker 的接线）。
 *
 * ## 修掉的字段名不匹配
 *
 * API（SchemaData）返回的键与此前读取的键对不上，读不到就 `?? 0` 静默兜成零：
 *
 * | 此前读                      | API 实际返回        |
 * |----------------------------|--------------------|
 * | `avg_connections_per_node` | `avg_connections`  |
 * | `orphan_node_count`        | `orphan_nodes`     |
 * | `edge_type_distribution`   | `edge_types`       |
 * | `memory_type_distribution` | `memory_types`     |
 * | `tag_frequency`            | `top_tags`         |
 *
 * `max_connections` / `total_nodes` / `total_edges` / `time_range` 恰好同名，
 * 所以只有上面五项失效 —— 部分正确正是它难被发现的原因。
 *
 * 后果不只是少显示：健康评估读的也是错字段，于是 orphan 比例恒为 0（永远
 * 报「连接良好」），avg 恒为 0（永远报「平均连接过低」）。两句结论同时出现、
 * 自相矛盾，而它们**都是基于零值**得出的。
 *
 * 兼容两种键名：后端字段若将来改回长名，读取仍然成立。
 */
export function formatSchemaReport(schema: Record<string, unknown>): string {
  /** 依次尝试多个键名，取第一个存在的。 */
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      if (schema[key] !== undefined && schema[key] !== null) return schema[key];
    }
    return undefined;
  };
  const num = (...keys: string[]): number => {
    const raw = Number(pick(...keys));
    return Number.isFinite(raw) ? raw : 0;
  };
  const dict = (...keys: string[]): Record<string, number> => {
    const raw = pick(...keys);
    return raw && typeof raw === "object"
      ? (raw as Record<string, number>)
      : {};
  };

  const totalNodes = num("total_nodes");
  const avgConn = num("avg_connections", "avg_connections_per_node");
  const orphanCount = num("orphan_nodes", "orphan_node_count");

  const results: string[] = ["## 📊 Knowledge Graph Schema", ""];
  results.push("### Overview");
  results.push(`- **Total Nodes**: ${totalNodes}`);
  results.push(`- **Total Edges**: ${num("total_edges")}`);
  results.push(`- **Avg Connections/Node**: ${avgConn.toFixed(2)}`);
  results.push(`- **Max Connections**: ${num("max_connections")}`);
  results.push(`- **Orphan Nodes**: ${orphanCount}`);
  results.push("");

  const timeRange = dict("time_range") as unknown as Record<string, unknown>;
  if (timeRange.earliest || timeRange.latest) {
    results.push("### Time Range");
    if (timeRange.earliest) results.push(`- Earliest: ${timeRange.earliest}`);
    if (timeRange.latest) results.push(`- Latest: ${timeRange.latest}`);
    results.push("");
  }

  const edgeDist = dict("edge_types", "edge_type_distribution");
  if (Object.keys(edgeDist).length > 0) {
    results.push("### Relationship Types");
    for (const [t, c] of Object.entries(edgeDist).sort((a, b) => b[1] - a[1])) {
      results.push(`- **${t}**: ${c}`);
    }
    results.push("");
  }

  const memDist = dict("memory_types", "memory_type_distribution");
  if (Object.keys(memDist).length > 0) {
    results.push("### Memory Types");
    for (const [t, c] of Object.entries(memDist).sort((a, b) => b[1] - a[1])) {
      results.push(`- ${t}: ${c}`);
    }
    results.push("");
  }

  // top_tags 在 SchemaData 里是 list；旧读法当成 {tag: count} 字典。两种都收。
  const rawTags = pick("top_tags", "tag_frequency");
  const tagItems: Array<[string, number | string]> = Array.isArray(rawTags)
    ? rawTags
        .slice(0, 10)
        .map((entry) =>
          Array.isArray(entry)
            ? [String(entry[0]), entry[1] as number]
            : [String(entry), ""],
        )
    : Object.entries(dict("top_tags", "tag_frequency")).slice(0, 10);
  if (tagItems.length > 0) {
    results.push("### Top Tags");
    for (const [tag, count] of tagItems) {
      results.push(count === "" ? `- \`${tag}\`` : `- \`${tag}\`: ${count}`);
    }
    results.push("");
  }

  results.push("### Health Assessment");
  if (totalNodes > 0) {
    const orphanRatio = orphanCount / totalNodes;
    if (orphanRatio > 0.5)
      results.push("⚠️ High orphan ratio - many memories are not connected");
    else if (orphanRatio > 0.2) results.push("📋 Moderate orphan ratio");
    else results.push("✅ Good connectivity - memories are well connected");
  }
  if (avgConn < 1)
    results.push(
      "⚠️ Low average connections - consider enriching relationships",
    );
  else if (avgConn > 5)
    results.push("✅ Rich relationships - good knowledge graph density");

  return results.join("\n");
}

export async function handleMemosExportSchema(
  arguments_: Record<string, unknown>,
): Promise<TextContent[]> {
  const cubeId = getCubeIdFromArgs(arguments_);
  const sampleSize = Math.min(
    Math.max(Number(arguments_.sample_size ?? 100), 10),
    1000,
  );

  const [regSuccess, regError] = await ensureCubeRegistered(cubeId);
  if (!regSuccess) return cubeRegistrationError(cubeId, regError);

  try {
    const response = await fetchWithTimeout(`${MEMOS_URL}/graph/schema`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: MEMOS_USER,
        mem_cube_id: cubeId,
        sample_size: sampleSize,
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>;
      if (data.code === 200) {
        const schema = (data.data as Record<string, unknown>) ?? {};
        return [{ type: "text", text: formatSchemaReport(schema) }];
      } else {
        return apiErrorResponse(
          "Schema export",
          String((data as Record<string, unknown>).message ?? "Unknown error"),
        );
      }
    } else {
      return apiErrorResponse("Schema export", `HTTP ${response.status}`);
    }
  } catch (err) {
    return apiErrorResponse("Schema export", String(err));
  }
}

// ============================================================================
// memos_graph(mode="impact")
// ============================================================================

export async function handleMemosImpact(
  arguments_: Record<string, unknown>,
): Promise<TextContent[]> {
  const cubeId = getCubeIdFromArgs(arguments_);
  const memoryId = String(arguments_.memory_id ?? "");
  const maxDepth = Math.min(Math.max(Number(arguments_.max_depth ?? 3), 1), 6);

  if (!memoryId) {
    return errorResponse("memory_id is required", ERR_PARAM_MISSING, [
      'Get a memory_id from memos_search or memos_graph(mode="related") first',
      '`memos_graph(mode="impact", memory_id="uuid-here")`',
    ]);
  }

  if (!NEO4J_HTTP_URL || !NEO4J_USER || !NEO4J_PASSWORD) {
    return errorResponse("Neo4j configuration missing", ERR_NEO4J_CONFIG, [
      "Set NEO4J_HTTP_URL, NEO4J_USER, NEO4J_PASSWORD in .env",
      "Example: NEO4J_HTTP_URL=http://localhost:7474/db/neo4j/tx/commit",
    ]);
  }

  const cypher = `
    MATCH (source:Memory {id: $source_id})-[:CAUSE|FOLLOWS*1..${maxDepth}]->(node:Memory)
    WITH DISTINCT source, node
    MATCH path = shortestPath((source)-[:CAUSE|FOLLOWS*1..${maxDepth}]->(node))
    RETURN node.id AS id, node.key AS key, node.memory AS memory,
           length(path) AS depth, properties(node) AS node_provenance
    ORDER BY depth ASC
    LIMIT 30
  `;

  try {
    const { ok, data, status } = await neo4jQuery(cypher, {
      source_id: memoryId,
    });

    if (!ok) {
      return apiErrorResponse("Impact analysis", `Neo4j HTTP ${status}`);
    }

    if (!data) {
      return apiErrorResponse("Impact analysis", "No data returned");
    }

    const errors = (data.errors as unknown[]) ?? [];
    if (errors.length > 0) {
      const errMsg = String(
        (errors[0] as Record<string, unknown>).message ?? "Unknown Neo4j error",
      );
      return apiErrorResponse("Impact analysis", errMsg);
    }

    const rows =
      ((data.results as Record<string, unknown>[])?.[0]?.data as Record<
        string,
        unknown
      >[]) ?? [];

    if (rows.length === 0) {
      return [
        {
          type: "text",
          text: "No forward impact found — this memory has no CAUSE or FOLLOWS successors.",
        },
      ];
    }

    // Group by depth
    const depthGroups: Record<
      number,
      Array<{ id: string; key: string; memory: string; provenance: unknown }>
    > = {};
    for (const row of rows) {
      const r = (row.row as unknown[]) ?? [];
      if (r.length >= 4) {
        const depth = Number(r[3]);
        if (!depthGroups[depth]) depthGroups[depth] = [];
        depthGroups[depth].push({
          id: String(r[0] ?? ""),
          key: String(r[1] ?? ""),
          memory: String(r[2] ?? ""),
          provenance: r[4] ?? {},
        });
      }
    }

    const totalCount = Object.values(depthGroups).reduce(
      (sum, items) => sum + items.length,
      0,
    );
    const maxHop = Math.max(...Object.keys(depthGroups).map(Number));

    const results: string[] = [
      "## Impact Analysis",
      "",
      `**Blast Radius: ${totalCount} downstream memories across ${maxHop} hop(s)**`,
      "",
    ];

    const depthLabels: Record<number, string> = {
      1: "Direct Impact",
      2: "Indirect Impact",
    };

    for (const depth of Object.keys(depthGroups)
      .map(Number)
      .sort((a, b) => a - b)) {
      const items = depthGroups[depth];
      const label = depthLabels[depth] ?? `Downstream (hop ${depth})`;
      results.push(
        `### ${label} (${items.length} node${items.length !== 1 ? "s" : ""})`,
        "",
      );

      for (let i = 0; i < Math.min(items.length, 8); i++) {
        const item = items[i];
        const memPreview = item.memory.split("\n")[0].slice(0, 100);
        if (item.key) {
          results.push(`- **${item.key}**: ${memPreview}`);
        } else {
          results.push(`- ${memPreview}`);
        }
        results.push(`  - Evidence: ${formatProvenance(item.provenance)}`);
      }

      if (items.length > 8) {
        results.push(`- ... and ${items.length - 8} more`);
      }
      results.push("");
    }

    return [{ type: "text", text: results.join("\n") }];
  } catch (err) {
    return apiErrorResponse("Impact analysis", String(err));
  }
}

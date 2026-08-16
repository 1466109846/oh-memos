import { MEMOS_URL, MEMOS_USER } from "../config.js";
import { apiCallWithRetry } from "../api-client.js";
import { ensureCubeRegistered } from "../cube-manager.js";
import { relationEdges } from "../wiki-relations.js";

async function writeRelationsForPage(
  cubeId: string,
  effectiveId: string,
  page: { title: string; related: string[] },
  fileBaseIndex: Map<string, string>
): Promise<{ written: number; unresolved: string[]; malformed: string[]; failed: string[] }> {
  const result = relationEdges(effectiveId, page.related, fileBaseIndex);
  const written: number[] = [];
  const failed: string[] = [];

  for (const edge of result.resolved) {
    const relResult = await apiCallWithRetry(
      "POST",
      `${MEMOS_URL}/product/graph/relation`,
      cubeId,
      {
        body: {
          user_id: MEMOS_USER,
          mem_cube_id: cubeId,
          source_id: edge.sourceId,
          target_id: edge.targetId,
          relation_type: edge.relationType,
        },
      },
      ensureCubeRegistered
    );
    if (relResult.success) written.push(1);
    else failed.push(`${edge.relationType} → ${edge.targetId.slice(0, 8)}`);
  }

  return {
    written: written.length,
    unresolved: result.unresolved,
    malformed: result.malformed,
    failed,
  };
}

export { writeRelationsForPage };

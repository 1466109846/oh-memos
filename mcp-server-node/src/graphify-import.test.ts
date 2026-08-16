import { describe, expect, it } from "vitest";
import { buildGraphImportPlan, renderGraphImportPlan } from "./graphify-import.js";

const validGraph = {
  directed: false,
  multigraph: false,
  graph: {},
  nodes: [
    {
      id: "api",
      label: "routes.py",
      file_type: "code",
      source_file: "src/routes.py",
      source_location: "L1",
    },
    {
      id: "api_search",
      label: "search()",
      file_type: "code",
      source_file: "src/routes.py",
      source_location: "L20",
    },
  ],
  links: [
    {
      source: "api",
      target: "api_search",
      relation: "contains",
      confidence: "EXTRACTED",
      source_file: "src/routes.py",
      source_location: "L20",
      weight: 1,
    },
  ],
};

describe("buildGraphImportPlan", () => {
  it("creates a deterministic dry-run plan from Graphify node-link JSON", () => {
    const plan = buildGraphImportPlan(validGraph, { projectKey: "oh-memos" });
    expect(plan.version).toBe("graphify-node-link/v1");
    expect(plan.stats).toEqual({ nodes: 2, edges: 1, warnings: 0 });
    expect(plan.nodes[0]).toMatchObject({
      external_id: "api",
      node_type: "CODE_SYMBOL",
      source_file: "src/routes.py",
      provenance: { evidence_kind: "UNKNOWN" },
    });
    expect(plan.edges[0]).toMatchObject({
      relation: "CONTAINS",
      provenance: { evidence_kind: "EXTRACTED", confidence_score: 1 },
    });
  });

  it("accepts NetworkX edges as a compatibility alias", () => {
    const { links: _links, ...withoutLinks } = validGraph;
    const plan = buildGraphImportPlan({
      ...withoutLinks,
      edges: validGraph.links,
    });
    expect(plan.stats.edges).toBe(1);
  });

  it("rejects duplicate node ids and dangling endpoints", () => {
    expect(() => buildGraphImportPlan({
      ...validGraph,
      nodes: [...validGraph.nodes, validGraph.nodes[0]],
    })).toThrow(/duplicate node id/i);

    expect(() => buildGraphImportPlan({
      ...validGraph,
      links: [{ ...validGraph.links[0], target: "missing" }],
    })).toThrow(/unknown target/i);
  });

  it("rejects unsafe source paths before an import can be written", () => {
    expect(() => buildGraphImportPlan({
      ...validGraph,
      nodes: [{ ...validGraph.nodes[0], source_file: "../secrets.txt" }, validGraph.nodes[1]],
    })).toThrow(/relative|traversal/i);

    expect(() => buildGraphImportPlan({
      ...validGraph,
      nodes: [{ ...validGraph.nodes[0], source_file: "C:\\secrets.txt" }, validGraph.nodes[1]],
    })).toThrow(/relative|absolute/i);
  });

  it("rejects invalid confidence values at the import boundary", () => {
    expect(() => buildGraphImportPlan({
      ...validGraph,
      nodes: [{ ...validGraph.nodes[0], confidence_score: 1.2 }, validGraph.nodes[1]],
    })).toThrow(/confidence.*0.*1/i);

    expect(() => buildGraphImportPlan({
      ...validGraph,
      links: [{ ...validGraph.links[0], confidence: "CERTAIN" }],
    })).toThrow(/confidence.*category/i);

    expect(() => buildGraphImportPlan({
      ...validGraph,
      links: [{ ...validGraph.links[0], confidence: -0.1 }],
    })).toThrow(/confidence.*0.*1/i);
  });

  it("rejects malformed graph roots instead of silently importing partial data", () => {
    expect(() => buildGraphImportPlan({ nodes: [] })).toThrow(/nodes.*array/i);
    expect(() => buildGraphImportPlan({ nodes: validGraph.nodes, links: "bad" })).toThrow(/links|edges.*array/i);
  });

  it("renders an explicit no-write dry-run report", () => {
    const report = renderGraphImportPlan(buildGraphImportPlan(validGraph, { projectKey: "demo" }));
    expect(report).toContain("Graphify Import Plan (dry-run)");
    expect(report).toContain("No Neo4j, Qdrant, or memory-cube data was written.");
    expect(report).toContain("confidence 1.00");
  });
});

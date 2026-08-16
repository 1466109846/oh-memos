import { describe, expect, it } from "vitest";
import { handleMemosGraphifyImport } from "./handlers/graph.js";

const graphJson = JSON.stringify({
  nodes: [
    { id: "file", label: "a.py", file_type: "code", source_file: "src/a.py" },
    { id: "fn", label: "f()", file_type: "code", source_file: "src/a.py", source_location: "L1" },
  ],
  links: [{ source: "file", target: "fn", relation: "contains", confidence: "EXTRACTED", weight: 1 }],
});

describe("handleMemosGraphifyImport", () => {
  it("returns a no-write report without contacting the databases", () => {
    const [result] = handleMemosGraphifyImport({ graph_json: graphJson, project_key: "demo" });
    expect(result.text).toContain("Graphify Import Plan (dry-run)");
    expect(result.text).toContain("No Neo4j, Qdrant, or memory-cube data was written.");
  });

  it("returns actionable parameter errors", () => {
    expect(handleMemosGraphifyImport({})[0].text).toContain("PARAM_MISSING");
    expect(handleMemosGraphifyImport({ graph_json: "{" })[0].text).toContain("PARAM_INVALID");
  });
});

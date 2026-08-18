import { createHash } from "node:crypto";

import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { describe, expect, it } from "vitest";

import { checkArgContract, recordRawArgKeys } from "./handlers/arg-contract.js";
import { toolAnnotations, toolSchemas } from "./tools-registry.js";

const EXPECTED_TOOL_ORDER = [
  "memos_context_resume",
  "memos_search",
  "memos_think",
  "memos_export_wiki",
  "memos_import_wiki",
  "memos_save",
  "memos_list_v2",
  "memos_get",
  "memos_suggest",
  "memos_distill_skill",
  "memos_list_skill_candidates",
  "memos_review_skill_candidate",
  "memos_install_skill_candidate",
  "memos_graph",
  "memos_admin",
  "memos_canvas",
  "memos_delete",
] as const;

const EXPECTED_ANNOTATIONS: Record<
  (typeof EXPECTED_TOOL_ORDER)[number],
  { readOnlyHint: boolean; openWorldHint: boolean }
> = {
  memos_context_resume: { readOnlyHint: true, openWorldHint: false },
  memos_search: { readOnlyHint: true, openWorldHint: true },
  memos_think: { readOnlyHint: true, openWorldHint: true },
  memos_export_wiki: { readOnlyHint: false, openWorldHint: false },
  memos_import_wiki: { readOnlyHint: false, openWorldHint: true },
  memos_save: { readOnlyHint: false, openWorldHint: true },
  memos_list_v2: { readOnlyHint: true, openWorldHint: false },
  memos_get: { readOnlyHint: true, openWorldHint: false },
  memos_suggest: { readOnlyHint: true, openWorldHint: false },
  memos_distill_skill: { readOnlyHint: false, openWorldHint: true },
  memos_list_skill_candidates: { readOnlyHint: true, openWorldHint: false },
  memos_review_skill_candidate: { readOnlyHint: false, openWorldHint: false },
  memos_install_skill_candidate: { readOnlyHint: false, openWorldHint: false },
  memos_graph: { readOnlyHint: true, openWorldHint: true },
  memos_admin: { readOnlyHint: false, openWorldHint: false },
  memos_canvas: { readOnlyHint: false, openWorldHint: false },
  memos_delete: { readOnlyHint: false, openWorldHint: false },
};

/**
 * Hashes cover business-relevant JSON Schema semantics after resolving local
 * refs and removing dialect-only metadata. The configured default cube value
 * is replaced with a placeholder because CI and local environments use
 * different cube ids while preserving the same defaulting behavior.
 */
const EXPECTED_SCHEMA_HASHES: Record<(typeof EXPECTED_TOOL_ORDER)[number], string> = {
  memos_context_resume: "d778d859b9e88857f8c03141bb48229225e4aacf06e8c34b00aa7195ab998c08",
  memos_search: "a0ec4c7fcce39718d2b75e921aba939903e8975e4eb9308ff801f9a62d9813a2",
  memos_think: "5f6290b22adf0bb212165537466791fd9f4f67d4ede56c64940b6302bff03f77",
  memos_export_wiki: "4d50550bd0882559ebffb7b39e48249dbb03ac604ecde04c4393a85430a65c93",
  memos_import_wiki: "c35085786715cf263f379e650592ef1f2528fb896bdc50dc32a733e13d6c0a6d",
  memos_save: "f4954330769aaa72c64d619ae5cf0fbda421580c6c3edf1386f10753acf6d1a5",
  memos_list_v2: "cf71f2468b8bbdaf8d442469e37fa689074baf35fbafe50e4e436ca22ea3277b",
  memos_get: "fbbcac269a905f8be330636e9aff371ec8b51397542baff7368e1c5691ec9cda",
  memos_suggest: "ea389005ebb186887b42e932c52090a88fdd5caa425cd3ef76a60e0d17fb5e32",
  memos_distill_skill: "e245aece467ca39bca29a650c252c6e0f86ac92e7977b3b6d066cd3faa87efc4",
  memos_list_skill_candidates: "96947ed6cd5b00eeed852d4c070a34399c1f07f1eadd0f869bd28de301793f69",
  memos_review_skill_candidate: "4d200cf79d10360c5b3c85998873b8bf7f2264a64b66de0ebb10662c4982753d",
  memos_install_skill_candidate: "26b3830037ce208828b27d711e1d154c0c44758365f0886665d17b675da0a7f1",
  memos_graph: "761de3f70bfb08392485ae3323a84aa8e5d1f947477de1c6a05168daaa8f7cf9",
  memos_admin: "9b18756a8dfad31c0a7c3b7afa46be2aa59341f5b03152c858b7007f66265c82",
  memos_canvas: "d81423acc877437d719d181723fbefa93ba4115adf6efe05617d973a2adbe288",
  memos_delete: "08cb11b7b7a5649f98acd6e8d90b4ba524d1db4eb25c5d2956af0932cf54d3b7",
};

type JsonObject = Record<string, unknown>;

const SEMANTIC_KEYS = [
  "type",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "default",
  "description",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "pattern",
  "format",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
] as const;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePointer(root: JsonObject, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;

  let current: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    if (!isObject(current)) return undefined;
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    current = current[segment];
  }
  return current;
}

function dereference(node: unknown, root: JsonObject, stack = new Set<string>()): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => dereference(item, root, stack));
  }
  if (!isObject(node)) return node;

  const ref = typeof node.$ref === "string" ? node.$ref : undefined;
  if (ref) {
    if (stack.has(ref)) return { $ref: ref };
    const target = resolvePointer(root, ref);
    if (target !== undefined) {
      const nextStack = new Set(stack);
      nextStack.add(ref);
      return dereference(target, root, nextStack);
    }
  }

  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, dereference(value, root, stack)])
  );
}

function semanticSchema(node: unknown, parentKey = "", path: string[] = []): unknown {
  if (Array.isArray(node)) {
    const values = node.map((item) => semanticSchema(item, "", path));
    if (["required", "enum", "type", "anyOf", "oneOf", "allOf"].includes(parentKey)) {
      return values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return values;
  }
  if (!isObject(node)) return node;

  const result: JsonObject = {};
  if (isObject(node.properties)) {
    result.properties = Object.fromEntries(
      Object.entries(node.properties)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => [
          name,
          semanticSchema(value, "properties", [...path, name]),
        ])
    );
  }

  for (const key of SEMANTIC_KEYS) {
    if (!Object.hasOwn(node, key)) continue;
    result[key] =
      key === "default" && path.at(-1) === "cube_id"
        ? "<MEMOS_DEFAULT_CUBE>"
        : semanticSchema(node[key], key, path);
  }

  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b))
  );
}

function semanticHash(schema: JsonObject): string {
  const canonical = JSON.stringify(semanticSchema(dereference(schema, schema)));
  return createHash("sha256").update(canonical).digest("hex");
}

describe("legacy MCP protocol contract", () => {
  it("keeps the 17-tool registry in deterministic order", () => {
    expect(Object.keys(toolSchemas)).toEqual(EXPECTED_TOOL_ORDER);
  });

  it("keeps tool annotations stable", () => {
    expect(toolAnnotations).toEqual(EXPECTED_ANNOTATIONS);
  });

  for (const name of EXPECTED_TOOL_ORDER) {
    it("keeps " + name + " schema semantics stable", () => {
      const rawSchema = toJsonSchemaCompat(toolSchemas[name].inputSchema, {
        strictUnions: true,
        pipeStrategy: "input",
      }) as JsonObject;
      expect(semanticHash(rawSchema)).toBe(EXPECTED_SCHEMA_HASHES[name]);
    });
  }

  it("keeps unknown routing-key disclosure behavior", () => {
    const requestId = "protocol-contract-routing-key";
    recordRawArgKeys(requestId, { query: "auth", projectPath: "G:/test/oh-memos" });

    const result = checkArgContract("memos_search", requestId);

    expect(result.ignored).toEqual(["projectPath"]);
    expect(result.affectsRouting).toBe(true);
    expect(result.warning).toContain("did you mean `project_path`?");
  });

  it("consumes declared raw keys without a warning", () => {
    const requestId = "protocol-contract-declared-keys";
    recordRawArgKeys(requestId, { query: "auth", project_path: "G:/test/oh-memos" });

    expect(checkArgContract("memos_search", requestId)).toEqual({
      ignored: [],
      affectsRouting: false,
      warning: null,
    });
  });
});

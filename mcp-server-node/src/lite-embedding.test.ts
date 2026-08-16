import { describe, expect, it } from "vitest";
import { OllamaEmbedder } from "./providers/lite-embedding.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("OllamaEmbedder", () => {
  it("parses a valid embedding response", async () => {
    const calls: unknown[] = [];
    const embedder = new OllamaEmbedder({
      url: "http://127.0.0.1:11434/",
      model: "bge-m3",
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input: String(input), body: JSON.parse(String(init?.body)) });
        return jsonResponse({ embedding: [0.1, 0.2, 0.3] });
      }) as typeof fetch,
    });
    const vector = await embedder.embed("qdrant tuning");
    expect(vector).toEqual([0.1, 0.2, 0.3]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      input: "http://127.0.0.1:11434/api/embeddings",
      body: { model: "bge-m3", prompt: "qdrant tuning" },
    });
  });

  it("returns null on HTTP errors, malformed bodies, and network failures", async () => {
    const http500 = new OllamaEmbedder({ url: "http://x", model: "m", fetchImpl: (async () => jsonResponse({ error: "boom" }, 500)) as typeof fetch });
    expect(await http500.embed("t")).toBeNull();

    const malformed = new OllamaEmbedder({ url: "http://x", model: "m", fetchImpl: (async () => jsonResponse({ nope: true })) as typeof fetch });
    expect(await malformed.embed("t")).toBeNull();

    const offline = new OllamaEmbedder({ url: "http://x", model: "m", fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
    expect(await offline.embed("t")).toBeNull();
  });

  it("truncates very long prompts before sending", async () => {
    let sent = "";
    const embedder = new OllamaEmbedder({
      url: "http://x", model: "m",
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body)).prompt;
        return jsonResponse({ embedding: [1] });
      }) as typeof fetch,
    });
    await embedder.embed("x".repeat(10_000));
    expect(sent.length).toBeLessThanOrEqual(4000);
  });
});

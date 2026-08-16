/**
 * Local embedding support for the Lite provider.
 *
 * The Lite store has no Python API and no vector database, so semantic search
 * needs an embedding source that runs beside the MCP process. A local Ollama
 * instance is that source: it is already the documented local-model path in
 * this deployment, and talking to it is a plain HTTP call — no new runtime
 * dependency.
 *
 * Every method returns null instead of throwing. A missing or slow Ollama must
 * degrade the provider to lexical ranking, never fail a save or a search.
 */

export interface LiteEmbedder {
  /** Discriminant for diagnostics; "none" is the always-unavailable embedder. */
  readonly kind: "ollama" | "none" | "fake";
  /** Embed one text; null means unavailable, offline, or malformed response. */
  embed(text: string): Promise<number[] | null>;
}

export const noneEmbedder: LiteEmbedder = {
  kind: "none",
  async embed() {
    return null;
  },
};

const PROMPT_MAX_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 3000;

export class OllamaEmbedder implements LiteEmbedder {
  readonly kind = "ollama" as const;

  constructor(
    private readonly options: {
      url: string;
      model: string;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
    }
  ) {}

  async embed(text: string): Promise<number[] | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const doFetch = this.options.fetchImpl ?? fetch;
      const base = this.options.url.replace(/\/$/, "");
      const response = await doFetch(`${base}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.options.model,
          prompt: text.slice(0, PROMPT_MAX_CHARS),
        }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { embedding?: unknown };
      if (
        !Array.isArray(payload.embedding) ||
        payload.embedding.length === 0 ||
        !payload.embedding.every((value) => typeof value === "number" && Number.isFinite(value))
      ) {
        return null;
      }
      return payload.embedding as number[];
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

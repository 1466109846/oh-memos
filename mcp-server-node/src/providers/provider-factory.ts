import { MEMOS_MODE } from "../config.js";
import { LocalJsonlProvider } from "./local-jsonl-provider.js";
import { OllamaEmbedder, noneEmbedder, type LiteEmbedder } from "./lite-embedding.js";
import type { MemoryProvider } from "./memory-provider.js";

let localProvider: LocalJsonlProvider | undefined;

export function isLocalProvider(): boolean {
  return (process.env.MEMOS_PROVIDER ?? (MEMOS_MODE === "lite" ? "local" : "api")).toLowerCase() === "local";
}

/**
 * Semantic ranking for Lite is optional and must never be required: default is
 * lexical-only, and a local Ollama is picked up automatically when reachable.
 * `MEMOS_LITE_EMBED=off` pins the lexical behavior explicitly.
 */
export function buildLiteEmbedder(): LiteEmbedder {
  if ((process.env.MEMOS_LITE_EMBED ?? "").toLowerCase() === "off") return noneEmbedder;
  return new OllamaEmbedder({
    url: process.env.MEMOS_LITE_EMBED_URL ?? "http://127.0.0.1:11434",
    model: process.env.MEMOS_LITE_EMBED_MODEL ?? "bge-m3",
  });
}

export function getMemoryProvider(cubesDir: string): MemoryProvider | null {
  if (!isLocalProvider()) return null;
  localProvider ??= new LocalJsonlProvider(cubesDir, buildLiteEmbedder());
  return localProvider;
}

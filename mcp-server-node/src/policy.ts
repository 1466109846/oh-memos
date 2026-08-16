export type MemoryMode = "full" | "lite";

export interface MemoryPolicy {
  mode: MemoryMode;
  autoCapture: boolean;
}

export function parseMemoryMode(env: Record<string, string | undefined> = process.env): MemoryPolicy {
  const mode: MemoryMode = env.MEMOS_MODE?.toLowerCase() === "lite" ? "lite" : "full";
  const autoCapture = mode === "full" && env.MEMOS_AUTO_CAPTURE?.toLowerCase() === "true";
  return { mode, autoCapture };
}

export function shouldAutoCapture(env: Record<string, string | undefined> = process.env): boolean {
  return parseMemoryMode(env).autoCapture;
}

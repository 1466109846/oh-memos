export interface WikiPageIdentity { id: string; relPath: string }
export interface DuplicatePageIds { id: string; paths: string[] }

export function inspectWikiPages(pages: WikiPageIdentity[]): { ok: boolean; duplicates: DuplicatePageIds[] } {
  const paths = new Map<string, string[]>();
  for (const page of pages) paths.set(page.id, [...(paths.get(page.id) ?? []), page.relPath]);
  const duplicates = [...paths.entries()]
    .filter(([, values]) => values.length > 1)
    .map(([id, values]) => ({ id, paths: values }));
  return { ok: duplicates.length === 0, duplicates };
}

export type LedgerEntry = string | { content_hash: string; new_memory_ids: string[]; imported_at: string };
export function normalizeLedger(value: unknown): { ok: true; ledger: Record<string, LedgerEntry> } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, ledger: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "ledger root must be an object" };
  const ledger: Record<string, LedgerEntry> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") { ledger[id] = entry; continue; }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, reason: `invalid ledger entry '${id}'` };
    const e = entry as Record<string, unknown>;
    if (typeof e.content_hash !== "string" || !Array.isArray(e.new_memory_ids) || !e.new_memory_ids.every((x) => typeof x === "string") || typeof e.imported_at !== "string") {
      return { ok: false, reason: `invalid ledger entry '${id}'` };
    }
    ledger[id] = { content_hash: e.content_hash, new_memory_ids: e.new_memory_ids as string[], imported_at: e.imported_at };
  }
  return { ok: true, ledger };
}

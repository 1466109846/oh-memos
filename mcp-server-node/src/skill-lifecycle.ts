import { join, resolve, sep } from "path";

export type CandidateStatus = "candidate" | "approved" | "rejected" | "installed";
export interface CandidateFrontMatter { ok: true; status: CandidateStatus; slug: string; sourceMemoryIds: string[] };
export type CandidateParse = CandidateFrontMatter | { ok: false; reason: string };

export function parseCandidateFrontMatter(raw: string): CandidateParse {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0] !== "---") return { ok: false, reason: "missing front matter" };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { ok: false, reason: "unterminated front matter" };
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const i = line.indexOf(":");
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (fields.generator !== "oh-memos-skill-distill") return { ok: false, reason: "invalid generator" };
  if (!["candidate", "approved", "rejected", "installed"].includes(fields.status)) return { ok: false, reason: "invalid status" };
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(fields.slug ?? "")) return { ok: false, reason: "invalid slug" };
  let ids: unknown;
  try { ids = JSON.parse(fields.source_memory_ids ?? ""); } catch { return { ok: false, reason: "invalid source ids" }; }
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string" && id.length > 0)) return { ok: false, reason: "source ids required" };
  return { ok: true, status: fields.status as CandidateStatus, slug: fields.slug, sourceMemoryIds: ids as string[] };
}

export function transitionCandidate(status: CandidateStatus, action: "approve" | "reject" | "install"): CandidateStatus | null {
  if (status === "candidate" && action === "approve") return "approved";
  if (status === "candidate" && action === "reject") return "rejected";
  if (status === "approved" && action === "install") return "installed";
  return null;
}

export function installTargetPath(projectPath: string, slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) throw new Error("invalid skill slug");
  const root = resolve(projectPath);
  const target = resolve(root, ".claude", "skills", slug, "SKILL.md");
  if (!target.startsWith(`${root}${sep}`)) throw new Error("skill target escapes project root");
  return target;
}

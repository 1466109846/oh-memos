import { mkdirSync, writeFileSync, existsSync, lstatSync, renameSync, openSync, closeSync, unlinkSync } from "fs";
import { join, basename } from "path";

export interface SkillCandidate {
  slug: string;
  title: string;
  summary: string;
  memoryIds: string[];
  generatedAt: string;
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return slug || "candidate";
}

export function skillCandidatePath(projectPath: string, title: string): string {
  return join(projectPath, "skill-candidates", `${slugify(basename(title))}.md`);
}

export function renderSkillCandidate(candidate: SkillCandidate): string {
  const ids = candidate.memoryIds.map((id) => JSON.stringify(id)).join(", ");
  return [
    "---",
    "generator: oh-memos-skill-distill",
    "status: candidate",
    `slug: ${candidate.slug}`,
    `generated_at: ${candidate.generatedAt}`,
    `source_memory_ids: [${ids}]`,
    "---",
    "",
    `# ${candidate.title}`,
    "",
    candidate.summary.trim(),
    "",
    "> Do not install automatically. Review this candidate and its source memories first.",
    "",
  ].join("\n");
}

export function writeSkillCandidate(projectPath: string, candidate: SkillCandidate): string {
  const file = skillCandidatePath(projectPath, candidate.title);
  const dir = join(projectPath, "skill-candidates");
  mkdirSync(dir, { recursive: true });
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error("candidate path is a symlink");
  if (existsSync(file)) throw new Error(`candidate already exists: ${file}`);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, renderSkillCandidate(candidate), { encoding: "utf8", flag: "wx" });
    const fd = openSync(temp, "r");
    try { /* open/close ensures the temp file is fully materialized before rename */ } finally { closeSync(fd); }
    renameSync(temp, file);
    return file;
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

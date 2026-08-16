import * as fs from "fs";
import * as path from "path";
import { parseCandidateFrontMatter, transitionCandidate, installTargetPath } from "../skill-lifecycle.js";
import { skillCandidatePath, writeSkillCandidate } from "../skill-candidate.js";
import type { TextContent } from "../types.js";
import { ERR_PARAM_MISSING, errorResponse, successResponse } from "./utils.js";

export function handleMemosDistillSkill(args: Record<string, unknown>): TextContent[] {
  const projectPath = String(args.project_path ?? "");
  const title = String(args.title ?? "").trim();
  const summary = String(args.summary ?? "").trim();
  const memoryIds = Array.isArray(args.memory_ids) ? args.memory_ids.map(String).filter(Boolean) : [];
  if (!projectPath || !title || !summary || memoryIds.length === 0) {
    return errorResponse("project_path, title, summary, and at least one memory_id are required", ERR_PARAM_MISSING, [
      'Example: `memos_distill_skill(project_path="...", title="Migration locking", summary="...", memory_ids=["id"])`',
    ]);
  }
  const candidate = {
    slug: title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "candidate",
    title,
    summary,
    memoryIds,
    generatedAt: new Date().toISOString(),
  };
  const output = skillCandidatePath(projectPath, title);
  try { writeSkillCandidate(projectPath, candidate); }
  catch (error) { return errorResponse(`Cannot create candidate: ${String(error)}`, "OPERATION_FAILED"); }
  return successResponse(["## Skill candidate created", "", `**File**: \`${output}\``, `**Sources**: ${memoryIds.join(", ")}`, "", "Review it before installing; it is inert by design."].join("\n"));
}

export function handleMemosListSkillCandidates(args: Record<string, unknown>): TextContent[] {
  const projectPath = String(args.project_path ?? "");
  if (!projectPath) return errorResponse("project_path is required", ERR_PARAM_MISSING);
  const dir = path.join(projectPath, "skill-candidates");
  if (!fs.existsSync(dir)) return successResponse("No skill candidates found.");
  const files = fs.readdirSync(dir).filter((name) => {
    if (!name.endsWith(".md")) return false;
    try {
      const text = fs.readFileSync(path.join(dir, name), "utf8").slice(0, 400);
      return text.includes("generator: oh-memos-skill-distill") && /status: (candidate|approved|rejected|installed)/.test(text);
    } catch { return false; }
  }).sort();
  if (files.length === 0) return successResponse("No skill candidates found.");
  return successResponse(["## Skill candidates", "", ...files.map((file) => `- [${file}](skill-candidates/${file})`)].join("\n"));
}

function candidateFile(projectPath: string, candidateId: string): string {
  if (!candidateId || candidateId.includes("/") || candidateId.includes("\\")) throw new Error("candidate_id must be a file name");
  const file = path.resolve(projectPath, "skill-candidates", candidateId);
  const root = path.resolve(projectPath, "skill-candidates");
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error("candidate path escapes project");
  return file;
}

function updateCandidate(args: Record<string, unknown>, action: "approve" | "reject"): TextContent[] {
  const projectPath = String(args.project_path ?? "");
  const candidateId = String(args.candidate_id ?? "");
  const reviewer = String(args.reviewer ?? "").trim();
  if (!projectPath || !candidateId || !reviewer) return errorResponse("project_path, candidate_id, and reviewer are required", ERR_PARAM_MISSING);
  try {
    const file = candidateFile(projectPath, candidateId);
    const raw = fs.readFileSync(file, "utf8");
    const parsed = parseCandidateFrontMatter(raw);
    if (!parsed.ok) return errorResponse(`Invalid candidate: ${parsed.reason}`, "OPERATION_FAILED");
    const next = transitionCandidate(parsed.status, action);
    if (!next) return errorResponse(`Cannot ${action} candidate from status '${parsed.status}'`, "OPERATION_FAILED");
    const marker = raw.indexOf("---", 4);
    const front = raw.slice(0, marker);
    const rest = raw.slice(marker);
    const updated = `${front.replace(`status: ${parsed.status}`, `status: ${next}`)}reviewer: ${reviewer}\nreviewed_at: ${new Date().toISOString()}\n${rest}`;
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, updated, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temp, file);
    return successResponse(`Candidate '${candidateId}' is now ${next}.`);
  } catch (error) { return errorResponse(`Candidate operation failed: ${String(error)}`, "OPERATION_FAILED"); }
}

export function handleMemosReviewSkillCandidate(args: Record<string, unknown>): TextContent[] {
  const action = args.action === "reject" ? "reject" : args.action === "approve" ? "approve" : null;
  if (!action) return errorResponse("action must be approve or reject", "PARAM_INVALID");
  return updateCandidate(args, action);
}

export function handleMemosInstallSkillCandidate(args: Record<string, unknown>): TextContent[] {
  const projectPath = String(args.project_path ?? "");
  const candidateId = String(args.candidate_id ?? "");
  if (!projectPath || !candidateId) return errorResponse("project_path and candidate_id are required", ERR_PARAM_MISSING);
  try {
    const source = candidateFile(projectPath, candidateId);
    const raw = fs.readFileSync(source, "utf8");
    const parsed = parseCandidateFrontMatter(raw);
    if (!parsed.ok) return errorResponse(`Invalid candidate: ${parsed.reason}`, "OPERATION_FAILED");
    if (parsed.status !== "approved") return errorResponse("Candidate must be approved before installation", "OPERATION_FAILED");
    const target = installTargetPath(projectPath, parsed.slug);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target) || fs.lstatSync(path.dirname(target)).isSymbolicLink()) return errorResponse("Install target exists or is a symlink; refusing overwrite", "OPERATION_FAILED");
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, raw, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temp, target);
    return successResponse(`Candidate installed at '${target}'.`);
  } catch (error) { return errorResponse(`Candidate install failed: ${String(error)}`, "OPERATION_FAILED"); }
}

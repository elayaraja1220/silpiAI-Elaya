import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getAgentDir, getOutputRoot, PROJECT_NAME_RE } from "@/lib/silpi-paths";

import { ExecError } from "./types";

/**
 * Project workspaces (server-only). A job may only run inside one folder directly below the generated-projects
 * root, named by a validated project name, with the approved brief in it. Anything else is refused.
 */

/** The approved brief: the readable description and the technology lists the builder must use. */
export type BriefPayload = { description: string; frontend: string[]; backend: string[]; database: string[]; styling: string[] };

export const BRIEF_JSON = path.join(".silpi", "brief.json");
export const BRIEF_MD = path.join(".silpi", "brief.md");

/** Where generated projects live: next to the agent (as before), or SILPI_WORKSPACE_DIR when there is no agent folder. */
export function workspaceRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const agentDir = env.SILPI_AGENT_DIR ? getAgentDir() : null;
  if (agentDir) return getOutputRoot(agentDir);
  const own = env.SILPI_WORKSPACE_DIR;
  return own && path.isAbsolute(own) ? path.resolve(own) : null;
}

export const isProjectName = (name: unknown): name is string => typeof name === "string" && PROJECT_NAME_RE.test(name);

/** The folder for a project name inside the root, or an error. Names that could leave the root never get this far. */
export function resolveWorkspace(root: string, name: unknown): string {
  if (!isProjectName(name)) throw new ExecError("bad-project-name", "The project name is not valid.", 400);
  const dir = path.resolve(root, name);
  const relative = path.relative(root, dir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new ExecError("bad-workspace", "The project folder must be directly inside the projects folder.", 400);
  }
  return dir;
}

/** The real path of the folder is still inside the real path of the root (no link can lead somewhere else). */
export function assertContained(root: string, dir: string): void {
  const relative = path.relative(realpathSync(root), realpathSync(dir));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ExecError("bad-workspace", "The project folder is not inside the projects folder.", 400);
  }
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const serialise = (brief: BriefPayload) => JSON.stringify(brief, null, 2);

export type PreparedWorkspace = { dir: string; briefSha: string; briefBytes: number };

/**
 * Creates the project folder and writes the approved brief into it. A new project folder must be empty;
 * a restart may continue in the folder an earlier attempt left.
 */
export function prepareWorkspace(input: { root: string; name: string; brief: BriefPayload; allowExisting: boolean }): PreparedWorkspace {
  const dir = resolveWorkspace(input.root, input.name);
  mkdirSync(input.root, { recursive: true });
  if (existsSync(dir)) {
    const others = readdirSync(dir).filter((entry) => entry !== ".silpi");
    if (others.length > 0 && !input.allowExisting) {
      throw new ExecError("workspace-in-use", `The folder "${input.name}" already contains files. Open it in My projects to request changes, or choose a different project.`, 409);
    }
  }
  mkdirSync(path.join(dir, ".silpi"), { recursive: true });
  assertContained(input.root, dir);
  const json = serialise(input.brief);
  writeFileSync(path.join(dir, BRIEF_JSON), json, "utf8");
  writeFileSync(path.join(dir, BRIEF_MD), input.brief.description, "utf8");
  return { dir, briefSha: sha256(json), briefBytes: Buffer.byteLength(json, "utf8") };
}

/**
 * Just before a run: the folder is valid, still inside the root, and the brief in it is exactly the one the developer
 * approved (nothing edited it since). Returns the brief to run.
 */
export function verifyJobWorkspace(root: string, name: string, expectedSha: string): { dir: string; brief: BriefPayload } {
  const dir = resolveWorkspace(root, name);
  if (!existsSync(dir)) throw new ExecError("workspace-missing", "The project folder no longer exists. Prepare the workspace again.", 409);
  assertContained(root, dir);
  const file = path.join(dir, BRIEF_JSON);
  if (!existsSync(file)) throw new ExecError("brief-missing", "The approved brief is missing from the project folder. Prepare the workspace again.", 409);
  const json = readFileSync(file, "utf8");
  if (sha256(json) !== expectedSha) throw new ExecError("brief-changed", "The brief in the project folder was changed after it was approved. Prepare the workspace again.", 409);
  const brief = JSON.parse(json) as BriefPayload;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 8) : []);
  return { dir, brief: { description: String(brief.description ?? ""), frontend: list(brief.frontend), backend: list(brief.backend), database: list(brief.database), styling: list(brief.styling) } };
}

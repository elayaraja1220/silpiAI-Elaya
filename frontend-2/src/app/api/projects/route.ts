import { access, constants, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

import { getAgentCliPath, getAgentDir, getOutputRoot } from "@/lib/silpi-paths";
import type { AgentInfo, Project, ProjectsResponse } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NONE = "—";
const REPORT_FILE = "SILPI-GENERATION.md";
// Sub-folders where generated full-stack projects may keep their own package.json.
const SUB_PACKAGES = ["frontend", "client", "web", "backend", "server", "api"];

type PackageJson = {
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** First paragraph after the "# ..." heading of SILPI-GENERATION.md. */
async function readReportSummary(projectDir: string): Promise<string | null> {
  try {
    const text = await readFile(path.join(projectDir, REPORT_FILE), "utf8");
    const paragraph = text
      .split(/\r?\n\s*\r?\n/)
      .map((block) => block.trim())
      .find((block) => block && !block.startsWith("#"));
    if (!paragraph) return null;
    const flat = paragraph.replace(/\s+/g, " ");
    return flat.length > 240 ? `${flat.slice(0, 237)}...` : flat;
  } catch {
    return null;
  }
}

async function collectDependencies(projectDir: string) {
  const deps = new Set<string>();
  let description: string | undefined;

  for (const dir of ["", ...SUB_PACKAGES]) {
    const pkg = await readJson<PackageJson>(path.join(projectDir, dir, "package.json"));
    if (!pkg) continue;
    description ??= pkg.description;
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      deps.add(name);
    }
  }

  let composer: string[] = [];
  for (const dir of ["", ...SUB_PACKAGES]) {
    const file = await readJson<{ require?: Record<string, string> }>(
      path.join(projectDir, dir, "composer.json"),
    );
    if (file) {
      composer = Object.keys(file.require ?? {});
      break;
    }
  }

  return { deps, composer, hasComposer: composer.length > 0, description };
}

function detectStack(
  deps: Set<string>,
  composer: string[],
  hasComposer: boolean,
  hasIndexHtml: boolean,
) {
  const has = (name: string) => deps.has(name);

  const frontend = has("next")
    ? "Next.js"
    : has("@angular/core")
      ? "Angular"
      : has("vue")
        ? "Vue.js"
        : has("react")
          ? "React"
          : hasIndexHtml
            ? "HTML / CSS / JS"
            : NONE;

  const backend = has("express")
    ? "Node.js + Express"
    : composer.includes("laravel/framework")
      ? "Laravel"
      : hasComposer
        ? "PHP"
        : NONE;

  const database =
    has("mysql2") || has("mysql")
      ? "MySQL"
      : has("pg")
        ? "PostgreSQL"
        : has("mongoose") || has("mongodb")
          ? "MongoDB"
          : has("sqlite3") || has("better-sqlite3")
            ? "SQLite"
            : NONE;

  return { frontend, backend, database };
}

type SilpiMeta = {
  stack?: { frontend?: string[]; backend?: string[]; database?: string[] };
  history?: Array<{ at?: string; success?: boolean; buildPassed?: boolean | null }>;
};

/** True while a silpi-agent process holds the project's lock file. */
async function isGenerating(projectDir: string): Promise<boolean> {
  const pid = Number.parseInt(
    await readFile(path.join(projectDir, ".silpi", "running.lock"), "utf8").catch(() => ""),
    10,
  );
  if (!Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readProject(outputRoot: string, name: string): Promise<Project> {
  const projectDir = path.join(outputRoot, name);
  const [info, summary, hasReport, hasIndexHtml, collected, meta, generating] = await Promise.all([
    stat(projectDir),
    readReportSummary(projectDir),
    exists(path.join(projectDir, REPORT_FILE)),
    exists(path.join(projectDir, "index.html")),
    collectDependencies(projectDir),
    readJson<SilpiMeta>(path.join(projectDir, ".silpi", "meta.json")),
    isGenerating(projectDir),
  ]);

  const detected = detectStack(
    collected.deps,
    collected.composer,
    collected.hasComposer,
    hasIndexHtml,
  );
  // Prefer the stack the user chose (stored by silpi-agent); fall back to detection.
  const chosen = (values?: string[]) => (values?.length ? values.join(", ") : null);
  const stack = {
    frontend: chosen(meta?.stack?.frontend) ?? detected.frontend,
    backend: chosen(meta?.stack?.backend) ?? detected.backend,
    database: chosen(meta?.stack?.database) ?? detected.database,
  };

  const hasSource = collected.deps.size > 0 || collected.hasComposer || hasIndexHtml;
  const lastRun = meta?.history?.at(-1);
  const healthy = hasReport && hasSource && (lastRun ? lastRun.success !== false && lastRun.buildPassed !== false : true);

  return {
    id: name,
    name,
    description: summary ?? collected.description ?? (generating ? "SILPI is building this project..." : "No generation report found."),
    ...stack,
    status: generating ? "Generating" : healthy ? "Ready" : "Needs attention",
    updatedAt: (lastRun?.at && !generating ? new Date(lastRun.at) : info.mtime).toISOString(),
    path: projectDir,
  };
}

/** Checks only whether a key is present; the value is never read into a response. */
async function hasApiKey(agentDir: string): Promise<boolean> {
  const env = await readFile(path.join(agentDir, ".env"), "utf8").catch(() => "");
  return /^[ \t]*ANTHROPIC_API_KEY[ \t]*=[ \t]*["']?[^\s"'#]+/m.test(env);
}

async function getAgentInfo(agentDir: string | null): Promise<AgentInfo> {
  if (!agentDir) return { configured: false, built: false, hasApiKey: false };
  const [built, key] = await Promise.all([exists(getAgentCliPath(agentDir)), hasApiKey(agentDir)]);
  return { configured: true, built, hasApiKey: key };
}

export async function GET() {
  const agentDir = getAgentDir();
  const agent = await getAgentInfo(agentDir);

  if (!agentDir) {
    return NextResponse.json<ProjectsResponse>({
      success: false,
      error: "SILPI_AGENT_DIR is not configured in frontend-2/.env.local.",
      agent,
      projects: [],
    });
  }

  const outputRoot = getOutputRoot(agentDir);

  let entries;
  try {
    entries = await readdir(outputRoot, { withFileTypes: true });
  } catch (error) {
    // No output folder yet simply means nothing has been generated.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json<ProjectsResponse>({ success: true, agent, outputRoot, projects: [] });
    }
    console.error("SILPI PROJECT LIST ERROR:", error);
    return NextResponse.json<ProjectsResponse>(
      { success: false, error: "Could not read the generated projects folder.", agent, outputRoot, projects: [] },
      { status: 500 },
    );
  }

  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);

  const results = await Promise.allSettled(names.map((name) => readProject(outputRoot, name)));
  const projects = results
    .filter((result): result is PromiseFulfilledResult<Project> => result.status === "fulfilled")
    .map((result) => result.value)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return NextResponse.json<ProjectsResponse>({ success: true, agent, outputRoot, projects });
}

import { existsSync } from "node:fs";
import path from "node:path";

/** Sub-folders where a generated full-stack project keeps its website (the same list as the My projects page). Fixed names only. */
export const WEB_SUBDIRS = ["frontend", "client", "web", "app", "site"] as const;

/**
 * The folder to build and show for a generated project: the project folder itself when it has a package.json,
 * otherwise the first website sub-folder that has one (for example `frontend/` beside a `backend/`). (server-only)
 */
export function appDirOf(projectDir: string): string {
  if (existsSync(path.join(projectDir, "package.json"))) return projectDir;
  for (const name of WEB_SUBDIRS) {
    const candidate = path.join(projectDir, name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  return projectDir;
}

/** True when the project keeps a separate server (backend/api/server) next to its website, which a demo does not run. */
export function hasSeparateBackend(projectDir: string): boolean {
  return ["backend", "server", "api"].some((name) => existsSync(path.join(projectDir, name, "package.json")));
}

import path from "node:path";

/**
 * Server-only helpers for locating the SILPI agent and its output folder.
 * Shared by every projects route so they always agree on paths.
 */

export function getAgentDir(): string | null {
  const agentDir = process.env.SILPI_AGENT_DIR;
  return agentDir ? path.resolve(agentDir) : null;
}

export function getAgentCliPath(agentDir: string): string {
  return path.join(agentDir, "dist", "cli.js");
}

/**
 * SILPI_OUTPUT_DIR is resolved relative to the agent folder, matching how
 * the agent itself resolves it. Defaults to ../generated-projects.
 */
export function getOutputRoot(agentDir: string): string {
  return path.resolve(
    agentDir,
    process.env.SILPI_OUTPUT_DIR || "../generated-projects",
  );
}

export const PROJECT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/;

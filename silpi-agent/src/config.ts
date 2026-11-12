import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/** Root of the silpi-agent package (one level above src/ or dist/). */
export const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// quiet: stdout carries the NDJSON event stream, so dotenv must not print to it.
dotenv.config({ path: path.join(AGENT_ROOT, ".env"), quiet: true });

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

function readInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readEffort(): Effort {
  const value = process.env.SILPI_EFFORT;
  return (EFFORTS as readonly string[]).includes(value ?? "") ? (value as Effort) : "high";
}

export const config = {
  model: process.env.SILPI_MODEL || "claude-opus-5-5",
  effort: readEffort(),
  /** Hard stop for one run, counted in model turns. */
  maxTurns: readInt("SILPI_MAX_TURNS", 150),
  maxOutputTokens: 64_000,
  outputDir: path.resolve(AGENT_ROOT, process.env.SILPI_OUTPUT_DIR || "../generated-projects"),
  commandTimeoutMs: readInt("SILPI_COMMAND_TIMEOUT_MS", 10 * 60 * 1000),
  installTimeoutMs: readInt("SILPI_INSTALL_TIMEOUT_MS", 15 * 60 * 1000),
};

export const PROJECT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/;

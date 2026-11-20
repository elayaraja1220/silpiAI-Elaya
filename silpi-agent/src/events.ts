import path from "node:path";

import type { SmokeTarget } from "./smoke.js";

/**
 * Progress events. With --json each event is written to stdout as one JSON
 * line (NDJSON); the SILPI frontend streams these straight to the browser.
 */
export type AgentEvent =
  | {
      type: "start";
      mode: "create" | "edit" | "resume";
      project: string;
      path: string;
      model: string;
      sandbox: "local" | "docker";
      budgetUsd: number;
    }
  | { type: "status"; message: string }
  | { type: "message"; text: string }
  | { type: "action"; tool: string; label: string }
  | { type: "result"; tool: string; ok: boolean; label: string; detail?: string }
  | {
      type: "usage";
      turn: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      /** Cost of this turn in USD. */
      costUsd: number;
      /** Cost of this run so far in USD. */
      totalCostUsd: number;
    }
  | { type: "smoke"; ran: boolean; ok: boolean; note?: string; targets: SmokeTarget[] }
  | {
      type: "done";
      success: boolean;
      summary: string;
      path: string;
      filesChanged: string[];
      turns: number;
      buildPassed: boolean | null;
      /** null = the app was not started (static site, non-Node stack, or the build failed). */
      appStarted: boolean | null;
      costUsd: number;
      /** True when the run stopped early and can continue with a resume task. */
      resumable: boolean;
    }
  | { type: "error"; message: string };

export type Emit = (event: AgentEvent) => void;

const COLORS = { dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", reset: "\x1b[0m" };

function pretty(event: AgentEvent): string | null {
  switch (event.type) {
    case "start":
      return `${COLORS.cyan}SILPI ${event.mode}: ${event.project}${COLORS.reset} -> ${event.path} (${event.model}, ${event.sandbox} sandbox, budget $${event.budgetUsd})`;
    case "status":
      return `${COLORS.dim}${event.message}${COLORS.reset}`;
    case "message":
      return `\n${event.text}\n`;
    case "action":
      return `  -> ${event.label}`;
    case "result":
      return event.ok
        ? `     ${COLORS.green}ok${COLORS.reset} ${event.label}`
        : `     ${COLORS.red}failed${COLORS.reset} ${event.label}${event.detail ? `\n${event.detail}` : ""}`;
    case "usage":
      return null;
    case "smoke":
      if (!event.ran) return `${COLORS.dim}  App start check skipped: ${event.note ?? ""}${COLORS.reset}`;
      return `  App start check: ${event.ok ? `${COLORS.green}ok${COLORS.reset}` : `${COLORS.red}failed${COLORS.reset}`} ${event.targets
        .map((t) => `${t.folder || "root"}: ${t.ok ? (t.url ?? "ok") : (t.detail.split("\n")[0] ?? "")}`)
        .join("; ")}`;
    case "done": {
      const cost = `$${event.costUsd.toFixed(2)}`;
      return event.success
        ? `\n${COLORS.green}Done${COLORS.reset} in ${event.turns} turns, ${cost}. ${event.filesChanged.length} files changed.\n${event.path}`
        : `\n${COLORS.red}Finished with problems${COLORS.reset} after ${event.turns} turns, ${cost}.${
            event.resumable ? ` Continue with: silpi-agent resume ${path.basename(event.path)}` : ""
          }\n${event.path}`;
    }
    case "error":
      return `${COLORS.red}Error:${COLORS.reset} ${event.message}`;
  }
}

export function createEmitter(json: boolean): Emit {
  return (event) => {
    if (json) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      return;
    }
    const line = pretty(event);
    if (line !== null) console.log(line);
  };
}

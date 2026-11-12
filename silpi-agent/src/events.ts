/**
 * Progress events. With --json each event is written to stdout as one JSON
 * line (NDJSON); the SILPI frontend streams these straight to the browser.
 */
export type AgentEvent =
  | { type: "start"; mode: "create" | "edit"; project: string; path: string; model: string }
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
    }
  | {
      type: "done";
      success: boolean;
      summary: string;
      path: string;
      filesChanged: string[];
      turns: number;
      buildPassed: boolean | null;
    }
  | { type: "error"; message: string };

export type Emit = (event: AgentEvent) => void;

const COLORS = { dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", reset: "\x1b[0m" };

function pretty(event: AgentEvent): string | null {
  switch (event.type) {
    case "start":
      return `${COLORS.cyan}SILPI ${event.mode}: ${event.project}${COLORS.reset} -> ${event.path} (${event.model})`;
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
    case "done":
      return event.success
        ? `\n${COLORS.green}Done${COLORS.reset} in ${event.turns} turns. ${event.filesChanged.length} files changed.\n${event.path}`
        : `\n${COLORS.red}Finished with problems${COLORS.reset} after ${event.turns} turns.\n${event.path}`;
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

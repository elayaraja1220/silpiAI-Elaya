import { spawn } from "node:child_process";

import { assertAgentReady } from "@/lib/silpi-runner";
import type { AgentEvent } from "@/types";

import { killTree } from "./claude-cli";

/**
 * Runs the SILPI agent (Anthropic API) for one approved API job (server-only).
 * This is the ONLY place a project is generated with the API. It is reached only from an API job that has an
 * approval recorded, never from a local job. The API key stays in the agent's own server-side environment.
 */

export type ApiOutcome = {
  ok: boolean;
  summary?: string;
  filesChanged?: number;
  turns?: number;
  buildPassed?: boolean | null;
  appStarted?: boolean | null;
  /** Calculated by the agent from token usage: not an invoice. */
  costUsd?: number;
  error?: string;
  exitCode?: number | null;
  cancelled?: boolean;
};

export async function runApiAgent(input: { task: Record<string, unknown>; env: NodeJS.ProcessEnv; signal: AbortSignal; onEvent: (event: AgentEvent) => void }): Promise<ApiOutcome> {
  const { agentDir, cliPath } = await assertAgentReady();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, "run", "--json"], { cwd: agentDir, env: input.env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let outcome: ApiOutcome | null = null;
    let lastError = "";
    let stderrTail = "";
    let cancelled = false;
    let settled = false;
    const onAbort = () => { cancelled = true; killTree(child); };
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
    const finish = (value: ApiOutcome) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", onAbort);
      resolve(value);
    };

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!raw) continue;
        try {
          const event = JSON.parse(raw) as AgentEvent;
          input.onEvent(event);
          if (event.type === "error") lastError = event.message;
          if (event.type === "done") {
            outcome = { ok: event.success, summary: event.summary, filesChanged: event.filesChanged.length, turns: event.turns, buildPassed: event.buildPassed, appStarted: event.appStarted, costUsd: event.costUsd };
          }
        } catch {
          input.onEvent({ type: "status", message: raw.slice(0, 300) });
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-1500); });
    child.on("error", (e) => finish({ ok: false, error: `Could not start the SILPI agent: ${e.message}`, cancelled }));
    child.on("close", (code) => {
      if (outcome) return finish({ ...outcome, exitCode: code, cancelled });
      finish({ ok: false, exitCode: code, cancelled, error: lastError || `The SILPI agent exited with code ${code ?? "unknown"}.${stderrTail.trim() ? ` ${stderrTail.trim().split("\n").slice(-2).join(" ")}` : ""}` });
    });
    child.stdin.on("error", () => { /* the agent exited before reading its task */ });
    child.stdin.end(JSON.stringify(input.task));
  });
}

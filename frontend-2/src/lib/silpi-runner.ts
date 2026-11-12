import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";

import { getAgentCliPath, getAgentDir } from "@/lib/silpi-paths";
import type { AgentEvent } from "@/types";

/**
 * Server-only. Starts the silpi-agent CLI (`run --json`), sends the task on
 * stdin and returns its NDJSON progress events as a streaming HTTP response.
 *
 * The agent keeps running if the browser disconnects: the project is still
 * generated and shows up in My projects when it finishes.
 */

export class AgentUnavailableError extends Error {}

export async function assertAgentReady(): Promise<{ agentDir: string; cliPath: string }> {
  const agentDir = getAgentDir();
  if (!agentDir) {
    throw new AgentUnavailableError("SILPI_AGENT_DIR is not configured in frontend-2/.env.local.");
  }
  const cliPath = getAgentCliPath(agentDir);
  try {
    await access(cliPath, constants.R_OK);
  } catch {
    throw new AgentUnavailableError(
      `SILPI agent is not built. Run "npm install && npm run build" in ${agentDir}.`,
    );
  }
  return { agentDir, cliPath };
}

const encoder = new TextEncoder();
const line = (event: AgentEvent) => encoder.encode(`${JSON.stringify(event)}\n`);

export async function streamAgentRun(task: Record<string, unknown>): Promise<Response> {
  const { agentDir, cliPath } = await assertAgentReady();

  const child = spawn(process.execPath, [cliPath, "run", "--json"], {
    cwd: agentDir,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let closed = false;
  let sawDone = false;
  let sawError = false;
  let stderrTail = "";

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true; // browser went away; let the agent finish anyway
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const raw = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!raw) continue;
          try {
            const event = JSON.parse(raw) as AgentEvent;
            if (event.type === "done") sawDone = true;
            if (event.type === "error") sawError = true;
            send(line(event));
          } catch {
            // Non-JSON output (should not happen) is surfaced as a status line.
            send(line({ type: "status", message: raw.slice(0, 500) }));
          }
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-4_000);
      });

      child.on("error", (error) => {
        send(line({ type: "error", message: `Could not start the SILPI agent: ${error.message}` }));
        finish();
      });

      child.on("close", (code) => {
        // The agent reports its own errors; only add one if it died silently.
        if (!sawDone && !sawError && code !== 0) {
          const detail = stderrTail.trim().split("\n").slice(-5).join("\n");
          send(line({ type: "error", message: `SILPI agent exited with code ${code ?? "unknown"}.${detail ? `\n${detail}` : ""}` }));
        }
        finish();
      });

      child.stdin.end(JSON.stringify(task));
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

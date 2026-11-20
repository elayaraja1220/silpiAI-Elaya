import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TaskError, closeDanglingToolUses, runAgent, type ModelClient } from "./agent.js";
import { config } from "./config.js";
import type { AgentEvent } from "./events.js";
import type { SmokeResult } from "./smoke.js";

type BetaMessage = Anthropic.Beta.BetaMessage;
type Params = Parameters<ModelClient["beta"]["messages"]["stream"]>[0];

let n = 0;
function reply(content: unknown[], stop_reason = "end_turn", usage = { input: 1_000, output: 500 }): BetaMessage {
  return {
    id: `msg_${++n}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_details: null,
    stop_sequence: null,
    usage: { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as BetaMessage;
}
const text = (t: string) => ({ type: "text", text: t, citations: null });
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

/** Fake model: returns the scripted replies in order and records each request. */
function fakeClient(replies: BetaMessage[]) {
  const requests: Params[] = [];
  const client: ModelClient = {
    beta: {
      messages: {
        stream(params) {
          // Snapshot: the agent keeps appending to the same array.
          requests.push({ ...params, messages: structuredClone(params.messages) });
          const next = replies.shift();
          return { finalMessage: async () => (next ? next : Promise.reject(new Error("no more scripted replies"))) };
        },
      },
    },
  };
  return { client, requests };
}

const smokeOk: SmokeResult = { ran: true, ok: true, targets: [{ folder: "", script: "start", ok: true, url: "http://127.0.0.1:1/", status: 200, detail: "Answered HTTP 200." }] };
const smokeFail: SmokeResult = { ran: true, ok: false, targets: [{ folder: "", script: "start", ok: false, detail: "exited with code 1" }] };

let outputDir: string;
const defaults = { ...config };

beforeAll(async () => {
  outputDir = await mkdtemp(path.join(os.tmpdir(), "silpi-agent-test-"));
});
afterAll(() => rm(outputDir, { recursive: true, force: true }));
beforeEach(() => {
  Object.assign(config, defaults, { outputDir, maxConcurrentRuns: 4 });
});

const collect = () => {
  const events: AgentEvent[] = [];
  return { events, emit: (e: AgentEvent) => events.push(e) };
};
const exists = (p: string) => stat(p).then(() => true, () => false);

describe("runAgent", () => {
  it("builds a project, repairs a failed app start, prices usage and records history", async () => {
    const { client, requests } = fakeClient([
      reply([toolUse("t1", "write_file", { path: "index.js", content: "console.log(1)\n" })], "tool_use"),
      reply([text("Built it.")]),
      reply([text("Fixed the start script. Done.")]),
    ]);
    const smokes = [smokeFail, smokeOk];
    const { events, emit } = collect();

    const result = await runAgent(
      { mode: "create", name: "demo-app", description: "A demo", frontend: [], backend: [], database: [], styling: [], designUrl: "", attachments: [] },
      emit,
      undefined,
      { client, smokeTest: async () => smokes.shift()! },
    );

    expect(result.success).toBe(true);
    expect(result.appStarted).toBe(true);
    expect(result.resumable).toBe(false);
    expect(result.filesChanged).toEqual(["index.js"]);
    // 3 turns x (1000 in @ $4/M + 500 out @ $20/M) = 3 x $0.014
    expect(result.costUsd).toBeCloseTo(0.042, 6);
    expect(requests).toHaveLength(3);

    // The failed start check was fed back to the model as a user message.
    const third = requests[2]!.messages;
    expect(JSON.stringify(third[third.length - 1])).toContain("did not work");

    const dir = path.join(outputDir, "demo-app");
    expect(await readFile(path.join(dir, "index.js"), "utf8")).toBe("console.log(1)\n");
    expect(await exists(path.join(dir, ".silpi", "session.json"))).toBe(false);
    const meta = JSON.parse(await readFile(path.join(dir, ".silpi", "meta.json"), "utf8"));
    expect(meta.history[0]).toMatchObject({ mode: "create", success: true, appStarted: true });
    expect(events.filter((e) => e.type === "smoke")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "done", success: true });
  });

  it("marks the run failed when the app never starts", async () => {
    const { client } = fakeClient([reply([text("Done.")]), reply([text("Done again.")]), reply([text("Still done.")])]);
    const smokeCalls: number[] = [];
    const result = await runAgent(
      { mode: "create", name: "broken-app", description: "x", frontend: [], backend: [], database: [], styling: [], designUrl: "", attachments: [] },
      () => {},
      undefined,
      { client, smokeTest: async () => (smokeCalls.push(1), smokeFail) },
    );
    expect(result.success).toBe(false);
    expect(result.appStarted).toBe(false);
    expect(smokeCalls).toHaveLength(3); // first try + 2 repair attempts, then it gives up honestly
  });

  it("stops at the budget, saves the session and resumes from it", async () => {
    config.maxCostUsd = 0.001;
    // Turn 1 is cheap and writes a file; turn 2 ($0.014) crosses the budget, so its tool never runs.
    const pre = fakeClient([
      reply([toolUse("t0", "write_file", { path: "keep.txt", content: "k" })], "tool_use", { input: 10, output: 10 }),
      reply([toolUse("t1", "write_file", { path: "a.txt", content: "a" })], "tool_use"),
    ]);

    const stopped = await runAgent(
      { mode: "create", name: "budget-app", description: "x", frontend: [], backend: [], database: [], styling: [], designUrl: "", attachments: [] },
      () => {},
      undefined,
      { client: pre.client, smokeTest: async () => smokeOk },
    );
    expect(stopped.success).toBe(false);
    expect(stopped.resumable).toBe(true);

    const dir = path.join(outputDir, "budget-app");
    expect(await exists(path.join(dir, "a.txt"))).toBe(false); // tools of the over-budget turn did not run
    const session = JSON.parse(await readFile(path.join(dir, ".silpi", "session.json"), "utf8"));
    expect(session.stoppedReason).toContain("budget");
    expect(session.messages.at(-1).role).toBe("assistant");

    config.maxCostUsd = 20;
    const resume = fakeClient([reply([text("Finished after resume.")])]);
    const { events, emit } = collect();
    const resumed = await runAgent({ mode: "resume", name: "budget-app" }, emit, undefined, { client: resume.client, smokeTest: async () => smokeOk });

    expect(resumed.success).toBe(true);
    expect(resumed.costUsd).toBeGreaterThan(stopped.costUsd); // total includes the first run
    const sent = resume.requests[0]!.messages;
    const lastUser = sent[sent.length - 1]!;
    expect(lastUser.role).toBe("user");
    // The dangling tool_use from the stopped turn gets a "not run" result.
    expect(JSON.stringify(lastUser.content)).toContain('"tool_use_id":"t1"');
    expect(JSON.stringify(lastUser.content)).toContain("stopped before finishing");
    expect(events.some((e) => e.type === "status" && e.message.startsWith("Resuming"))).toBe(true);
    expect(await exists(path.join(dir, ".silpi", "session.json"))).toBe(false);
  });

  it("refuses to resume when nothing was interrupted", async () => {
    await expect(runAgent({ mode: "resume", name: "demo-app" }, () => {}, undefined, { client: fakeClient([]).client })).rejects.toThrow(TaskError);
  });

  it("does not offer resume after a refusal", async () => {
    const { client } = fakeClient([
      reply([toolUse("t0", "write_file", { path: "x.txt", content: "x" })], "tool_use"),
      reply([], "refusal"),
    ]);
    const result = await runAgent(
      { mode: "create", name: "refused-app", description: "x", frontend: [], backend: [], database: [], styling: [], designUrl: "", attachments: [] },
      () => {},
      undefined,
      { client, smokeTest: async () => smokeOk },
    );
    expect(result.success).toBe(false);
    expect(result.resumable).toBe(false);
  });
});

describe("closeDanglingToolUses", () => {
  it("answers tool calls left without results", () => {
    const out = closeDanglingToolUses([
      { role: "user", content: "hi" },
      { role: "assistant", content: [toolUse("a", "read_file", { path: "x" }) as Anthropic.Beta.BetaToolUseBlock] },
    ]);
    expect(out).toEqual([expect.objectContaining({ type: "tool_result", tool_use_id: "a", is_error: true })]);
    expect(closeDanglingToolUses([{ role: "user", content: "hi" }])).toEqual([]);
  });
});

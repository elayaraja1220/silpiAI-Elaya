import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

import { config } from "./config.js";
import type { Emit } from "./events.js";
import { costUsd, isKnownModel } from "./pricing.js";
import { SYSTEM_PROMPT, buildCreatePrompt, buildEditPrompt, buildResumePrompt } from "./prompts.js";
import { acquireRunSlot, isAlive } from "./queue.js";
import { describeSmoke, smokeTest as realSmokeTest, type SmokeResult } from "./smoke.js";
import type { CreateTask, EditTask, ProjectMeta, Task, TaskAttachment } from "./task.js";
import { RunState, executeTool, toolDefinitions } from "./tools.js";
import { listTree } from "./workspace.js";

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;
type BetaToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

export type RunResult = {
  success: boolean;
  summary: string;
  path: string;
  filesChanged: string[];
  turns: number;
  buildPassed: boolean | null;
  appStarted: boolean | null;
  costUsd: number;
  resumable: boolean;
};

/** The part of the Anthropic client the loop uses; tests pass a fake. */
export type ModelClient = {
  beta: {
    messages: {
      stream(params: StreamParams, options?: { signal?: AbortSignal }): { finalMessage(): Promise<BetaMessage> };
    };
  };
};

export type AgentDeps = {
  client?: ModelClient;
  smokeTest?: (projectDir: string, signal?: AbortSignal) => Promise<SmokeResult>;
};

const BETAS: Anthropic.Beta.AnthropicBeta[] = [
  // Re-runs a declined request on a suitable fallback model inside the same call.
  "server-side-fallback-2026-07-01",
  // Summarises older context server-side when a long build session fills the window.
  "compact-2026-01-12",
];

const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  ...toolDefinitions,
  // Server-side: lets Claude read a design reference URL the user supplied.
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 },
];

const META_DIR = ".silpi";
const LOCK_FILE = "running.lock";
const SESSION_FILE = "session.json";
const REPORT_FILE = "SILPI-GENERATION.md";
/** Share of the budget after which the model is told to wrap up. */
const BUDGET_WARN_AT = 0.8;
/** Times the model is asked to fix an app that builds but does not start. */
const MAX_SMOKE_REPAIRS = 2;

export class TaskError extends Error {}
class BudgetError extends TaskError {}

/**
 * Saved after every turn so an interrupted run (crash, budget, turn limit,
 * API outage) can continue with a `resume` task instead of starting over.
 */
type Session = {
  version: 1;
  /** The original create/edit task, without attachment data (that lives in messages). */
  task: CreateTask | EditTask;
  model: string;
  messages: BetaMessageParam[];
  turns: number;
  costUsd: number;
  changedFiles: string[];
  buildPassed: boolean | null;
  stoppedReason?: string;
  savedAt: string;
};

// ---------------------------------------------------------------------------
// Project folder helpers
// ---------------------------------------------------------------------------

async function acquireLock(projectDir: string): Promise<() => Promise<void>> {
  const dir = path.join(projectDir, META_DIR);
  const file = path.join(dir, LOCK_FILE);
  await mkdir(dir, { recursive: true });
  const existing = Number.parseInt(await readFile(file, "utf8").catch(() => ""), 10);
  if (Number.isFinite(existing) && existing !== process.pid && isAlive(existing)) {
    throw new TaskError("SILPI is already working on this project. Wait for that run to finish.");
  }
  await writeFile(file, String(process.pid), "utf8");
  return () => rm(file, { force: true });
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Write via a temp file so a crash mid-write never leaves corrupt JSON. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value), "utf8");
  await rename(tmp, file);
}

const readMeta = (projectDir: string) => readJson<ProjectMeta>(path.join(projectDir, META_DIR, "meta.json"));
const writeMeta = (projectDir: string, meta: ProjectMeta) =>
  writeFile(path.join(projectDir, META_DIR, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
const sessionPath = (projectDir: string) => path.join(projectDir, META_DIR, SESSION_FILE);

/** First paragraph of the final message, used as the project description in the UI. */
function firstParagraph(text: string): string {
  const paragraph = text
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .find((block) => block && !block.startsWith("#"));
  return (paragraph ?? "").replace(/\s+/g, " ");
}

function verdict(value: boolean | null, pass: string, fail: string): string {
  return value === true ? pass : value === false ? fail : "not run";
}

async function writeReport(
  projectDir: string,
  mode: Task["mode"],
  finalText: string,
  result: Omit<RunResult, "summary" | "path" | "success" | "resumable">,
  smoke: SmokeResult | null,
): Promise<void> {
  const body = [
    "# SILPI generation report",
    "",
    finalText.trim() || "SILPI did not produce a summary for this run.",
    "",
    "---",
    "",
    `- Last run: ${mode} on ${new Date().toISOString()}`,
    `- Build / checks: ${verdict(result.buildPassed, "passed", "FAILED - see the notes above")}`,
    `- App start check: ${verdict(result.appStarted, "the app started and answered HTTP", "the app did NOT start - see below")}`,
    ...(smoke ? ["", "```", describeSmoke(smoke), "```", ""] : []),
    `- Files changed in this run: ${result.filesChanged.length}`,
    `- Model turns: ${result.turns}`,
    `- API cost of this run: $${result.costUsd.toFixed(2)} (budget $${config.maxCostUsd})`,
    `- Command sandbox: ${config.sandbox}`,
    "",
    "> Generated code must be reviewed, configured and tested before production use.",
    "",
  ].join("\n");
  await writeFile(path.join(projectDir, REPORT_FILE), body, "utf8");
}

function toContentBlocks(attachments: TaskAttachment[]): BetaContentBlockParam[] {
  return attachments.map((file): BetaContentBlockParam => {
    if (file.mediaType === "application/pdf") {
      return { type: "document", title: file.name, source: { type: "base64", media_type: "application/pdf", data: file.data } };
    }
    if (file.mediaType.startsWith("image/")) {
      return {
        type: "image",
        source: { type: "base64", media_type: file.mediaType as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: file.data },
      };
    }
    return {
      type: "document",
      title: file.name,
      source: { type: "text", media_type: "text/plain", data: Buffer.from(file.data, "base64").toString("utf8") },
    };
  });
}

/**
 * A run stopped right after the model asked for tools leaves tool_use blocks
 * without results; the API requires a result for each, so mark them not run.
 */
export function closeDanglingToolUses(messages: BetaMessageParam[]): BetaToolResultBlockParam[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || typeof last.content === "string") return [];
  return last.content
    .filter((block): block is BetaToolUseBlock => block.type === "tool_use")
    .map((block) => ({
      type: "tool_result" as const,
      tool_use_id: block.id,
      is_error: true,
      content: "Not run: the previous run stopped before this tool ran. Check the current files and call it again if it is still needed.",
    }));
}

function errorMessage(error: unknown): string {
  return error instanceof Anthropic.AuthenticationError
    ? "Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY in silpi-agent/.env."
    : error instanceof Anthropic.RateLimitError
      ? "Anthropic rate limit reached. Wait a minute and resume."
      : error instanceof Anthropic.APIError
        ? `Anthropic API error ${error.status ?? ""}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export async function runAgent(task: Task, emit: Emit, signal?: AbortSignal, deps: AgentDeps = {}): Promise<RunResult> {
  if (!deps.client && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new TaskError("Anthropic API key is not set. Add ANTHROPIC_API_KEY=... to silpi-agent/.env.");
  }
  const projectDir = path.join(config.outputDir, task.name);
  const exists = await readdir(projectDir).then(
    (entries) => entries.filter((e) => e !== META_DIR).length > 0,
    () => false,
  );

  if (task.mode === "create" && exists) {
    throw new TaskError(`A project named "${task.name}" already exists. Choose another name or edit the existing project.`);
  }
  if (task.mode !== "create" && !exists) {
    throw new TaskError(`Project "${task.name}" was not found in ${config.outputDir}.`);
  }

  let saved: Session | null = null;
  if (task.mode === "resume") {
    saved = await readJson<Session>(sessionPath(projectDir));
    if (!saved || saved.version !== 1 || !Array.isArray(saved.messages) || saved.messages.length === 0) {
      throw new TaskError(`There is no interrupted run to resume for "${task.name}". Start an edit instead.`);
    }
  }

  await mkdir(projectDir, { recursive: true });
  const releaseLock = await acquireLock(projectDir);
  let releaseSlot: (() => Promise<void>) | null = null;
  const releaseAll = async () => {
    await releaseSlot?.();
    releaseSlot = null;
    await releaseLock();
  };

  // A resumed session keeps its original model so its thinking blocks stay valid.
  const model = saved?.model ?? config.model;
  const originalTask: CreateTask | EditTask = saved ? saved.task : (task as CreateTask | EditTask);

  const state = new RunState();
  for (const file of saved?.changedFiles ?? []) state.changedFiles.add(file);
  if (saved) state.buildPassed = saved.buildPassed;

  const previousCost = saved?.costUsd ?? 0;
  let runCost = 0;
  let turns = 0;
  let finalText = "";
  let success = false;
  let resumable = false;
  let smoke: SmokeResult | null = null;
  let smokeRepairs = 0;
  let warnedBudget = false;
  let refused = false;
  let messages: BetaMessageParam[] = [];

  const saveSession = async (stoppedReason?: string) => {
    const session: Session = {
      version: 1,
      task: { ...originalTask, attachments: [] },
      model,
      messages,
      turns: (saved?.turns ?? 0) + turns,
      costUsd: previousCost + runCost,
      changedFiles: [...state.changedFiles],
      buildPassed: state.buildPassed,
      stoppedReason,
      savedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(sessionPath(projectDir), session);
  };

  try {
    releaseSlot = await acquireRunSlot(emit, signal);
    emit({ type: "start", mode: task.mode, project: task.name, path: projectDir, model, sandbox: config.sandbox, budgetUsd: config.maxCostUsd });
    if (!isKnownModel(model)) {
      emit({ type: "status", message: `No price list for model "${model}"; costs are estimated at the highest known rate.` });
    }

    if (saved) {
      messages = saved.messages;
      messages.push({
        role: "user",
        content: [
          ...closeDanglingToolUses(messages),
          { type: "text", text: buildResumePrompt(saved.stoppedReason, await listTree(projectDir, projectDir, 2, 200)) },
        ],
      });
      emit({
        type: "status",
        message: `Resuming the run stopped ${saved.stoppedReason ? `by: ${saved.stoppedReason}` : "earlier"} (already spent $${previousCost.toFixed(2)}).`,
      });
    } else {
      const t = task as CreateTask | EditTask;
      const attachmentNames = t.attachments.map((a) => a.name);
      const prompt =
        t.mode === "create"
          ? buildCreatePrompt(t, attachmentNames)
          : buildEditPrompt(t, await readMeta(projectDir), await listTree(projectDir, projectDir, 2, 200), attachmentNames);
      messages = [{ role: "user", content: [...toContentBlocks(t.attachments), { type: "text", text: prompt }] }];
      emit({ type: "status", message: t.mode === "create" ? "Planning the project..." : "Reviewing the project..." });
    }
    await saveSession();

    const client: ModelClient = deps.client ?? new Anthropic({ maxRetries: 4 });
    const runSmoke = deps.smokeTest ?? realSmokeTest;
    let parseRetries = 0;

    while (turns < config.maxTurns) {
      if (signal?.aborted) throw new TaskError("Run cancelled.");
      turns++;

      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: config.maxOutputTokens,
          system: [{ type: "text", text: SYSTEM_PROMPT }],
          tools: TOOLS,
          messages,
          thinking: { type: "adaptive" },
          output_config: { effort: config.effort },
          // Caches the growing conversation prefix between turns.
          cache_control: { type: "ephemeral" },
          context_management: { edits: [{ type: "compact_20260112" }] },
          fallbacks: "default",
          betas: BETAS,
        },
        { signal },
      );

      let message: BetaMessage;
      try {
        message = await stream.finalMessage();
        parseRetries = 0;
      } catch (error) {
        // Only a tool input that could not be parsed at all is retried here;
        // API errors (already retried by the SDK) propagate.
        if (error instanceof Anthropic.APIError || parseRetries++ >= 2) throw error;
        emit({ type: "status", message: "A tool call arrived malformed, retrying the turn..." });
        turns--;
        continue;
      }

      const u = message.usage;
      const usage = {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      };
      // A fallback may have served the turn, so price by the model that answered.
      const turnCost = costUsd(message.model || model, usage);
      runCost += turnCost;
      emit({ type: "usage", turn: turns, ...usage, costUsd: turnCost, totalCostUsd: runCost });

      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      // Full content goes back each turn: thinking, compaction and fallback
      // blocks must be preserved for the API.
      messages.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "refusal") {
        refused = true;
        throw new TaskError(
          `The model declined this request${message.stop_details?.category ? ` (${message.stop_details.category})` : ""}. Try rephrasing the brief.`,
        );
      }

      if (runCost >= config.maxCostUsd) {
        throw new BudgetError(
          `Stopped: this run reached its budget of $${config.maxCostUsd.toFixed(2)} (spent $${runCost.toFixed(2)}). ` +
            "Resume to continue with a fresh budget, or raise SILPI_MAX_COST_USD.",
        );
      }

      if (message.stop_reason === "pause_turn") continue; // server tool paused; resume

      const toolUses = message.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");

      if (toolUses.length === 0) {
        if (message.stop_reason === "max_tokens") {
          messages.push({ role: "user", content: "Your reply was cut off. Continue where you left off." });
          continue;
        }
        if (text) emit({ type: "message", text });

        // The model says it is done: prove the app actually starts.
        if (state.buildPassed !== false) {
          emit({ type: "status", message: "Starting the app to check that it serves pages..." });
          smoke = await runSmoke(projectDir, signal);
          emit({ type: "smoke", ...smoke });
          if (smoke.ran && !smoke.ok && smokeRepairs < MAX_SMOKE_REPAIRS) {
            smokeRepairs++;
            messages.push({
              role: "user",
              content:
                "SILPI started the app after your final message and it did not work:\n\n" +
                `${describeSmoke(smoke)}\n\n` +
                "Find the cause (start script, PORT handling, missing build output, runtime error), fix it, " +
                "re-run the build, then send your final message again.",
            });
            await saveSession();
            continue;
          }
        }

        finalText = text;
        success = state.buildPassed !== false && (smoke === null || !smoke.ran || smoke.ok);
        break;
      }

      if (text) emit({ type: "message", text });

      let results: Array<BetaToolResultBlockParam | Anthropic.Beta.BetaTextBlockParam>;
      if (message.stop_reason === "max_tokens") {
        // The last tool input was truncated - never run a half-written file.
        results = toolUses.map((tool) => ({
          type: "tool_result" as const,
          tool_use_id: tool.id,
          is_error: true,
          content: "Not run: the response hit the output limit, so this input may be incomplete. Split large files into smaller ones and send the call again.",
        }));
      } else {
        // Tools run one at a time: writes and builds must not interleave.
        results = [];
        for (const tool of toolUses) {
          const outcome = await executeTool(projectDir, tool.name, tool.input, state, emit);
          results.push({ type: "tool_result", tool_use_id: tool.id, content: outcome.content, is_error: outcome.isError });
        }
      }
      if (!warnedBudget && runCost >= config.maxCostUsd * BUDGET_WARN_AT) {
        warnedBudget = true;
        emit({ type: "status", message: `80% of this run's $${config.maxCostUsd} budget is used. Asking SILPI to wrap up.` });
        results.push({
          type: "text",
          text:
            `Budget notice: about ${Math.round(BUDGET_WARN_AT * 100)}% of this run's budget is used. ` +
            "Finish the most important remaining work, make sure the build passes, and send your final message soon. " +
            "List anything unfinished under known limitations.",
        });
      }
      messages.push({ role: "user", content: results });
      await saveSession();
    }

    if (!finalText) {
      throw new TaskError(`Stopped after ${config.maxTurns} turns without finishing. Resume to continue from where it stopped.`);
    }
  } catch (error) {
    const message = errorMessage(error);
    emit({ type: "error", message });
    finalText ||= `The run stopped before finishing: ${message}`;
    success = false;
    // Everything except a missing key or a refusal can be continued later.
    resumable = messages.length > 0 && !refused && !(error instanceof Anthropic.AuthenticationError);
    if (resumable) await saveSession(message).catch(() => undefined);
  }

  const filesChanged = [...state.changedFiles].sort();
  const appStarted = smoke && smoke.ran ? smoke.ok : null;
  const totalCost = previousCost + runCost;
  const partial = { success, filesChanged, turns, buildPassed: state.buildPassed, appStarted, costUsd: totalCost, resumable };

  // A new project that failed before writing anything leaves no folder behind,
  // so the same name can be used again.
  if (task.mode === "create" && !success && filesChanged.length === 0) {
    await releaseAll();
    await rm(projectDir, { recursive: true, force: true });
    const result: RunResult = { ...partial, resumable: false, summary: "", path: projectDir };
    emit({ type: "done", ...result });
    return result;
  }

  try {
    if (success || !resumable) await rm(sessionPath(projectDir), { force: true });
    await writeReport(projectDir, task.mode, finalText, { filesChanged, turns, buildPassed: state.buildPassed, appStarted, costUsd: totalCost }, smoke);
    const now = new Date().toISOString();
    const meta: ProjectMeta = (await readMeta(projectDir)) ?? {
      name: task.name,
      description: originalTask.mode === "create" ? originalTask.description : "",
      stack:
        originalTask.mode === "create"
          ? { frontend: originalTask.frontend, backend: originalTask.backend, database: originalTask.database, styling: originalTask.styling }
          : { frontend: [], backend: [], database: [], styling: [] },
      designUrl: originalTask.mode === "create" ? originalTask.designUrl || undefined : undefined,
      createdAt: now,
      history: [],
    };
    meta.history.push({
      mode: task.mode,
      request: (originalTask.mode === "create" ? originalTask.description : originalTask.instruction).slice(0, 2_000),
      at: now,
      success,
      buildPassed: state.buildPassed,
      filesChanged: filesChanged.length,
      turns,
      costUsd: Number(runCost.toFixed(4)),
      appStarted,
    });
    await writeMeta(projectDir, meta);
  } finally {
    await releaseAll();
  }

  const result: RunResult = { ...partial, summary: firstParagraph(finalText), path: projectDir };
  emit({ type: "done", ...result });
  return result;
}

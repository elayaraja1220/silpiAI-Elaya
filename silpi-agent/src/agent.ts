import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

import { config } from "./config.js";
import type { Emit } from "./events.js";
import { SYSTEM_PROMPT, buildCreatePrompt, buildEditPrompt } from "./prompts.js";
import type { ProjectMeta, Task, TaskAttachment } from "./task.js";
import { RunState, executeTool, toolDefinitions } from "./tools.js";
import { listTree } from "./workspace.js";

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;
type BetaToolUseBlock = Anthropic.Beta.BetaToolUseBlock;

export type RunResult = {
  success: boolean;
  summary: string;
  path: string;
  filesChanged: string[];
  turns: number;
  buildPassed: boolean | null;
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
const REPORT_FILE = "SILPI-GENERATION.md";

export class TaskError extends Error {}

// ---------------------------------------------------------------------------
// Project folder helpers
// ---------------------------------------------------------------------------

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

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

async function readMeta(projectDir: string): Promise<ProjectMeta | null> {
  try {
    return JSON.parse(await readFile(path.join(projectDir, META_DIR, "meta.json"), "utf8")) as ProjectMeta;
  } catch {
    return null;
  }
}

async function writeMeta(projectDir: string, meta: ProjectMeta): Promise<void> {
  await writeFile(path.join(projectDir, META_DIR, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

/** First paragraph of the final message, used as the project description in the UI. */
function firstParagraph(text: string): string {
  const paragraph = text
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .find((block) => block && !block.startsWith("#"));
  return (paragraph ?? "").replace(/\s+/g, " ");
}

async function writeReport(projectDir: string, task: Task, finalText: string, result: Omit<RunResult, "summary" | "path">): Promise<void> {
  const verdict =
    result.buildPassed === true ? "passed" : result.buildPassed === false ? "FAILED - see the notes below" : "not run";
  const body = [
    "# SILPI generation report",
    "",
    finalText.trim() || "SILPI did not produce a summary for this run.",
    "",
    "---",
    "",
    `- Last run: ${task.mode} on ${new Date().toISOString()}`,
    `- Build / checks: ${verdict}`,
    `- Files changed in this run: ${result.filesChanged.length}`,
    `- Model turns: ${result.turns}`,
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

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export async function runAgent(task: Task, emit: Emit, signal?: AbortSignal): Promise<RunResult> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
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
  if (task.mode === "edit" && !exists) {
    throw new TaskError(`Project "${task.name}" was not found in ${config.outputDir}.`);
  }

  await mkdir(projectDir, { recursive: true });
  const releaseLock = await acquireLock(projectDir);
  emit({ type: "start", mode: task.mode, project: task.name, path: projectDir, model: config.model });

  const state = new RunState();
  let turns = 0;
  let finalText = "";
  let success = false;

  try {
    const existingMeta = await readMeta(projectDir);
    const attachmentNames = task.attachments.map((a) => a.name);
    const prompt =
      task.mode === "create"
        ? buildCreatePrompt(task, attachmentNames)
        : buildEditPrompt(task, existingMeta, await listTree(projectDir, projectDir, 2, 200), attachmentNames);

    const messages: BetaMessageParam[] = [
      { role: "user", content: [...toContentBlocks(task.attachments), { type: "text", text: prompt }] },
    ];

    const client = new Anthropic({ maxRetries: 4 });
    let parseRetries = 0;

    emit({ type: "status", message: task.mode === "create" ? "Planning the project..." : "Reviewing the project..." });

    while (turns < config.maxTurns) {
      if (signal?.aborted) throw new TaskError("Run cancelled.");
      turns++;

      const stream = client.beta.messages.stream(
        {
          model: config.model,
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
      emit({
        type: "usage",
        turn: turns,
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      });

      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      // Full content goes back each turn: thinking, compaction and fallback
      // blocks must be preserved for the API.
      messages.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "refusal") {
        throw new TaskError(
          `The model declined this request${message.stop_details?.category ? ` (${message.stop_details.category})` : ""}. Try rephrasing the brief.`,
        );
      }

      if (message.stop_reason === "pause_turn") continue; // server tool paused; resume

      const toolUses = message.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");

      if (toolUses.length === 0) {
        if (message.stop_reason === "max_tokens") {
          messages.push({ role: "user", content: "Your reply was cut off. Continue where you left off." });
          continue;
        }
        finalText = text;
        if (text) emit({ type: "message", text });
        success = state.buildPassed !== false;
        break;
      }

      if (text) emit({ type: "message", text });

      let results: BetaToolResultBlockParam[];
      if (message.stop_reason === "max_tokens") {
        // The last tool input was truncated - never run a half-written file.
        results = toolUses.map((tool) => ({
          type: "tool_result",
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
      messages.push({ role: "user", content: results });
    }

    if (!finalText) {
      throw new TaskError(`Stopped after ${config.maxTurns} turns without finishing. Run an edit to continue from the current files.`);
    }
  } catch (error) {
    const message =
      error instanceof Anthropic.AuthenticationError
        ? "Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY in silpi-agent/.env."
        : error instanceof Anthropic.RateLimitError
          ? "Anthropic rate limit reached. Wait a minute and try again."
          : error instanceof Anthropic.APIError
            ? `Anthropic API error ${error.status ?? ""}: ${error.message}`
            : error instanceof Error
              ? error.message
              : String(error);
    emit({ type: "error", message });
    finalText ||= `The run stopped before finishing: ${message}`;
    success = false;
  }

  const filesChanged = [...state.changedFiles].sort();
  const partial = { success, filesChanged, turns, buildPassed: state.buildPassed };

  // A new project that failed before writing anything leaves no folder behind,
  // so the same name can be used again.
  if (task.mode === "create" && !success && filesChanged.length === 0) {
    await releaseLock();
    await rm(projectDir, { recursive: true, force: true });
    const result: RunResult = { ...partial, summary: "", path: projectDir };
    emit({ type: "done", ...result });
    return result;
  }

  try {
    await writeReport(projectDir, task, finalText, partial);
    const now = new Date().toISOString();
    const meta: ProjectMeta = (await readMeta(projectDir)) ?? {
      name: task.name,
      description: task.mode === "create" ? task.description : "",
      stack:
        task.mode === "create"
          ? { frontend: task.frontend, backend: task.backend, database: task.database, styling: task.styling }
          : { frontend: [], backend: [], database: [], styling: [] },
      designUrl: task.mode === "create" ? task.designUrl || undefined : undefined,
      createdAt: now,
      history: [],
    };
    meta.history.push({
      mode: task.mode,
      request: (task.mode === "create" ? task.description : task.instruction).slice(0, 2_000),
      at: now,
      success,
      buildPassed: state.buildPassed,
      filesChanged: filesChanged.length,
      turns,
    });
    await writeMeta(projectDir, meta);
  } finally {
    await releaseLock();
  }

  const result: RunResult = { ...partial, summary: firstParagraph(finalText), path: projectDir };
  emit({ type: "done", ...result });
  return result;
}

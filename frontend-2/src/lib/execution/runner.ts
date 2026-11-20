import { randomBytes } from "node:crypto";

import { exportContent, type ContentExport } from "@/lib/business/asset-store";
import { buildBrief, projectNameFor } from "@/lib/business/brief";
import { getLead, getRateCard, markReadyForDelivery, StageError, startDevelopment } from "@/lib/business/store";
import type { Lead } from "@/lib/business/types";
import type { AgentEvent } from "@/types";
import { assertAgentReady } from "@/lib/silpi-runner";

import { checkApiApproval, estimateApiCost } from "./api-gate";
import { runApiAgent, type ApiOutcome } from "./api-agent";
import { localArgs, locateClaude, readAuth, runClaude, type ClaudeEvent, type ClaudeLocation, type LocateResult, type RunClaudeOptions, type RunClaudeResult } from "./claude-cli";
import { activeJobFor, appendEvent, completedApiCosts, createJob, getExecutionSettings, getJob, interruptOrphans, listEvents, listJobs, updateJob } from "./jobs";
import { ExecError, type ApiApprovalRequest, type AuthState, type ExecMode, type ExecutionSettings, type Job, type JobEvent, type Verification, type VerificationStep } from "./types";
import { runVerification } from "./verify";
import { prepareWorkspace, verifyJobWorkspace, workspaceRoot, type BriefPayload } from "./workspace";

/**
 * Project generation workflow (server-only).
 *
 *   prepare  -> the developer confirmed the approved scope; the folder and the brief are ready
 *   start    -> the developer chose Local Claude Code (default) or, with a separate cost approval, the API
 *   running  -> output is streamed into the job log; it can be cancelled
 *   finished -> tests and build ran; the developer reviews; only then can it be marked ready for delivery
 *
 * A failed local run NEVER starts an API run. The only path to the API is `startJob` with mode "api" and a valid approval.
 */

export type ApiRunInput = { task: Record<string, unknown>; env: NodeJS.ProcessEnv; signal: AbortSignal; onEvent: (event: AgentEvent) => void };

export type RunnerDeps = {
  env: NodeJS.ProcessEnv;
  getSettings: () => ExecutionSettings;
  locate: (settings: ExecutionSettings) => LocateResult;
  readAuth: (location: ClaudeLocation, env: NodeJS.ProcessEnv) => Promise<AuthState>;
  runClaude: (options: RunClaudeOptions) => Promise<RunClaudeResult>;
  runApi: (input: ApiRunInput) => Promise<ApiOutcome>;
  verify: (dir: string, signal: AbortSignal, onStep: (step: VerificationStep) => void) => Promise<Verification>;
  assertAgentReady: () => Promise<unknown>;
  workspaceRoot: () => string | null;
  /** Copies the client's content into the project folder for the generator to use. */
  exportContent: (leadId: string, dir: string) => ContentExport;
};

export const realDeps = (): RunnerDeps => ({
  env: process.env,
  getSettings: getExecutionSettings,
  locate: (s) => locateClaude(s),
  readAuth,
  runClaude,
  runApi: runApiAgent,
  verify: (dir, signal, onStep) => runVerification(dir, signal, onStep),
  assertAgentReady,
  workspaceRoot: () => workspaceRoot(),
  exportContent,
});

// ---- processes that are running now (survives hot reloads) -----------------------------------------------

const registry = globalThis as unknown as { silpiLiveJobs?: Map<string, AbortController> };
const live = () => (registry.silpiLiveJobs ??= new Map<string, AbortController>());

/** Jobs marked running whose process is gone (a server restart) are marked failed so they can be restarted. */
export function reconcile(): void {
  interruptOrphans((id) => live().has(id));
}

/** Keep secrets and long output out of anything stored or shown. */
export const safeText = (text: string, max = 400): string =>
  text.replace(/sk-ant-[\w-]+/g, "[hidden]").replace(/(authorization:\s*)?bearer\s+[\w.-]+/gi, "[hidden]").replace(/\s+/g, " ").trim().slice(0, max);

const STAGES_FOR_GENERATION = ["approved", "advance_paid", "in_development"];

// ---- 1. prepare ---------------------------------------------------------------------------------------------

export function prepareJob(leadId: string, options: { scopeConfirmed: boolean; restartOf?: string }, deps: RunnerDeps = realDeps()): Job {
  reconcile();
  const lead = getLead(leadId);
  if (!lead || !lead.quotation) throw new ExecError("lead-not-found", "That project or its quotation does not exist.", 404);
  if (!STAGES_FOR_GENERATION.includes(lead.stage)) {
    throw new ExecError("bad-stage", "Generation can start only after the client approves the quotation.", 409);
  }
  if (options.scopeConfirmed !== true) {
    throw new ExecError("scope-not-confirmed", "Confirm the approved scope before the workspace is prepared.", 400);
  }
  const existing = activeJobFor(leadId);
  if (existing && !options.restartOf) return existing;
  if (existing && options.restartOf) throw new ExecError("busy", "Another run for this project is still active.", 409);

  const root = deps.workspaceRoot();
  if (!root) throw new ExecError("no-workspace-root", "The projects folder is not configured. Set SILPI_AGENT_DIR (or SILPI_WORKSPACE_DIR) in frontend-2/.env.local.", 409);

  const previous = options.restartOf ? getJob(options.restartOf) : null;
  if (options.restartOf && (!previous || previous.leadId !== leadId)) throw new ExecError("job-not-found", "The run to restart does not exist.", 404);
  const req = lead.quotation.requirement ?? lead.requirement;
  const projectName = previous?.projectName ?? lead.projectName ?? projectNameFor(req.title, randomBytes(2).toString("hex"));

  // The brief is what the client approved: the same code that always produced it.
  const brief: BriefPayload = buildBrief(lead, getRateCard());
  const prepared = prepareWorkspace({ root, name: projectName, brief, allowExisting: Boolean(previous || lead.projectName) });
  const job = createJob({ leadId, projectName, scopeConfirmedAt: new Date().toISOString(), briefSha: prepared.briefSha, briefBytes: prepared.briefBytes, restartOf: options.restartOf ?? null });
  appendEvent(job.id, "status", `Scope confirmed. Workspace "${projectName}" and the approved brief (${prepared.briefBytes} bytes) are ready.${previous ? " This restarts an earlier run." : ""}`);
  return job;
}

// ---- 2. start -------------------------------------------------------------------------------------------------------

/** Local Claude Code must be installed and signed in with a subscription. Never falls back to anything else. */
export async function assertLocalReady(settings: ExecutionSettings, deps: RunnerDeps): Promise<ClaudeLocation> {
  const found = deps.locate(settings);
  if (!found.location) {
    throw new ExecError("cli-missing", found.problem ?? "Claude Code was not found on this computer. Install it, sign in with claude auth login, then try again. SILPI does not switch to the API by itself.", 409);
  }
  const auth = await deps.readAuth(found.location, deps.env);
  if (auth.kind === "authenticated-subscription") return found.location;
  const code = auth.kind === "not-authenticated" ? "not-authenticated" : auth.kind === "authenticated-api-key" ? "api-key-auth" : "auth-unknown";
  throw new ExecError(code, `${auth.message} SILPI does not switch to the API by itself.`, 409);
}

export type StartInput = { mode: ExecMode; withoutAdvance?: boolean; reason?: string; apiApproval?: ApiApprovalRequest };

export async function startJob(jobId: string, input: StartInput, deps: RunnerDeps = realDeps()): Promise<Job> {
  reconcile();
  const job = getJob(jobId);
  if (!job) throw new ExecError("job-not-found", "That job does not exist.", 404);
  if (job.state !== "prepared" && job.state !== "waiting-approval") throw new ExecError("bad-state", `This job is "${job.state}" and cannot be started.`, 409);
  if (input.mode !== "local" && input.mode !== "api") throw new ExecError("bad-mode", "Choose Local Claude Code or the Anthropic API.", 400);

  const lead = getLead(job.leadId);
  if (!lead || !lead.quotation) throw new ExecError("lead-not-found", "That project or its quotation does not exist.", 404);
  if (!STAGES_FOR_GENERATION.includes(lead.stage)) throw new ExecError("bad-stage", "Generation can start only after the client approves the quotation.", 409);

  const settings = deps.getSettings();
  const others = listJobs(job.leadId).filter((j) => j.id !== job.id && j.state === "running");
  if (others.length) throw new ExecError("busy", "Another run for this project is already running.", 409);

  // Every check below happens BEFORE anything changes, so a refusal leaves the project exactly as it was.
  let location: ClaudeLocation | undefined;
  let approval = null as Job["approval"];
  if (input.mode === "local") {
    location = await assertLocalReady(settings, deps);
  } else {
    if (!settings.apiEnabled) throw new ExecError("api-disabled", "API execution is turned off. Turn on API mode in Execution settings first, or use Local Claude Code.", 403);
    const estimate = estimateApiCost(completedApiCosts(), settings.apiSpendLimitUsd);
    try {
      approval = checkApiApproval(settings, estimate, input.apiApproval);
    } catch (e) {
      if (e instanceof ExecError && e.code === "approval-required" && job.state === "prepared") {
        updateJob(job.id, { state: "waiting-approval", mode: "api" });
        appendEvent(job.id, "status", "Waiting for the developer to approve the API cost.");
      }
      throw e;
    }
    await deps.assertAgentReady().catch((e: Error) => {
      throw new ExecError("agent-unavailable", e.message, 409);
    });
  }
  const root = deps.workspaceRoot();
  if (!root) throw new ExecError("no-workspace-root", "The projects folder is not configured.", 409);
  const { dir, brief } = verifyJobWorkspace(root, job.projectName, job.briefSha);

  // Whatever the client uploaded goes into the project; nothing is required, missing items get placeholders.
  const content = deps.exportContent(lead.id, dir);

  // The same advance-payment rules as before apply when the work starts.
  try {
    startDevelopment(lead.id, { withoutAdvance: input.withoutAdvance === true, reason: typeof input.reason === "string" ? input.reason.slice(0, 300) : "", suffix: "", nameFor: () => job.projectName });
  } catch (e) {
    if (e instanceof StageError) throw new ExecError("advance-required", e.message, 409);
    throw e;
  }

  const started = updateJob(job.id, { state: "running", mode: input.mode, phase: "generating", startedAt: new Date().toISOString(), finishedAt: null, error: null, approval });
  appendEvent(job.id, "status", input.mode === "local" ? "Started: local subscription execution (Claude Code on this computer)." : `Started: API-funded execution, approved up to $${approval!.limitUsd.toFixed(2)}.`);

  const placeholders = content.missing.length ? ` ${content.missing.length} not provided yet; placeholders will be used.` : "";
  appendEvent(job.id, "status", `Client content: ${content.items} item${content.items === 1 ? "" : "s"} and ${content.files} file${content.files === 1 ? "" : "s"} copied into the project.${placeholders}`);

  const controller = new AbortController();
  live().set(job.id, controller);
  void (input.mode === "local" ? executeLocal(started, dir, brief, location!, settings, controller.signal, deps, content) : executeApi(started, dir, brief, settings, controller.signal, deps)).finally(() => live().delete(job.id));
  return started;
}

// ---- local run --------------------------------------------------------------------------------------------------------

export function buildLocalPrompt(brief: BriefPayload, content?: { items: number; files: number; missing: string[] }): string {
  const tech = [
    brief.frontend.length ? `frontend ${brief.frontend.join(", ")}` : "",
    brief.backend.length ? `backend ${brief.backend.join(", ")}` : "",
    brief.database.length ? `database ${brief.database.join(", ")}` : "",
    brief.styling.length ? `styling ${brief.styling.join(", ")}` : "",
  ].filter(Boolean);
  return [
    "You are building a client project in the current folder.",
    "Read .silpi/brief.md first. It is the approved scope of an accepted quotation.",
    "",
    "Rules:",
    "- Build exactly what the brief lists. Do not build anything under \"Do NOT build\".",
    tech.length ? `- Use exactly this technology and no other: ${tech.join("; ")}.` : "- Use the technology named in the brief.",
    ...(content && content.items > 0
      ? ["- The client supplied their original content: read .silpi/client-content.md and use it exactly (their wording, logo, favicon and images from .silpi/client-assets). Copy the files you need into the site; do not invent replacements for anything they supplied. If it lists brand colours and fonts, use them as the site's palette and typography (define them once as CSS variables and load the fonts as described)."]
      : []),
    ...(content && content.missing.length > 0 ? [`- These required items were not supplied: ${content.missing.join("; ")}. Use clearly marked placeholders for them, never invented real-looking content.`] : []),
    "- Work only inside this folder. Never write real secrets: use a .env.example with placeholders.",
    "- Install dependencies, run the build (and the tests if the project has them), and fix every error you caused before you finish.",
    "- Include a README.md (what it is, the stack, how to run it) and a .gitignore.",
    "- When you are done, answer with one short plain-text paragraph about what you built, then how to run it and anything you could not verify.",
  ].join("\n");
}

const eventKind = (e: ClaudeEvent): JobEvent["kind"] => (e.kind === "result" ? "result" : e.kind === "action" ? "action" : e.kind === "message" ? "message" : "status");

function finish(jobId: string, patch: Parameters<typeof updateJob>[1]): void {
  const current = getJob(jobId);
  if (!current || current.state === "cancelled" || current.state === "completed" || current.state === "failed") return; // already decided (for example cancelled)
  updateJob(jobId, { phase: null, finishedAt: new Date().toISOString(), ...patch });
}

async function executeLocal(job: Job, dir: string, brief: BriefPayload, location: ClaudeLocation, settings: ExecutionSettings, signal: AbortSignal, deps: RunnerDeps, content?: ContentExport): Promise<void> {
  try {
    const out = await deps.runClaude({
      location,
      cwd: dir,
      prompt: buildLocalPrompt(brief, content),
      args: localArgs(settings.localMaxTurns),
      env: deps.env,
      timeoutMs: settings.localTimeoutMinutes * 60_000,
      signal,
      onEvent: (e) => { if (e.kind !== "ignore") appendEvent(job.id, eventKind(e), e.text); },
    });
    if (out.cancelled || signal.aborted) return;
    if (out.spawnError) return finish(job.id, { state: "failed", error: "Claude Code could not be started on this computer.", exitCode: out.exitCode });
    if (out.timedOut) return finish(job.id, { state: "failed", error: `Claude Code did not finish within ${settings.localTimeoutMinutes} minutes and was stopped.`, exitCode: out.exitCode });
    if (out.exitCode !== 0 || out.result?.ok === false) {
      const detail = safeText(out.result?.text || out.stderrTail || "");
      appendEvent(job.id, "error", `Claude Code stopped with exit code ${out.exitCode ?? "unknown"}.${detail ? ` ${detail}` : ""}`);
      // A failure stays a failure. SILPI does not try the API; the developer decides what to do next.
      return finish(job.id, { state: "failed", error: `Claude Code stopped with exit code ${out.exitCode ?? "unknown"}.${detail ? ` ${detail}` : ""}`, exitCode: out.exitCode });
    }
    updateJob(job.id, { phase: "verifying" });
    appendEvent(job.id, "status", "Claude Code finished. Building and testing the project.");
    const verification = await deps.verify(dir, signal, (step) => appendEvent(job.id, step.status === "failed" ? "error" : "status", `${step.name}: ${step.status}${step.note ? ` (${safeText(step.note, 120)})` : ""}`));
    if (signal.aborted) return;
    finish(job.id, {
      state: "completed",
      exitCode: out.exitCode,
      verification,
      cost: { billing: "subscription", ...(out.result?.notionalUsd !== undefined ? { notionalUsd: out.result.notionalUsd } : {}), note: "Covered by your Claude subscription. No API charge." },
      result: { summary: safeText(out.result?.text ?? "", 800), filesChanged: out.filesChanged.length, turns: out.result?.turns },
    });
    appendEvent(job.id, "result", verification.passed ? "Completed. The project builds. Review it before marking it ready." : "Completed, but the build or tests failed. Review the project before going on.");
  } catch (e) {
    finish(job.id, { state: "failed", error: safeText((e as Error).message) });
  }
}

// ---- API run (only ever reached with a recorded approval) ------------------------------------------------------------------

async function executeApi(job: Job, dir: string, brief: BriefPayload, settings: ExecutionSettings, signal: AbortSignal, deps: RunnerDeps): Promise<void> {
  try {
    const limit = job.approval?.limitUsd ?? settings.apiSpendLimitUsd ?? 0;
    let lastTurn = 0;
    const out = await deps.runApi({
      task: { mode: "create", name: job.projectName, ...brief, designUrl: "", attachments: [] },
      // The approved limit becomes the agent's own hard cost stop.
      env: { ...deps.env, SILPI_MAX_COST_USD: String(limit) },
      signal,
      onEvent: (e) => {
        if (e.type === "status") appendEvent(job.id, "status", e.message);
        else if (e.type === "message") appendEvent(job.id, "message", e.text);
        else if (e.type === "action") appendEvent(job.id, "action", e.label);
        else if (e.type === "result" && !e.ok) appendEvent(job.id, "status", `${e.label} failed`);
        else if (e.type === "usage" && e.turn - lastTurn >= 5) { lastTurn = e.turn; appendEvent(job.id, "status", `Turn ${e.turn}: $${e.totalCostUsd.toFixed(2)} so far (limit $${limit.toFixed(2)}).`); }
        else if (e.type === "error") appendEvent(job.id, "error", e.message);
      },
    });
    if (out.cancelled || signal.aborted) return;
    const cost = { billing: "api" as const, ...(out.costUsd !== undefined ? { actualUsd: out.costUsd } : {}), note: "Calculated by the SILPI agent from token usage. Your Anthropic invoice is the billed amount." };
    if (!out.ok) return finish(job.id, { state: "failed", error: safeText(out.error ?? "The SILPI agent did not finish."), exitCode: out.exitCode ?? null, cost });
    const steps: VerificationStep[] = [
      { name: "Build (SILPI agent)", status: out.buildPassed === null || out.buildPassed === undefined ? "skipped" : out.buildPassed ? "passed" : "failed" },
      { name: "App start check", status: out.appStarted === null || out.appStarted === undefined ? "skipped" : out.appStarted ? "passed" : "failed" },
    ];
    finish(job.id, {
      state: "completed",
      exitCode: out.exitCode ?? 0,
      cost,
      verification: { steps, passed: !steps.some((s) => s.status === "failed") },
      result: { summary: safeText(out.summary ?? "", 800), filesChanged: out.filesChanged, turns: out.turns },
    });
    appendEvent(job.id, "result", "Completed. Review the project before marking it ready.");
  } catch (e) {
    finish(job.id, { state: "failed", error: safeText((e as Error).message) });
  }
}

// ---- cancel, decline, restart -------------------------------------------------------------------------------------------------

export function cancelJob(jobId: string): Job {
  reconcile();
  const job = getJob(jobId);
  if (!job) throw new ExecError("job-not-found", "That job does not exist.", 404);
  if (job.state === "completed" || job.state === "failed" || job.state === "cancelled") throw new ExecError("bad-state", `This job is already ${job.state}.`, 409);
  live().get(jobId)?.abort();
  const cancelled = updateJob(jobId, { state: "cancelled", phase: null, finishedAt: new Date().toISOString(), error: "Cancelled by the developer." });
  appendEvent(jobId, "status", "Cancelled by the developer.");
  return cancelled;
}

/** The developer closed the API cost dialog without approving: nothing runs and nothing is spent. */
export function declineApi(jobId: string): Job {
  const job = getJob(jobId);
  if (!job) throw new ExecError("job-not-found", "That job does not exist.", 404);
  if (job.state !== "waiting-approval") throw new ExecError("bad-state", "There is no API approval waiting for this job.", 409);
  appendEvent(jobId, "status", "API cost not approved. Nothing was run and nothing was spent.");
  return updateJob(jobId, { state: "prepared", mode: null });
}

export function restartJob(jobId: string, scopeConfirmed: boolean, deps: RunnerDeps = realDeps()): Job {
  reconcile();
  const job = getJob(jobId);
  if (!job) throw new ExecError("job-not-found", "That job does not exist.", 404);
  if (job.state !== "failed" && job.state !== "cancelled") throw new ExecError("bad-state", "Only a failed or cancelled run can be restarted.", 409);
  return prepareJob(job.leadId, { scopeConfirmed, restartOf: job.id }, deps);
}

// ---- 3. review, then ready for delivery ----------------------------------------------------------------------------------------------

export function reviewJob(jobId: string, input: { decision: "approved" | "changes-requested"; note?: string; overrideVerification?: boolean }): Job {
  const job = getJob(jobId);
  if (!job) throw new ExecError("job-not-found", "That job does not exist.", 404);
  if (job.state !== "completed") throw new ExecError("bad-state", "Only a completed run can be reviewed.", 409);
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : "";
  if (input.decision !== "approved" && input.decision !== "changes-requested") throw new ExecError("bad-decision", "Choose approve or request changes.", 400);
  const failedChecks = job.verification && !job.verification.passed;
  if (input.decision === "approved" && failedChecks) {
    if (input.overrideVerification !== true || note.length < 10) {
      throw new ExecError("verification-failed", "The build or tests failed. Fix the project, or approve anyway with a note of at least 10 characters explaining why.", 409);
    }
  }
  appendEvent(jobId, "status", input.decision === "approved" ? "Developer review: approved." : "Developer review: changes requested.");
  return updateJob(jobId, { review: { status: input.decision, at: new Date().toISOString(), note, ...(input.decision === "approved" && failedChecks ? { overrodeVerification: true } : {}) } });
}

export function markJobReady(jobId: string): { job: Job } {
  const job = getJob(jobId);
  if (!job) throw new ExecError("job-not-found", "That job does not exist.", 404);
  if (job.state !== "completed" || job.review?.status !== "approved") throw new ExecError("review-required", "Review and approve the generated project before it can be marked ready for delivery.", 409);
  try {
    markReadyForDelivery(job.leadId, `Generated project reviewed and approved (job ${job.id.slice(0, 8)})`);
  } catch (e) {
    if (e instanceof StageError) throw new ExecError("bad-stage", e.message, 409);
    throw e;
  }
  appendEvent(jobId, "status", "Marked ready for delivery.");
  return { job: getJob(jobId)! };
}

// ---- reading ---------------------------------------------------------------------------------------------------------------------------------

export function jobWithEvents(jobId: string, after = 0): { job: Job; events: JobEvent[] } {
  reconcile();
  const job = getJob(jobId);
  if (!job) throw new ExecError("job-not-found", "That job does not exist.", 404);
  return { job, events: listEvents(jobId, after) };
}

export function jobsForLead(leadId: string): Job[] {
  reconcile();
  return listJobs(leadId);
}

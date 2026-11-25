import { randomUUID } from "node:crypto";

import { getDb, transaction } from "@/lib/business/db";
import { ValidationError } from "@/lib/business/validate";
import { addCredits, CreditError } from "@/server/credits";
import { complete, estimate, GatewayError, type GatewayDeps } from "./gateway";
import { addSteps, getFiles, getJob, getJobById, getStepOutput, getSteps, now, QUALITIES, setJob, setStep, TERMINAL, type Job, type PauseReason, type Quality, type Step } from "./job-store";

/**
 * Agent orchestration (server only): turns one brief into a plan and a set of generated files, step by step, every AI call
 * going through the AI Gateway (so every step is held, metered and settled by the credit engine).
 *
 *   create -> PLAN (one AI call) -> customer sees the file list and the most it could cost -> APPROVES a budget
 *          -> one FILE step per planned file (model chosen per step) -> optional REVIEW -> completed
 *
 * The budget is a cap the orchestrator enforces: before each step it asks the gateway for that step's worst-case hold and
 * stops (paused, "needs approval") rather than let spent + hold pass the budget. Each step is still held and settled on its own,
 * so the wallet can never go below zero even if the customer spends credits elsewhere meanwhile; the job then pauses and can
 * be resumed. State lives in the database, so a job survives a restart: it is shown as "interrupted" and resumes where it stopped.
 */

export class JobError extends Error {
  code: "not-found" | "state";
  constructor(code: "not-found" | "state", message: string) {
    super(message);
    this.name = "JobError";
    this.code = code;
  }
}

export const JOB_LIMITS = { maxFiles: 12, briefMin: 10, briefMax: 4000, openJobsPerOrg: 3, reviewChars: 60_000, planTokens: 2048, reviewTokens: 1500, planParseAttempts: 2, providerFailuresPerRun: 2, busyRetries: 10 } as const;

// ---- which model does which step -------------------------------------------------------------------------------------------
/** The margin lever: cheap tier for routine files, stronger tiers only where it matters. "demo" uses the free built-in model for everything. */
export function modelFor(quality: Quality, kind: "plan" | "file" | "review", complexity: "low" | "high" = "low"): string {
  if (quality === "demo") return "silpi-demo";
  if (kind === "plan") return "balanced";
  if (kind === "review") return quality === "high" ? "best" : quality === "economy" ? "fast" : "balanced";
  if (quality === "economy") return "fast";
  if (quality === "high") return "balanced";
  return complexity === "high" ? "balanced" : "fast";
}

// ---- the plan ------------------------------------------------------------------------------------------------------------------
export type PlannedFile = { path: string; purpose: string; complexity: "low" | "high" };
export type Plan = { summary: string; files: PlannedFile[] };

/** Reads the AI's plan. Strict on purpose: paths come from a model, so they are checked before they are ever used. */
export function parsePlan(text: string): { plan: Plan } | { error: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "The plan was not JSON." };
  let raw: unknown;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { return { error: "The plan was not valid JSON." }; }
  const o = raw as { summary?: unknown; files?: unknown };
  if (typeof o.summary !== "string" || !o.summary.trim()) return { error: "The plan had no summary." };
  if (!Array.isArray(o.files) || o.files.length < 1 || o.files.length > JOB_LIMITS.maxFiles) return { error: `The plan must list 1 to ${JOB_LIMITS.maxFiles} files.` };
  const seen = new Set<string>();
  const files: PlannedFile[] = [];
  for (const f of o.files as { path?: unknown; purpose?: unknown; complexity?: unknown }[]) {
    const path = typeof f?.path === "string" ? f.path.trim() : "";
    if (!/^[A-Za-z0-9._\-/]{1,100}$/.test(path) || path.startsWith("/") || path.split("/").some((p) => p === "" || p === "." || p === "..")) return { error: `Unsafe or invalid file path: ${String(f?.path).slice(0, 60)}` };
    if (seen.has(path.toLowerCase())) return { error: `Duplicate file path: ${path}` };
    seen.add(path.toLowerCase());
    files.push({ path, purpose: String(f.purpose ?? "").slice(0, 300), complexity: f.complexity === "high" ? "high" : "low" });
  }
  return { plan: { summary: o.summary.trim().slice(0, 1000), files } };
}

/** A model sometimes wraps a whole file in a code fence despite instructions; remove that wrapper only. */
export function cleanFile(text: string): string {
  const m = /^\s*```[A-Za-z0-9_+-]*\n([\s\S]*?)\n```\s*$/.exec(text);
  return m ? m[1]! : text;
}

const PLAN_SYS = "SILPI_JOB_PLAN\nYou are a senior software architect. Reply with ONLY one JSON object and nothing else (no markdown fences): {\"summary\": string, \"files\": [{\"path\": string, \"purpose\": string, \"complexity\": \"low\" | \"high\"}]}. List the smallest set of files (at most 12) that fulfils the brief. Paths are relative, use only letters, digits, dots, dashes, underscores and slashes. Mark a file \"high\" only if it holds the main logic.";
const FILE_SYS = "SILPI_JOB_FILE\nYou write exactly ONE file of a software project. Reply with ONLY the complete contents of that file: no markdown code fences and no explanations. Follow the plan so all the files fit together.";
const REVIEW_SYS = "SILPI_JOB_REVIEW\nYou are a careful code reviewer. Read the project files and list the real problems you find (bugs, missing pieces, inconsistencies between files), most serious first, briefly. If it looks sound, say so.";

type Req = { model: string; system: string; messages: { role: "user"; content: string }[]; maxOutputTokens: number; taskType: string };

function buildRequest(job: Job, steps: Step[], step: Step, outputOf: (seq: number) => string | null): Req {
  if (step.kind === "plan") return { model: step.model, system: PLAN_SYS, messages: [{ role: "user", content: `Project brief:\n${job.brief}` }], maxOutputTokens: JOB_LIMITS.planTokens, taskType: "architecture_planning" };
  const files = steps.filter((s) => s.kind === "file");
  if (step.kind === "file") {
    const list = files.map((f) => `- ${String(f.payload.path)}: ${String(f.payload.purpose)}`).join("\n");
    return { model: step.model, system: FILE_SYS, messages: [{ role: "user", content: `Project brief:\n${job.brief}\n\nPlan: ${job.planSummary}\n\nAll files:\n${list}\n\nFile to write: ${String(step.payload.path)}\nPurpose: ${String(step.payload.purpose)}` }], maxOutputTokens: Number(step.payload.maxOutputTokens) || 2048, taskType: "code_generation" };
  }
  // review: the files so far. Before they exist (for the budget estimate) each is assumed to be as long as its answer allowance.
  let body = "";
  for (const f of files) {
    const out = outputOf(f.seq) ?? "x".repeat((Number(f.payload.maxOutputTokens) || 2048) * 3);
    body += `### ${String(f.payload.path)}\n${out}\n\n`;
  }
  return { model: step.model, system: REVIEW_SYS, messages: [{ role: "user", content: `Project brief:\n${job.brief}\n\n${body.slice(0, JOB_LIMITS.reviewChars)}` }], maxOutputTokens: JOB_LIMITS.reviewTokens, taskType: "code_review" };
}

const holdFor = (r: Req) => estimate({ model: r.model, messages: r.messages, system: r.system, maxOutputTokens: r.maxOutputTokens, taskType: r.taskType }).maxUnits;

/** The most the remaining steps could hold in total (what the customer is asked to approve). */
export function estimateRemaining(job: Job): { maxUnits: number; steps: { seq: number; label: string; model: string; maxUnits: number }[] } {
  const steps = getSteps(job.id);
  const rows = steps.filter((s) => s.status === "pending" && s.kind !== "plan").map((s) => ({ seq: s.seq, label: s.label, model: s.model, maxUnits: holdFor(buildRequest(job, steps, s, () => null)) }));
  return { maxUnits: rows.reduce((n, r) => n + r.maxUnits, 0), steps: rows };
}

// ---- creating, approving, resuming, cancelling -------------------------------------------------------------------------------
export function createJob(input: { orgId: string; userId?: string; brief: unknown; title?: unknown; quality?: unknown; review?: unknown }): Job {
  const brief = typeof input.brief === "string" ? input.brief.trim() : "";
  if (brief.length < JOB_LIMITS.briefMin || brief.length > JOB_LIMITS.briefMax) throw new ValidationError(`Describe the project in ${JOB_LIMITS.briefMin} to ${JOB_LIMITS.briefMax} characters.`);
  const quality = (input.quality ?? "standard") as Quality;
  if (!(QUALITIES as readonly string[]).includes(quality)) throw new ValidationError(`quality must be one of: ${QUALITIES.join(", ")}.`);
  const title = (typeof input.title === "string" && input.title.trim() ? input.title.trim() : brief).slice(0, 60);
  const id = `job_${randomUUID()}`;
  return transaction((db) => {
    if (!db.prepare("SELECT 1 FROM organizations WHERE id = ?").get(input.orgId)) throw new ValidationError("That organization does not exist.");
    const open = (db.prepare("SELECT COUNT(*) AS n FROM ai_jobs WHERE org_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')").get(input.orgId) as { n: number }).n;
    if (open >= JOB_LIMITS.openJobsPerOrg) throw new JobError("state", `You already have ${open} unfinished builds. Finish or cancel one first.`);
    const at = now();
    db.prepare("INSERT INTO ai_jobs (id, org_id, user_id, title, brief, quality, review, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'planning', ?, ?)").run(id, input.orgId, input.userId ?? "", title, brief, quality, input.review ? 1 : 0, at, at);
    addSteps(id, [{ kind: "plan", label: "Plan the project", model: modelFor(quality, "plan"), payload: {} }]);
    return getJob(input.orgId, id)!;
  });
}

const must = (orgId: string, id: string): Job => getJob(orgId, id) ?? (() => { throw new JobError("not-found", "That build does not exist."); })();

/** Approve (or raise) the budget and let the job run. Without a figure the budget is what has been spent plus the worst case of every remaining step. */
export function approveJob(orgId: string, id: string, budgetUnits?: unknown): Job {
  const job = must(orgId, id);
  if (!(job.status === "awaiting_approval" || (job.status === "paused" && job.pauseReason === "needs_approval"))) throw new JobError("state", "This build is not waiting for approval.");
  const budget = budgetUnits === undefined || budgetUnits === null ? job.spentUnits + estimateRemaining(job).maxUnits : budgetUnits;
  if (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget < job.spentUnits || budget > 1_000_000_000) throw new ValidationError("The budget must be a whole number of units, at least what has been spent already.");
  setJob(id, { status: "running", pause_reason: null, message: "", budget_units: budget });
  return must(orgId, id);
}

export function resumeJob(orgId: string, id: string): Job {
  const job = must(orgId, id);
  if (job.status !== "paused") throw new JobError("state", "Only a paused build can be resumed.");
  if (job.pauseReason === "needs_approval") throw new JobError("state", "This build needs more budget: approve it instead.");
  for (const s of getSteps(id).filter((x) => x.status === "running")) setStep(id, s.seq, { status: "pending" });
  const planDone = getSteps(id).find((s) => s.kind === "plan")?.status === "completed";
  setJob(id, { status: planDone ? "running" : "planning", pause_reason: null, message: "" });
  return must(orgId, id);
}

function finalizeCancelled(id: string): void {
  for (const s of getSteps(id).filter((x) => x.status === "pending" || x.status === "running")) setStep(id, s.seq, { status: "skipped" });
  setJob(id, { status: "cancelled", pause_reason: null, message: "Cancelled. Credits for steps that did not run were never charged.", finished_at: now() });
}

export function cancelJob(orgId: string, id: string): Job {
  const job = must(orgId, id);
  if (TERMINAL.includes(job.status)) throw new JobError("state", "This build has already finished.");
  setJob(id, { cancel_requested: 1 });
  if (!runners().has(id)) finalizeCancelled(id); // nothing is running it: stop now. Otherwise the runner stops after its current step.
  return must(orgId, id);
}

/** A job marked as running whose runner is gone (server restarted) is shown as interrupted, so it can be resumed instead of looking stuck. */
export function reconcileJobs(orgId: string): number {
  const rows = getDb().prepare("SELECT id FROM ai_jobs WHERE org_id = ? AND status IN ('planning', 'running')").all(orgId) as { id: string }[];
  let n = 0;
  for (const { id } of rows) {
    if (runners().has(id)) continue;
    for (const s of getSteps(id).filter((x) => x.status === "running")) setStep(id, s.seq, { status: "pending" });
    setJob(id, { status: "paused", pause_reason: "interrupted", message: "The server stopped while this build was running. Resume to continue where it stopped." });
    n++;
  }
  return n;
}

// ---- the runner ----------------------------------------------------------------------------------------------------------------------
const runners = (): Set<string> => ((globalThis as { silpiJobRunners?: Set<string> }).silpiJobRunners ??= new Set());

const pause = (id: string, reason: PauseReason, message: string) => setJob(id, { status: "paused", pause_reason: reason, message });

/** Starts a job in the background. The route returns immediately; progress is read from the database. */
export function startJob(id: string, deps: GatewayDeps = {}): void {
  void runJob(id, deps).catch((e) => console.error("SILPI JOB RUNNER ERROR:", e));
}

export async function runJob(jobId: string, deps: GatewayDeps = {}): Promise<void> {
  if (runners().has(jobId)) return; // one runner per job
  runners().add(jobId);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let busy = 0;
  let providerFailures = 0;
  try {
    for (;;) {
      const job = getJobById(jobId);
      if (!job || (job.status !== "planning" && job.status !== "running")) return;
      if (job.cancelRequested) { finalizeCancelled(jobId); return; }
      const steps = getSteps(jobId);
      const step = steps.find((s) => s.status === "pending");
      if (!step) { setJob(jobId, { status: "completed", message: "Done.", finished_at: now() }); return; }
      const req = buildRequest(job, steps, step, (seq) => getStepOutput(jobId, seq));

      if (step.kind !== "plan") {
        let hold: number;
        try { hold = holdFor(req); } catch (e) { pause(jobId, "error", e instanceof GatewayError ? e.message : "Could not price the next step."); return; }
        if (job.spentUnits + hold > job.budgetUnits) {
          pause(jobId, "needs_approval", `The next step could use up to ${hold} units but the budget has only ${Math.max(0, job.budgetUnits - job.spentUnits)} left. Approve more credits to continue.`);
          return;
        }
      }

      setStep(jobId, step.seq, { status: "running", started_at: now(), error: null });
      setJob(jobId, { heartbeat_at: now() });
      try {
        const r = await complete({ orgId: job.orgId, userId: job.userId, model: req.model, messages: req.messages, system: req.system, maxOutputTokens: req.maxOutputTokens, taskType: req.taskType, idempotencyKey: `job:${jobId}:s${step.seq}:a${step.attempt}`, purpose: `job:${jobId}` }, deps);
        const spent = (getJobById(jobId)?.spentUnits ?? job.spentUnits) + r.chargedUnits;
        if (r.replayed && !r.text) {
          // Charged before but the answer was lost (a crash between the call and saving it): count the charge, ask again under a new key.
          setJob(jobId, { spent_units: spent });
          setStep(jobId, step.seq, { status: "pending", attempt: step.attempt + 1, charged_units: step.chargedUnits + r.chargedUnits });
          continue;
        }
        providerFailures = 0;
        busy = 0;
        const done = { charged_units: step.chargedUnits + r.chargedUnits, input_tokens: r.usage.inputTokens, output_tokens: r.usage.outputTokens, model_used: r.model.id, finished_at: now() };
        if (step.kind === "plan") {
          const parsed = parsePlan(r.text);
          if ("error" in parsed) {
            setJob(jobId, { spent_units: spent });
            const nextAttempt = step.attempt + 1;
            if (nextAttempt >= JOB_LIMITS.planParseAttempts) { failPlan(job, spent, parsed.error); return; }
            setStep(jobId, step.seq, { status: "pending", attempt: nextAttempt, charged_units: done.charged_units });
            continue;
          }
          const { plan } = parsed;
          addSteps(jobId, [
            ...plan.files.map((f) => ({ kind: "file" as const, label: f.path, model: modelFor(job.quality, "file", f.complexity), payload: { path: f.path, purpose: f.purpose, complexity: f.complexity, maxOutputTokens: f.complexity === "high" ? 4096 : 2048 } })),
            ...(job.review ? [{ kind: "review" as const, label: "Review the project", model: modelFor(job.quality, "review"), payload: {} }] : []),
          ]);
          setStep(jobId, step.seq, { ...done, status: "completed", output: r.text });
          setJob(jobId, { spent_units: spent, plan_summary: plan.summary, status: "awaiting_approval", message: "The plan is ready. Approve a budget to start building." });
          return;
        }
        setStep(jobId, step.seq, { ...done, status: "completed", output: step.kind === "file" ? cleanFile(r.text) : r.text });
        setJob(jobId, { spent_units: spent });
      } catch (e) {
        // The step did not complete: put it back, bump the attempt (a failed gateway request keeps its idempotency key), then decide.
        const back = { status: "pending" as const, attempt: step.attempt + 1 };
        if (e instanceof CreditError && e.code === "insufficient") { setStep(jobId, step.seq, back); pause(jobId, "insufficient_credits", "Not enough credits to continue. Add credits, then resume."); return; }
        if (e instanceof GatewayError) {
          if (e.code === "too-many-requests" || e.code === "in-progress") {
            setStep(jobId, step.seq, { status: "pending" });
            if (++busy > JOB_LIMITS.busyRetries) { pause(jobId, "error", "The gateway stayed busy. Resume in a moment."); return; }
            await sleep(1500);
            continue;
          }
          setStep(jobId, step.seq, back);
          if (e.code === "daily-cap") { pause(jobId, "daily_cap", "Your organization's daily AI limit was reached. Resume after it resets (midnight UTC) or ask for a higher limit."); return; }
          if (e.code === "provider-not-configured") { pause(jobId, "provider", "The AI provider for this quality level is not connected. Nothing was charged. Try Demo quality, or ask the administrator to add the provider key."); return; }
          if (e.code === "provider-failed" && ++providerFailures < JOB_LIMITS.providerFailuresPerRun) continue;
          setStep(jobId, step.seq, { ...back, status: "failed", error: e.message.slice(0, 300) });
          pause(jobId, "error", `A step failed: ${e.message} Nothing was charged for it. Resume to try again.`);
          return;
        }
        setStep(jobId, step.seq, back);
        console.error("SILPI JOB STEP ERROR:", e);
        pause(jobId, "error", "Something went wrong on the server. Resume to try again.");
        return;
      }
    }
  } finally {
    runners().delete(jobId);
  }
}

/** The plan could not be read after retries. That is the platform's failure, not the customer's: what the plan attempts cost is refunded. */
function failPlan(job: Job, spent: number, reason: string): void {
  if (spent > 0) addCredits({ orgId: job.orgId, units: spent, kind: "refund", idempotencyKey: `job-refund:${job.id}`, reference: job.id, note: "plan could not be read" });
  setJob(job.id, { status: "failed", spent_units: 0, message: `The AI's plan could not be used (${reason}). ${spent > 0 ? "The credits it cost were refunded. " : ""}Try again, or describe the project more simply.`, finished_at: now() });
  for (const s of getSteps(job.id).filter((x) => x.status === "pending" || x.status === "running")) setStep(job.id, s.seq, { status: "failed", error: reason });
}

export { getFiles };

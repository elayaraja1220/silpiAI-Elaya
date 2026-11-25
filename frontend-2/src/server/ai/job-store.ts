import { getDb } from "@/lib/business/db";

/** Reading and writing jobs and their steps (server only). Every read takes the organization: a job of another organization is simply not found. */

export const QUALITIES = ["economy", "standard", "high", "demo"] as const;
export type Quality = (typeof QUALITIES)[number];
export type JobStatus = "planning" | "awaiting_approval" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type PauseReason = "needs_approval" | "insufficient_credits" | "daily_cap" | "provider" | "interrupted" | "error";
export type StepKind = "plan" | "file" | "review";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type Job = { id: string; orgId: string; userId: string; title: string; brief: string; quality: Quality; review: boolean; status: JobStatus; pauseReason: PauseReason | null; message: string; planSummary: string; budgetUnits: number; spentUnits: number; cancelRequested: boolean; createdAt: string; updatedAt: string; finishedAt: string | null };
export type Step = { seq: number; kind: StepKind; label: string; model: string; status: StepStatus; attempt: number; chargedUnits: number; inputTokens: number; outputTokens: number; modelUsed: string | null; error: string | null; payload: Record<string, unknown>; hasOutput: boolean; startedAt: string | null; finishedAt: string | null };

type JobRow = { id: string; org_id: string; user_id: string; title: string; brief: string; quality: Quality; review: number; status: JobStatus; pause_reason: PauseReason | null; message: string; plan_summary: string; budget_units: number; spent_units: number; cancel_requested: number; created_at: string; updated_at: string; finished_at: string | null };
type StepRow = { seq: number; kind: StepKind; label: string; model: string; status: StepStatus; attempt: number; charged_units: number; input_tokens: number; output_tokens: number; model_used: string | null; error: string | null; payload: string; output: string | null; started_at: string | null; finished_at: string | null };

const toJob = (r: JobRow): Job => ({ id: r.id, orgId: r.org_id, userId: r.user_id, title: r.title, brief: r.brief, quality: r.quality, review: r.review === 1, status: r.status, pauseReason: r.pause_reason, message: r.message, planSummary: r.plan_summary, budgetUnits: r.budget_units, spentUnits: r.spent_units, cancelRequested: r.cancel_requested === 1, createdAt: r.created_at, updatedAt: r.updated_at, finishedAt: r.finished_at });
const toStep = (r: StepRow): Step => ({ seq: r.seq, kind: r.kind, label: r.label, model: r.model, status: r.status, attempt: r.attempt, chargedUnits: r.charged_units, inputTokens: r.input_tokens, outputTokens: r.output_tokens, modelUsed: r.model_used, error: r.error, payload: JSON.parse(r.payload) as Record<string, unknown>, hasOutput: r.output !== null, startedAt: r.started_at, finishedAt: r.finished_at });

export const TERMINAL: readonly JobStatus[] = ["completed", "failed", "cancelled"];

export function getJob(orgId: string, id: string): Job | null {
  const row = getDb().prepare("SELECT * FROM ai_jobs WHERE id = ? AND org_id = ?").get(id, orgId) as JobRow | undefined;
  return row ? toJob(row) : null;
}
/** Internal read by id alone, for the runner (which already holds a job id it created or was given for an organization). */
export function getJobById(id: string): Job | null {
  const row = getDb().prepare("SELECT * FROM ai_jobs WHERE id = ?").get(id) as JobRow | undefined;
  return row ? toJob(row) : null;
}
export const listJobs = (orgId: string, limit = 30): Job[] =>
  (getDb().prepare("SELECT * FROM ai_jobs WHERE org_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(orgId, Math.min(Math.max(1, Math.floor(limit)), 100)) as JobRow[]).map(toJob);
export const getSteps = (jobId: string): Step[] => (getDb().prepare("SELECT * FROM ai_job_steps WHERE job_id = ? ORDER BY seq").all(jobId) as StepRow[]).map(toStep);
export const getStepOutput = (jobId: string, seq: number): string | null => (getDb().prepare("SELECT output FROM ai_job_steps WHERE job_id = ? AND seq = ?").get(jobId, seq) as { output: string | null } | undefined)?.output ?? null;

export type JobFile = { path: string; content: string };
/** The generated files: the completed file steps of one job of this organization. */
export function getFiles(orgId: string, jobId: string): JobFile[] | null {
  if (!getJob(orgId, jobId)) return null;
  const rows = getDb().prepare("SELECT payload, output FROM ai_job_steps WHERE job_id = ? AND kind = 'file' AND status = 'completed' ORDER BY seq").all(jobId) as { payload: string; output: string }[];
  return rows.map((r) => ({ path: String((JSON.parse(r.payload) as { path?: string }).path ?? ""), content: r.output }));
}

export const now = () => new Date().toISOString();

export function setJob(id: string, fields: Partial<{ status: JobStatus; pause_reason: PauseReason | null; message: string; plan_summary: string; budget_units: number; spent_units: number; cancel_requested: number; heartbeat_at: string | null; finished_at: string | null }>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  getDb().prepare(`UPDATE ai_jobs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...(Object.values(fields) as (string | number | null)[]), now(), id);
}
export function setStep(jobId: string, seq: number, fields: Partial<{ status: StepStatus; attempt: number; charged_units: number; input_tokens: number; output_tokens: number; model_used: string | null; error: string | null; output: string | null; started_at: string | null; finished_at: string | null }>): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  getDb().prepare(`UPDATE ai_job_steps SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE job_id = ? AND seq = ?`).run(...(Object.values(fields) as (string | number | null)[]), jobId, seq);
}
export function addSteps(jobId: string, steps: { kind: StepKind; label: string; model: string; payload: Record<string, unknown> }[]): void {
  const db = getDb();
  const start = ((db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM ai_job_steps WHERE job_id = ?").get(jobId) as { n: number }).n) + 1;
  const insert = db.prepare("INSERT INTO ai_job_steps (job_id, seq, kind, label, model, status, payload) VALUES (?, ?, ?, ?, ?, 'pending', ?)");
  steps.forEach((s, i) => insert.run(jobId, start + i, s.kind, s.label, s.model, JSON.stringify(s.payload)));
}

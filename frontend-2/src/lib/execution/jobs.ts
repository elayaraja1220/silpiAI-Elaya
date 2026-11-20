import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/business/db";

import {
  applyExecutionPatch,
  DEFAULT_EXECUTION_SETTINGS,
  ExecError,
  parseExecutionSettings,
  type ExecutionSettings,
  type ExecutionSettingsPatch,
  type Job,
  type JobEvent,
  type JobState,
} from "./types";

/**
 * Execution settings, jobs and their progress log (server-only, SQLite). The log is private: it is only served
 * through the admin-protected execution routes.
 */

// ---- settings ---------------------------------------------------------------------------------------

export function getExecutionSettings(): ExecutionSettings {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'execution_settings'").get() as { value: string } | undefined;
  if (!row) return DEFAULT_EXECUTION_SETTINGS;
  try {
    return parseExecutionSettings(JSON.parse(row.value));
  } catch {
    return DEFAULT_EXECUTION_SETTINGS;
  }
}

export function saveExecutionSettings(patch: ExecutionSettingsPatch): ExecutionSettings {
  const merged = applyExecutionPatch(getExecutionSettings(), patch);
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES ('execution_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(merged));
  return merged;
}

// ---- jobs ---------------------------------------------------------------------------------------------

type Row = {
  id: string; lead_id: string; project_name: string; state: string; mode: string | null; phase: string | null;
  scope_confirmed_at: string; brief_sha: string; brief_bytes: number; restart_of: string | null;
  created_at: string; updated_at: string; started_at: string | null; finished_at: string | null;
  exit_code: number | null; error: string | null;
  approval: string | null; cost: string | null; result: string | null; verification: string | null; review: string | null;
};

const json = <T,>(text: string | null): T | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

const toJob = (r: Row): Job => ({
  id: r.id,
  leadId: r.lead_id,
  projectName: r.project_name,
  state: r.state as JobState,
  mode: r.mode as Job["mode"],
  phase: r.phase as Job["phase"],
  scopeConfirmedAt: r.scope_confirmed_at,
  briefSha: r.brief_sha,
  briefBytes: r.brief_bytes,
  restartOf: r.restart_of,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  exitCode: r.exit_code,
  error: r.error,
  approval: json(r.approval),
  cost: json(r.cost),
  result: json(r.result),
  verification: json(r.verification),
  review: json(r.review),
});

const now = () => new Date().toISOString();

/** Which state may follow which. Finished jobs never change state; a restart is a new job. */
const NEXT: Record<JobState, JobState[]> = {
  prepared: ["waiting-approval", "running", "cancelled"],
  "waiting-approval": ["prepared", "running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};
export const canMove = (from: JobState, to: JobState) => from === to || NEXT[from].includes(to);

export function createJob(input: { leadId: string; projectName: string; scopeConfirmedAt: string; briefSha: string; briefBytes: number; restartOf?: string | null }): Job {
  const id = randomUUID();
  const at = now();
  getDb()
    .prepare("INSERT INTO exec_jobs (id, lead_id, project_name, state, scope_confirmed_at, brief_sha, brief_bytes, restart_of, created_at, updated_at) VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?)")
    .run(id, input.leadId, input.projectName, input.scopeConfirmedAt, input.briefSha, input.briefBytes, input.restartOf ?? null, at, at);
  return getJob(id)!;
}

export function getJob(id: string): Job | null {
  const row = getDb().prepare("SELECT * FROM exec_jobs WHERE id = ?").get(id) as Row | undefined;
  return row ? toJob(row) : null;
}

export function listJobs(leadId: string): Job[] {
  return (getDb().prepare("SELECT * FROM exec_jobs WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC").all(leadId) as Row[]).map(toJob);
}

export function activeJobFor(leadId: string): Job | null {
  const row = getDb().prepare("SELECT * FROM exec_jobs WHERE lead_id = ? AND state IN ('prepared', 'waiting-approval', 'running') ORDER BY created_at DESC LIMIT 1").get(leadId) as Row | undefined;
  return row ? toJob(row) : null;
}

export function runningJobs(): Job[] {
  return (getDb().prepare("SELECT * FROM exec_jobs WHERE state = 'running'").all() as Row[]).map(toJob);
}

export type JobPatch = Partial<{
  state: JobState; mode: Job["mode"]; phase: Job["phase"]; startedAt: string | null; finishedAt: string | null; exitCode: number | null; error: string | null;
  approval: Job["approval"]; cost: Job["cost"]; result: Job["result"]; verification: Job["verification"]; review: Job["review"];
}>;

const COLUMNS: Record<keyof JobPatch, string> = {
  state: "state", mode: "mode", phase: "phase", startedAt: "started_at", finishedAt: "finished_at", exitCode: "exit_code", error: "error",
  approval: "approval", cost: "cost", result: "result", verification: "verification", review: "review",
};
const JSON_FIELDS = new Set<keyof JobPatch>(["approval", "cost", "result", "verification", "review"]);

export function updateJob(id: string, patch: JobPatch): Job {
  const current = getJob(id);
  if (!current) throw new ExecError("job-not-found", "That job does not exist.", 404);
  if (patch.state && !canMove(current.state, patch.state)) {
    throw new ExecError("bad-state", `A job that is "${current.state}" cannot become "${patch.state}".`, 409);
  }
  const keys = (Object.keys(patch) as (keyof JobPatch)[]).filter((k) => k in COLUMNS);
  const sets = [...keys.map((k) => `${COLUMNS[k]} = ?`), "updated_at = ?"];
  const values = keys.map((k) => {
    const v = patch[k];
    return v === undefined || v === null ? null : JSON_FIELDS.has(k) ? JSON.stringify(v) : (v as string | number);
  });
  getDb().prepare(`UPDATE exec_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...values, now(), id);
  return getJob(id)!;
}

// ---- progress log -------------------------------------------------------------------------------------

const MAX_EVENTS = 2000;
const MAX_TEXT = 600;

export function appendEvent(jobId: string, kind: JobEvent["kind"], text: string): void {
  const db = getDb();
  const last = db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM exec_events WHERE job_id = ?").get(jobId) as { n: number };
  if (last.n >= MAX_EVENTS) return; // the log is capped; the final state is still recorded on the job
  db.prepare("INSERT INTO exec_events (job_id, seq, at, kind, text) VALUES (?, ?, ?, ?, ?)").run(jobId, last.n + 1, now(), kind, text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT));
}

export function listEvents(jobId: string, after = 0, limit = 300): JobEvent[] {
  return getDb().prepare("SELECT seq, at, kind, text FROM exec_events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(jobId, Math.max(0, after), Math.min(limit, 1000)) as JobEvent[];
}

// ---- helpers for the API estimate and for recovery -----------------------------------------------------

/** What earlier API runs actually cost, in US dollars, newest first (basis for the next estimate). */
export function completedApiCosts(limit = 5): number[] {
  const rows = getDb()
    .prepare("SELECT cost FROM exec_jobs WHERE mode = 'api' AND state = 'completed' ORDER BY finished_at DESC LIMIT ?")
    .all(limit) as { cost: string | null }[];
  return rows.map((r) => json<{ actualUsd?: number }>(r.cost)?.actualUsd).filter((n): n is number => typeof n === "number");
}

/** A job marked running whose process is gone (the server restarted) did not finish: mark it failed so it can be restarted. */
export function interruptOrphans(isLive: (jobId: string) => boolean): number {
  let count = 0;
  for (const job of runningJobs()) {
    if (isLive(job.id)) continue;
    updateJob(job.id, { state: "failed", phase: null, finishedAt: now(), error: "The server restarted while this ran, so it did not finish. Restart it to continue." });
    appendEvent(job.id, "error", "Interrupted: the server restarted while this was running.");
    count++;
  }
  return count;
}

/** The most recent job of any project, for the "last execution result" line in Execution settings. */
export function latestJob(): Job | null {
  const row = getDb().prepare("SELECT * FROM exec_jobs ORDER BY updated_at DESC, rowid DESC LIMIT 1").get() as Row | undefined;
  return row ? toJob(row) : null;
}

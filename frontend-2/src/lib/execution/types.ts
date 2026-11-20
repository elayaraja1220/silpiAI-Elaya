/**
 * Project-generation execution: types, settings and the pure rules around them.
 *
 * Two ways to generate a project:
 *   local - Claude Code on this machine, signed in with the developer's own Claude subscription. The default.
 *   api   - the Anthropic API through the SILPI agent. Off by default, and every run needs its own cost approval.
 * SILPI never switches from one to the other by itself.
 */

export type ExecMode = "local" | "api";
export const JOB_STATES = ["prepared", "waiting-approval", "running", "completed", "failed", "cancelled"] as const;
export type JobState = (typeof JOB_STATES)[number];
export type JobPhase = "generating" | "verifying";

export const STATE_LABELS: Record<JobState, string> = {
  prepared: "Ready to start",
  "waiting-approval": "Waiting for approval",
  running: "Running",
  completed: "Completed",
  failed: "Execution failed",
  cancelled: "Cancelled",
};

/** What the screen says for a job: the mode and state together. */
export function jobStatusLabel(job: { state: JobState; mode: ExecMode | null }): string {
  if (job.state === "running") return job.mode === "api" ? "API-funded execution" : "Local subscription execution";
  return STATE_LABELS[job.state];
}

// ---- Settings ---------------------------------------------------------------------------

export type ExecutionSettings = {
  /** API mode is off until the administrator turns it on. */
  apiEnabled: boolean;
  /** When on, a failed local run offers "run with the API instead". It never starts it by itself. */
  apiFallbackOffer: boolean;
  /** The most one API-funded run may cost, in US dollars. API runs are refused until it is set. */
  apiSpendLimitUsd: number | null;
  /** Full path to the Claude Code executable, when it is not found automatically. */
  claudePath: string | null;
  localMaxTurns: number;
  localTimeoutMinutes: number;
};

export const DEFAULT_EXECUTION_SETTINGS: ExecutionSettings = {
  apiEnabled: false,
  apiFallbackOffer: false,
  apiSpendLimitUsd: null,
  claudePath: null,
  localMaxTurns: 60,
  localTimeoutMinutes: 45,
};

export type ExecutionSettingsPatch = Partial<ExecutionSettings>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? Math.round(v * 100) / 100 : undefined;

/** A Claude Code executable path: absolute, and the file is named claude. Nothing else is accepted. */
export function validClaudePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 260) return false;
  if (/["'`\r\n\0<>|*?]/.test(value)) return false;
  // Absolute (drive letter, UNC share or root), no "..", and the last part is exactly claude, claude.exe or claude.cmd.
  if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(value)) return false;
  if (value.split(/[\\/]/).includes("..")) return false;
  return /^claude(\.exe|\.cmd)?$/i.test(value.split(/[\\/]/).pop() ?? "");
}

/** Reads a patch. Valid entries go to `patch`; everything else is a problem. */
export function readExecutionPatch(input: unknown): { patch: ExecutionSettingsPatch; problems: string[] } {
  const patch: ExecutionSettingsPatch = {};
  const problems: string[] = [];
  if (!isObj(input)) return { patch, problems: ["The settings must be an object."] };
  const known = ["apiEnabled", "apiFallbackOffer", "apiSpendLimitUsd", "claudePath", "localMaxTurns", "localTimeoutMinutes"];
  for (const key of Object.keys(input)) if (!known.includes(key)) problems.push(`"${key.slice(0, 40)}" is not an execution setting.`);
  for (const key of ["apiEnabled", "apiFallbackOffer"] as const) {
    if (!(key in input)) continue;
    if (typeof input[key] === "boolean") patch[key] = input[key] as boolean;
    else problems.push(`${key} must be true or false.`);
  }
  if ("apiSpendLimitUsd" in input) {
    const v = input.apiSpendLimitUsd === null ? null : num(input.apiSpendLimitUsd, 0.01, 10_000);
    if (v === undefined) problems.push("apiSpendLimitUsd must be an amount from 0.01 to 10,000 US dollars, or null.");
    else patch.apiSpendLimitUsd = v;
  }
  if ("claudePath" in input) {
    if (input.claudePath === null || input.claudePath === "") patch.claudePath = null;
    else if (validClaudePath(input.claudePath)) patch.claudePath = input.claudePath;
    else problems.push("claudePath must be the full path of the Claude Code program (a file named claude, claude.exe or claude.cmd), or empty.");
  }
  if ("localMaxTurns" in input) {
    const v = num(input.localMaxTurns, 5, 300);
    if (v === undefined) problems.push("localMaxTurns must be from 5 to 300.");
    else patch.localMaxTurns = Math.round(v);
  }
  if ("localTimeoutMinutes" in input) {
    const v = num(input.localTimeoutMinutes, 2, 240);
    if (v === undefined) problems.push("localTimeoutMinutes must be from 2 to 240.");
    else patch.localTimeoutMinutes = Math.round(v);
  }
  return { patch, problems };
}

export const executionSettingsProblems = (input: unknown) => readExecutionPatch(input).problems;
export const applyExecutionPatch = (current: ExecutionSettings, patch: ExecutionSettingsPatch): ExecutionSettings => ({ ...current, ...patch });

/** Saved settings: unknown or invalid values are dropped, so damaged data falls back to the safe defaults. */
export const parseExecutionSettings = (stored: unknown): ExecutionSettings => applyExecutionPatch(DEFAULT_EXECUTION_SETTINGS, readExecutionPatch(stored).patch);

// ---- Claude Code on this machine --------------------------------------------------------------

export type ClaudeSource = "configured" | "path" | "standard-location" | "vscode-extension";
export type AuthKind = "authenticated-subscription" | "authenticated-api-key" | "not-authenticated" | "unknown";
export type AuthState = { kind: AuthKind; plan?: string; message: string };

export type ClaudeStatus = {
  installed: boolean;
  source?: ClaudeSource;
  version?: string;
  auth: AuthState | null;
  /** Local generation can start: Claude Code is installed and signed in with a subscription. */
  ready: boolean;
  message: string;
};

// ---- API approval -----------------------------------------------------------------------------

export type ApiEstimate = {
  /** Estimated cost of one run in US dollars, or null when it cannot be estimated at all. */
  estimatedUsd: number | null;
  /** True only when there are enough earlier runs to rely on. */
  reliable: boolean;
  basis: string;
  limitUsd: number | null;
};

export type ApiApprovalRequest = {
  confirmed: boolean;
  /** The estimate and limit the developer was shown. They must still be current. */
  estimateUsd: number | null;
  limitUsd: number;
  /** Needed when the estimate is not reliable: "I accept up to the limit." */
  acceptUnreliable?: boolean;
};

export type ApiApproval = {
  mode: "api";
  approvedAt: string;
  estimatedUsd: number | null;
  limitUsd: number;
  reliable: boolean;
  basis: string;
  acceptedUnreliableEstimate: boolean;
};

export type JobCost = {
  billing: "subscription" | "api";
  /** API runs: what the agent calculated from token usage (not an invoice). */
  actualUsd?: number;
  /** Local runs: the notional API-equivalent value Claude Code reported. Not charged. */
  notionalUsd?: number;
  note: string;
};

export type VerificationStep = { name: string; status: "passed" | "failed" | "skipped"; exitCode?: number | null; note?: string; tail?: string };
export type Verification = { steps: VerificationStep[]; passed: boolean };
export type Review = { status: "approved" | "changes-requested"; at: string; note: string; overrodeVerification?: boolean };

export type Job = {
  id: string;
  leadId: string;
  projectName: string;
  state: JobState;
  mode: ExecMode | null;
  phase: JobPhase | null;
  scopeConfirmedAt: string;
  briefSha: string;
  briefBytes: number;
  restartOf: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  approval: ApiApproval | null;
  cost: JobCost | null;
  result: { summary?: string; filesChanged?: number; turns?: number } | null;
  verification: Verification | null;
  review: Review | null;
};

export type JobEvent = { seq: number; at: string; kind: "status" | "message" | "action" | "result" | "error"; text: string };

/** The errors the execution API reports with a code the screen can act on. */
export class ExecError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;
  constructor(code: string, message: string, status = 409, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

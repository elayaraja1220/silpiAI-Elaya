"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Ban, CheckCircle2, CircleDashed, Cpu, Hammer, Loader2, RotateCcw, ShieldCheck } from "lucide-react";

import { paymentStatus } from "@/lib/business/payment-status";
import { formatINR } from "@/lib/business/pricing";
import type { Lead, Stage } from "@/lib/business/types";
import { jobStatusLabel, type ApiEstimate, type ClaudeStatus, type ExecMode, type ExecutionSettings, type Job, type JobEvent } from "@/lib/execution/types";
import { cn } from "@/lib/utils";

import { AdminGate } from "./admin-gate";
import { DEV_START_HEADER, DEV_START_WITHOUT_PAYMENT } from "@/lib/dev-flags"; // TEMP DEV
import { Card, jsonFetch } from "./ui";

type History = { fromStage: Stage | null; toStage: Stage; note: string; at: string }[];
type Reply<T> = { ok: boolean; status: number; data: T & { success?: boolean; error?: string; code?: string; estimate?: ApiEstimate } };

/** Calls an execution route and keeps the error code and details (the cost approval needs them). */
async function api<T = object>(url: string, body?: object): Promise<Reply<T>> {
  // TEMP DEV: on localhost the dev flag lets these calls through without the admin token (see src/lib/dev-start.ts).
  const dev: Record<string, string> = DEV_START_WITHOUT_PAYMENT ? { [DEV_START_HEADER]: "1" } : {};
  const response = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json", ...dev }, body: JSON.stringify(body) } : { headers: dev });
  const data = (await response.json().catch(() => ({}))) as Reply<T>["data"];
  return { ok: response.ok && data.success !== false, status: response.status, data };
}

/** Fired after a run is started from outside this panel, so the panel reloads its jobs. */
export const JOBS_CHANGED = "silpi:jobs-changed";

const TONE: Record<string, string> = {
  "Local subscription execution": "border-emerald-400/40 bg-emerald-500/10 text-emerald-200",
  "API-funded execution": "border-amber-400/50 bg-amber-500/15 text-amber-100",
  "Execution failed": "border-rose-400/40 bg-rose-500/10 text-rose-200",
  "Waiting for approval": "border-amber-400/40 bg-amber-500/10 text-amber-100",
  Completed: "border-sky-400/40 bg-sky-500/10 text-sky-200",
  Cancelled: "border-slate-400/30 bg-slate-500/10 text-slate-300",
  "Ready to start": "border-violet-400/40 bg-violet-500/10 text-violet-200",
};

function Step({ done, active, title, children }: { done: boolean; active?: boolean; title: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 shrink-0">{done ? <CheckCircle2 size={16} className="text-emerald-300" /> : <CircleDashed size={16} className={active ? "text-violet-300" : "text-slate-600"} />}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className={cn("text-xs font-medium", done ? "text-slate-300" : active ? "text-white" : "text-slate-500")}>{title}</p>
        {children}
      </div>
    </li>
  );
}

function Body({ lead, onChanged }: { lead: Lead; onChanged: (r: { lead: Lead; history: History }) => void }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [settings, setSettings] = useState<ExecutionSettings | null>(null);
  const [scopeOk, setScopeOk] = useState(false);
  const [mode, setMode] = useState<ExecMode>("local");
  const [withoutAdvance, setWithoutAdvance] = useState(false);
  const [reason, setReason] = useState("");
  const [dialog, setDialog] = useState<ApiEstimate | null>(null);
  const [approveRun, setApproveRun] = useState(false);
  const [acceptUnreliable, setAcceptUnreliable] = useState(false);
  const [note, setNote] = useState("");
  const [override, setOverride] = useState(false);
  // The panel stays closed until the developer clicks "Generate the project" (it opens by itself when a run already exists).
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const log = useRef<HTMLDivElement>(null);

  const job = jobs?.[0] ?? null;
  const status = jobs ? (job ? jobStatusLabel(job) : null) : null;
  const pay = paymentStatus(lead.quotation, lead.payments);
  const advanceMissing = lead.stage === "approved" && pay.advanceRemaining > 0;

  const refreshLead = useCallback(async () => {
    const r = await jsonFetch<{ lead: Lead; history: History }>(`/api/business/leads/${lead.id}`).catch(() => null);
    if (r) onChanged(r);
  }, [lead.id, onChanged]);

  const loadJobs = useCallback(async () => {
    const r = await api<{ jobs: Job[] }>(`/api/execution/leads/${lead.id}`);
    if (r.ok) setJobs(r.data.jobs);
    else setError(r.data.error ?? "Could not load the generation jobs.");
  }, [lead.id]);
  const loadSettings = useCallback(async () => {
    const [s, st] = await Promise.all([api<{ settings: ExecutionSettings }>("/api/execution/settings"), api<{ claude: ClaudeStatus }>("/api/execution/status")]);
    if (s.ok) setSettings(s.data.settings);
    if (st.ok) setClaude(st.data.claude);
  }, []);
  useEffect(() => { void loadJobs(); void loadSettings(); }, [loadJobs, loadSettings]);
  // Another panel (for example "Start without payment") started a run: show it.
  useEffect(() => {
    const reload = () => { void loadJobs(); };
    window.addEventListener(JOBS_CHANGED, reload);
    return () => window.removeEventListener(JOBS_CHANGED, reload);
  }, [loadJobs]);

  // Progress: while a job runs, fetch the new log lines every second and a half.
  const jobId = job?.id;
  const active = job?.state === "running";
  // The last log line seen. A ref, because the polling timer must not read a stale copy of `events`.
  const lastSeq = useRef(0);
  useEffect(() => { setEvents([]); lastSeq.current = 0; }, [jobId]);
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    const tick = async () => {
      const after = lastSeq.current;
      const r = await api<{ job: Job; events: JobEvent[] }>(`/api/execution/jobs/${jobId}?after=${after}`);
      if (stop || !r.ok) return;
      // Only lines newer than the last one seen, so a repeated or overlapping poll can never duplicate a line (or a React key).
      const fresh = r.data.events.filter((e) => e.seq > lastSeq.current);
      if (fresh.length) {
        lastSeq.current = fresh[fresh.length - 1].seq;
        setEvents((prev) => [...prev, ...fresh]);
      }
      setJobs((prev) => (prev ? prev.map((j) => (j.id === jobId ? r.data.job : j)) : prev));
      if (r.data.job.state !== "running") void refreshLead();
    };
    void tick();
    if (!active) return () => { stop = true; };
    const timer = setInterval(() => void tick(), 1500);
    return () => { stop = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, active]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [events.length]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  };
  const act = (action: string, body: object = {}) => api<{ job: Job }>(`/api/execution/jobs/${job!.id}/${action}`, body);

  const prepare = () => run("prepare", async () => {
    const r = await api<{ job: Job }>(`/api/execution/leads/${lead.id}/prepare`, { scopeConfirmed: scopeOk });
    if (!r.ok) throw new Error(r.data.error);
    await loadJobs();
  });
  const start = (chosen: ExecMode, approval?: { estimate: ApiEstimate; accept: boolean }) => run("start", async () => {
    const body = { mode: chosen, withoutAdvance, reason, ...(approval ? { apiApproval: { confirmed: true, estimateUsd: approval.estimate.estimatedUsd, limitUsd: approval.estimate.limitUsd, acceptUnreliable: approval.accept } } : {}) };
    const r = await act("start", body);
    if (r.ok) { setDialog(null); setApproveRun(false); setAcceptUnreliable(false); await loadJobs(); await refreshLead(); return; }
    if (r.data.code === "approval-required" && r.data.estimate) { setDialog(r.data.estimate); await loadJobs(); return; }
    setDialog(null);
    throw new Error(r.data.error);
  });
  const closeDialog = () => run("decline", async () => {
    await act("decline-api");
    setDialog(null); setApproveRun(false); setAcceptUnreliable(false);
    await loadJobs();
  });
  const cancel = () => run("cancel", async () => { const r = await act("cancel"); if (!r.ok) throw new Error(r.data.error); await loadJobs(); await refreshLead(); });
  const restart = (thenApi = false) => run("restart", async () => {
    const r = await act("restart", { scopeConfirmed: scopeOk });
    if (!r.ok) throw new Error(r.data.error);
    await loadJobs();
    if (thenApi) {
      const s = await api<{ job: Job }>(`/api/execution/jobs/${r.data.job.id}/start`, { mode: "api", withoutAdvance, reason });
      if (s.data.code === "approval-required" && s.data.estimate) setDialog(s.data.estimate);
      else if (!s.ok) throw new Error(s.data.error);
      await loadJobs();
    }
  });
  const review = (decision: "approved" | "changes-requested") => run("review", async () => { const r = await act("review", { decision, note, overrideVerification: override }); if (!r.ok) throw new Error(r.data.error); await loadJobs(); });
  const markReady = () => run("ready", async () => { const r = await act("ready"); if (!r.ok) throw new Error(r.data.error); await loadJobs(); await refreshLead(); });

  if (!jobs) return <p className="flex items-center gap-2 text-xs text-slate-400">{error ? <span className="text-rose-300">{error}</span> : <><Loader2 size={14} className="animate-spin" /> Loading...</>}</p>;

  const prepared = job && (job.state === "prepared" || job.state === "waiting-approval");
  const finished = job && ["completed", "failed", "cancelled"].includes(job.state);
  const reviewed = job?.review?.status === "approved";
  const ready = lead.stage === "demo_ready";
  const localReady = claude?.ready === true;
  const apiOn = settings?.apiEnabled === true;

  // Hidden until the developer asks for it: one button, then the whole panel.
  if (!open && !job) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3" data-testid="execution-collapsed">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-100"><Hammer size={16} className="text-violet-300" /> Ready to build the website?</p>
          <p className="mt-1 text-xs text-slate-400">The project is built from whatever the client has uploaded above. Anything not uploaded gets a clearly marked placeholder.</p>
        </div>
        <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-500 to-indigo-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-500/25 transition hover:brightness-110" data-testid="open-generate">
          <Hammer size={15} /> Generate the project
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="execution-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-100"><Hammer size={16} className="text-violet-300" /> Generate the project</p>
          <p className="mt-1 text-xs text-slate-400">The approved quotation does not start anything by itself. You confirm the scope, choose how to run it, and review the result.</p>
        </div>
        {status && <span className={cn("rounded-full border px-3 py-1 text-[11px] font-semibold", TONE[status])} data-testid="job-status">{status}</span>}
      </div>

      <ol className="space-y-4">
        <Step done title="1. The client approved the quotation" />

        <Step done={!!job} active={!job} title="2. Confirm the approved scope">
          {!job && (
            <>
              <label className="flex items-start gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={scopeOk} onChange={(e) => setScopeOk(e.target.checked)} className="mt-0.5 accent-violet-500" data-testid="confirm-scope" />
                I confirm the approved scope of quotation {lead.quotation?.number}: exactly the pages, features and technology the client approved, and nothing from Phase 2.
              </label>
              <button type="button" onClick={prepare} disabled={!scopeOk || !!busy} className="flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-400 disabled:opacity-40" data-testid="prepare">
                {busy === "prepare" && <Loader2 size={13} className="animate-spin" />} Prepare workspace and brief
              </button>
            </>
          )}
        </Step>

        <Step done={!!job} title="3. Workspace and development brief prepared">
          {job && <p className="text-[11px] text-slate-400">Folder <span className="font-mono text-slate-200">{job.projectName}</span> · approved brief {job.briefBytes} bytes (locked: it is checked again before every run).</p>}
        </Step>

        <Step done={!!job && job.state !== "prepared" && job.state !== "waiting-approval"} active={!!prepared} title="4. Choose how to run it">
          {prepared && settings && (
            <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className={cn("flex cursor-pointer gap-2 rounded-lg border p-3 text-xs", mode === "local" ? "border-emerald-400/50 bg-emerald-500/[.07]" : "border-white/[.08]")}>
                  <input type="radio" name="mode" checked={mode === "local"} onChange={() => setMode("local")} className="mt-0.5 accent-emerald-500" aria-label="Local Claude Code" />
                  <span>
                    <span className="flex items-center gap-1.5 font-semibold text-slate-100"><Cpu size={13} /> Local Claude Code <span className="rounded-full bg-emerald-500/20 px-1.5 text-[9px] text-emerald-200">Default</span></span>
                    <span className="mt-0.5 block text-[11px] text-slate-400">Your own subscription, on this computer. No API charge.</span>
                    <span className={cn("mt-1 block text-[11px]", localReady ? "text-emerald-300" : "text-amber-200")}>{claude ? claude.message : "Checking Claude Code..."}</span>
                  </span>
                </label>
                <label className={cn("flex gap-2 rounded-lg border p-3 text-xs", apiOn ? "cursor-pointer" : "cursor-not-allowed opacity-60", mode === "api" ? "border-amber-400/50 bg-amber-500/[.07]" : "border-white/[.08]")}>
                  <input type="radio" name="mode" checked={mode === "api"} disabled={!apiOn} onChange={() => setMode("api")} className="mt-0.5 accent-amber-500" aria-label="Anthropic API" />
                  <span>
                    <span className="flex items-center gap-1.5 font-semibold text-slate-100"><ShieldCheck size={13} /> Anthropic API <span className="rounded-full bg-white/10 px-1.5 text-[9px] text-slate-300">Optional</span></span>
                    <span className="mt-0.5 block text-[11px] text-slate-400">Paid per use. Asks for your approval of the estimated cost before it starts.</span>
                    {!apiOn && <span className="mt-1 block text-[11px] text-slate-500">Turned off in Execution settings.</span>}
                  </span>
                </label>
              </div>

              {advanceMissing && (
                <div className="space-y-2 rounded-lg border border-amber-400/25 bg-amber-500/[.07] p-3 text-xs">
                  <p className="flex items-center gap-1.5 font-medium text-amber-100"><AlertTriangle size={14} /> Advance of {formatINR(pay.advanceRemaining)} not received yet.</p>
                  <label className="flex items-center gap-2 text-slate-300"><input type="checkbox" checked={withoutAdvance} onChange={(e) => setWithoutAdvance(e.target.checked)} className="accent-violet-500" /> Start without advance (your decision)</label>
                  {withoutAdvance && <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Why? e.g. regular client, paying on Friday" className="w-full rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-xs text-slate-100 outline-none focus:border-violet-400/60" />}
                </div>
              )}

              <button type="button" onClick={() => void start(mode)} disabled={!!busy || (mode === "local" && !localReady)} className={cn("flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold text-white disabled:opacity-40", mode === "api" ? "bg-amber-600 hover:bg-amber-500" : "bg-emerald-600 hover:bg-emerald-500")} data-testid="start">
                {busy === "start" ? <Loader2 size={13} className="animate-spin" /> : <Hammer size={13} />} {mode === "local" ? "Start with Local Claude Code" : "Review cost and run with the API"}
              </button>
              {mode === "local" && !localReady && <p className="text-[11px] text-amber-200">Local generation cannot start until Claude Code is installed and signed in. SILPI will not switch to the API by itself.</p>}
            </div>
          )}
        </Step>

        <Step done={!!finished && job!.state === "completed"} active={job?.state === "running"} title="5. Generation">
          {job && job.state !== "prepared" && job.state !== "waiting-approval" && (
            <div className="space-y-2">
              <div ref={log} className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-white/[.06] bg-black/30 p-2.5 font-mono text-[11px] leading-5" data-testid="job-log">
                {events.length === 0 ? <p className="text-slate-600">No output yet.</p> : events.map((e) => (
                  <p key={e.seq} className={cn(e.kind === "error" ? "text-rose-300" : e.kind === "result" ? "text-emerald-300" : e.kind === "action" ? "text-sky-300" : "text-slate-300")}>
                    <span className="text-slate-600">{new Date(e.at).toLocaleTimeString("en-IN")} </span>{e.text}
                  </p>
                ))}
              </div>
              {job.state === "running" && (
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1.5 text-[11px] text-slate-400"><Loader2 size={12} className="animate-spin" /> {job.phase === "verifying" ? "Building and testing..." : "Generating..."}</span>
                  <button type="button" onClick={cancel} disabled={!!busy} className="flex items-center gap-1.5 rounded-md border border-rose-400/40 px-3 py-1.5 text-[11px] text-rose-200 hover:bg-rose-500/10 disabled:opacity-50" data-testid="cancel"><Ban size={12} /> Cancel run</button>
                </div>
              )}
              {job.error && job.state !== "running" && <p className="text-[11px] text-rose-300">{job.error}</p>}
            </div>
          )}
        </Step>

        <Step done={!!job?.verification?.passed} active={job?.phase === "verifying"} title="6. Tests and build">
          {job?.verification && (
            <ul className="space-y-0.5 text-[11px]">
              {job.verification.steps.map((s) => (
                <li key={s.name} className={cn(s.status === "failed" ? "text-rose-300" : s.status === "skipped" ? "text-slate-500" : "text-emerald-300")}>{s.status === "passed" ? "Passed" : s.status === "failed" ? "Failed" : "Skipped"}: {s.name}{s.note ? ` · ${s.note}` : ""}</li>
              ))}
            </ul>
          )}
        </Step>

        <Step done={reviewed} active={job?.state === "completed" && !reviewed} title="7. Developer review">
          {job?.state === "completed" && (
            <div className="space-y-2 text-xs">
              {job.result?.summary && <p className="rounded-lg bg-white/[.04] p-2.5 text-[11px] leading-5 text-slate-300">{job.result.summary}</p>}
              <p className="text-[11px] text-slate-500">{job.cost ? job.cost.note : ""}{job.cost?.actualUsd !== undefined ? ` Agent-calculated cost: $${job.cost.actualUsd.toFixed(2)}.` : ""}</p>
              {!job.review ? (
                <>
                  <p className="text-slate-300">Open the generated project and check it against the quotation before approving.</p>
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Review note (optional)" className="min-h-14 w-full rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-xs text-slate-100 outline-none focus:border-violet-400/60" />
                  {job.verification && !job.verification.passed && (
                    <label className="flex items-center gap-2 text-amber-200"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} className="accent-amber-500" /> The build or tests failed. Approve anyway (needs a note of at least 10 characters).</label>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => void review("approved")} disabled={!!busy} className="rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500 disabled:opacity-50" data-testid="review-approve">Approve the generated project</button>
                    <button type="button" onClick={() => void review("changes-requested")} disabled={!!busy} className="rounded-lg border border-white/10 px-3 py-1.5 text-slate-300 hover:bg-white/5 disabled:opacity-50">Request changes</button>
                  </div>
                </>
              ) : (
                <p className={cn("font-medium", job.review.status === "approved" ? "text-emerald-300" : "text-amber-200")}>{job.review.status === "approved" ? "Review approved." : "Changes requested."}{job.review.note ? ` ${job.review.note}` : ""}</p>
              )}
            </div>
          )}
        </Step>

        <Step done={ready} active={reviewed && !ready} title="8. Ready for delivery">
          {reviewed && !ready && (
            <button type="button" onClick={markReady} disabled={!!busy} className="rounded-lg bg-violet-500 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-400 disabled:opacity-50" data-testid="mark-ready">Mark ready for delivery</button>
          )}
          {ready && <p className="text-[11px] text-emerald-300">Marked ready for delivery.</p>}
        </Step>
      </ol>

      {(job?.state === "failed" || job?.state === "cancelled") && (
        <div className="space-y-2 rounded-lg border border-white/[.08] bg-white/[.03] p-3 text-xs">
          <p className="font-medium text-slate-200">{job.state === "failed" ? "The run failed." : "The run was cancelled."} Nothing was run with the API. You decide what happens next.</p>
          <label className="flex items-start gap-2 text-slate-300"><input type="checkbox" checked={scopeOk} onChange={(e) => setScopeOk(e.target.checked)} className="mt-0.5 accent-violet-500" /> I confirm the approved scope again.</label>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void restart(false)} disabled={!scopeOk || !!busy} className="flex items-center gap-1.5 rounded-lg bg-violet-500 px-3 py-1.5 font-semibold text-white hover:bg-violet-400 disabled:opacity-40" data-testid="restart"><RotateCcw size={12} /> Restart (choose how to run it)</button>
            {job.mode === "local" && settings?.apiEnabled && settings.apiFallbackOffer && (
              <button type="button" onClick={() => void restart(true)} disabled={!scopeOk || !!busy} className="rounded-lg border border-amber-400/40 px-3 py-1.5 text-amber-100 hover:bg-amber-500/10 disabled:opacity-40" data-testid="offer-api">Restart and run with the API instead (asks for cost approval)</button>
            )}
          </div>
        </div>
      )}

      {error && <p className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-200" data-testid="exec-error">{error}</p>}

      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Approve API-funded execution" data-testid="api-dialog">
          <div className="w-full max-w-md space-y-3 rounded-2xl border border-amber-400/40 bg-[#171b26] p-5 text-xs shadow-2xl">
            <p className="flex items-center gap-2 text-sm font-semibold text-amber-100"><ShieldCheck size={16} /> API-funded execution</p>
            <p className="text-slate-300">This run is paid by usage on your Anthropic account. It is not covered by your Claude subscription.</p>
            <dl className="space-y-1.5 rounded-lg bg-white/[.04] p-3">
              <div className="flex justify-between gap-3"><dt className="text-slate-400">Estimated cost</dt><dd className="font-semibold text-white">{dialog.estimatedUsd === null ? "Cannot be estimated" : `about $${dialog.estimatedUsd.toFixed(2)}`}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-400">Spending limit</dt><dd className="font-semibold text-white">{dialog.limitUsd === null ? "Not set" : `$${dialog.limitUsd.toFixed(2)}`}</dd></div>
              <p className="text-[11px] text-slate-500">{dialog.basis}</p>
            </dl>
            <p className="text-slate-400">The run stops by itself at the spending limit.</p>
            {!dialog.reliable && (
              <label className="flex items-start gap-2 text-amber-200"><input type="checkbox" checked={acceptUnreliable} onChange={(e) => setAcceptUnreliable(e.target.checked)} className="mt-0.5 accent-amber-500" data-testid="accept-unreliable" /> The cost cannot be estimated reliably. I accept a cost of up to the spending limit.</label>
            )}
            <label className="flex items-start gap-2 text-slate-200"><input type="checkbox" checked={approveRun} onChange={(e) => setApproveRun(e.target.checked)} className="mt-0.5 accent-amber-500" data-testid="approve-api" /> I approve this API-funded run.</label>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => void closeDialog()} className="rounded-lg border border-white/10 px-3 py-1.5 text-slate-300 hover:bg-white/5" data-testid="api-cancel">Cancel: do not run</button>
              <button type="button" disabled={!approveRun || (!dialog.reliable && !acceptUnreliable) || !!busy || dialog.limitUsd === null} onClick={() => void start("api", { estimate: dialog, accept: acceptUnreliable })} className="rounded-lg bg-amber-600 px-3 py-1.5 font-semibold text-white hover:bg-amber-500 disabled:opacity-40" data-testid="api-confirm">Approve and run with the API</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Project generation for an approved quotation. Admin only. Replaces the old one-click "Start development". */
export function ExecutionPanel({ lead, onChanged }: { lead: Lead; onChanged: (r: { lead: Lead; history: History }) => void }) {
  return (
    <Card className="no-print space-y-3 border-violet-400/25">
      {DEV_START_WITHOUT_PAYMENT ? (
        <Body lead={lead} onChanged={onChanged} />
      ) : (
        <AdminGate label="project generation">
          <Body lead={lead} onChanged={onChanged} />
        </AdminGate>
      )}
    </Card>
  );
}

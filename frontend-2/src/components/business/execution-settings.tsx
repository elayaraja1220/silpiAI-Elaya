"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, Cpu, Loader2, RefreshCw, Save, ShieldCheck } from "lucide-react";

import { jobStatusLabel, type ApiEstimate, type ClaudeStatus, type ExecutionSettings, type JobState, type ExecMode } from "@/lib/execution/types";
import { cn } from "@/lib/utils";

import { AdminGate } from "./admin-gate";
import { Card, jsonFetch } from "./ui";

type Status = {
  claude: ClaudeStatus;
  workspaceConfigured: boolean;
  apiAgentConfigured: boolean;
  lastExecution: { projectName: string; state: JobState; mode: ExecMode | null; updatedAt: string; finishedAt: string | null; error: string | null; verificationPassed: boolean | null } | null;
};

const SOURCES: Record<string, string> = { configured: "the path in these settings", path: "your PATH", "standard-location": "the standard install folder", "vscode-extension": "the Claude Code extension for VS Code" };
const input = "w-full rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-violet-400/60";

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} className={cn("relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-40", on ? "bg-amber-500" : "bg-white/15")}>
      <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", on ? "left-[22px]" : "left-0.5")} />
    </button>
  );
}

function Body() {
  const [settings, setSettings] = useState<ExecutionSettings | null>(null);
  const [draft, setDraft] = useState<ExecutionSettings | null>(null);
  const [estimate, setEstimate] = useState<ApiEstimate | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const loadStatus = useCallback(() => {
    setChecking(true);
    jsonFetch<Status>("/api/execution/status").then(setStatus).catch((e: Error) => setMessage({ ok: false, text: e.message })).finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    jsonFetch<{ settings: ExecutionSettings; apiEstimate: ApiEstimate }>("/api/execution/settings")
      .then((r) => { setSettings(r.settings); setDraft(r.settings); setEstimate(r.apiEstimate); })
      .catch((e: Error) => setMessage({ ok: false, text: e.message }));
    loadStatus();
  }, [loadStatus]);

  if (!draft || !settings) return <Card className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={14} className="animate-spin" /> Loading execution settings...</Card>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const set = (patch: Partial<ExecutionSettings>) => setDraft({ ...draft, ...patch });

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await jsonFetch<{ settings: ExecutionSettings; apiEstimate: ApiEstimate }>("/api/execution/settings", { method: "PUT", body: JSON.stringify({ settings: draft }) });
      setSettings(r.settings);
      setDraft(r.settings);
      setEstimate(r.apiEstimate);
      setMessage({ ok: true, text: "Saved." });
      loadStatus();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const claude = status?.claude;
  const last = status?.lastExecution;
  const apiNeedsLimit = draft.apiEnabled && !(draft.apiSpendLimitUsd && draft.apiSpendLimitUsd > 0);

  return (
    <div className="space-y-4" data-testid="execution-settings">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2 rounded-xl border border-emerald-400/30 bg-emerald-500/[.06] p-4" data-testid="mode-local">
          <p className="flex items-center gap-2 text-xs font-semibold text-emerald-100"><Cpu size={14} /> Local Claude Code <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px]">Default</span></p>
          <p className="text-[11px] leading-5 text-slate-300">Runs on this computer with your own Claude subscription sign-in. No API key is needed and no API charge is made. SILPI never reads or sends your Claude login.</p>
          <div className="space-y-1 text-[11px]" data-testid="claude-status">
            <p className="flex items-center gap-1.5 text-slate-200">{claude?.installed ? <CheckCircle2 size={13} className="text-emerald-300" /> : <CircleDashed size={13} className="text-amber-300" />} Claude Code: {claude ? (claude.installed ? `installed (version ${claude.version ?? "unknown"}, found in ${SOURCES[claude.source ?? ""] ?? "this computer"})` : "not found") : "checking..."}</p>
            <p className="flex items-center gap-1.5 text-slate-200">{claude?.ready ? <CheckCircle2 size={13} className="text-emerald-300" /> : <CircleDashed size={13} className="text-amber-300" />} Authentication: {claude ? (claude.auth ? claude.auth.message : "not checked, because Claude Code was not found") : "checking..."}</p>
            <p className="flex items-center gap-1.5 text-slate-200">{status?.workspaceConfigured ? <CheckCircle2 size={13} className="text-emerald-300" /> : <CircleDashed size={13} className="text-amber-300" />} Projects folder: {status ? (status.workspaceConfigured ? "configured" : "not configured (set SILPI_AGENT_DIR in .env.local)") : "checking..."}</p>
          </div>
          <button type="button" onClick={loadStatus} disabled={checking} className="flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] text-slate-200 hover:bg-white/5 disabled:opacity-50"><RefreshCw size={12} className={checking ? "animate-spin" : ""} /> Check again</button>
        </div>

        <div className={cn("space-y-3 rounded-xl border p-4", draft.apiEnabled ? "border-amber-400/40 bg-amber-500/[.06]" : "border-white/[.08] bg-white/[.02]")} data-testid="mode-api">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="flex items-center gap-2 text-xs font-semibold text-slate-100"><ShieldCheck size={14} className="text-amber-300" /> Anthropic API <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-slate-300">Optional, off by default</span></p>
              <p className="mt-1 text-[11px] leading-5 text-slate-400">Paid per use from your Anthropic account. Every run needs its own cost approval. It is never used automatically.</p>
            </div>
            <Toggle on={draft.apiEnabled} onChange={(v) => set({ apiEnabled: v })} label="Anthropic API mode" />
          </div>
          <label className="block space-y-1 text-[11px] text-slate-400">
            API spending limit per run (US dollars)
            <input aria-label="API spending limit" type="number" min={0.01} step={0.5} value={draft.apiSpendLimitUsd ?? ""} placeholder="Not set" onChange={(e) => set({ apiSpendLimitUsd: e.target.value === "" ? null : Number(e.target.value) })} className={input} />
            <span className="block text-slate-500">A run is stopped at this amount. API runs are refused until a limit is set.</span>
          </label>
          {apiNeedsLimit && <p className="flex items-center gap-1.5 text-[11px] text-amber-200"><AlertTriangle size={12} /> Set a spending limit, or API runs will be refused.</p>}
          <div className="flex items-start justify-between gap-3 border-t border-white/[.06] pt-3">
            <p className="text-[11px] leading-5 text-slate-400"><span className="font-semibold text-slate-200">API fallback</span> (off by default): after a local run fails, offer a button to run with the API instead. It never starts by itself and still asks for the cost approval.</p>
            <Toggle on={draft.apiFallbackOffer} onChange={(v) => set({ apiFallbackOffer: v })} label="API fallback offer" disabled={!draft.apiEnabled} />
          </div>
          {estimate && <p className="text-[11px] text-slate-500">Estimate for the next API run: {estimate.estimatedUsd === null ? "not available." : `about $${estimate.estimatedUsd.toFixed(2)}.`} {estimate.basis}</p>}
        </div>
      </div>

      <details className="rounded-xl border border-white/[.06] p-4 text-[11px] text-slate-400">
        <summary className="cursor-pointer text-xs font-semibold text-slate-200">Advanced: Claude Code location and limits</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 sm:col-span-3">Path to Claude Code (only if it is not found by itself)
            <input aria-label="Claude Code path" value={draft.claudePath ?? ""} placeholder="e.g. C:\Users\you\.local\bin\claude.exe" onChange={(e) => set({ claudePath: e.target.value.trim() === "" ? null : e.target.value })} className={input} />
          </label>
          <label className="space-y-1">Most steps per run<input aria-label="Local max turns" type="number" min={5} max={300} value={draft.localMaxTurns} onChange={(e) => set({ localMaxTurns: Number(e.target.value) })} className={input} /></label>
          <label className="space-y-1">Stop after (minutes)<input aria-label="Local timeout minutes" type="number" min={2} max={240} value={draft.localTimeoutMinutes} onChange={(e) => set({ localTimeoutMinutes: Number(e.target.value) })} className={input} /></label>
        </div>
      </details>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[.06] p-4 text-xs" data-testid="last-execution">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Last execution</p>
          {last ? (
            <p className="mt-1 text-slate-200">
              <span className="font-semibold">{jobStatusLabel(last)}</span> · {last.projectName} · {new Date(last.finishedAt ?? last.updatedAt).toLocaleString("en-IN")}
              {last.error && <span className="block text-rose-300">{last.error}</span>}
              {last.verificationPassed === false && <span className="block text-amber-200">The build or tests failed.</span>}
            </p>
          ) : <p className="mt-1 text-slate-500">Nothing has been generated yet.</p>}
        </div>
        <button type="button" onClick={save} disabled={busy || !dirty} className="flex items-center gap-1.5 rounded-lg bg-violet-500 px-4 py-2 font-semibold text-white hover:bg-violet-400 disabled:opacity-40">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save execution settings
        </button>
      </div>
      {message && <p className={cn("rounded-lg border px-3 py-2 text-xs", message.ok ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200" : "border-rose-400/30 bg-rose-500/10 text-rose-200")}>{message.text}</p>}
    </div>
  );
}

/** The Execution settings section of the Settings page. Admin only. */
export function ExecutionSettingsSection() {
  return (
    <section className="space-y-3 rounded-xl border border-white/[.07] bg-[#151923] p-5">
      <div>
        <h3 className="text-xs font-semibold">Execution settings</h3>
        <p className="mt-0.5 text-[11px] text-slate-500">How approved projects are generated. Local Claude Code is the default; the Anthropic API is optional and always needs your approval.</p>
      </div>
      <AdminGate label="execution settings">
        <Body />
      </AdminGate>
    </section>
  );
}

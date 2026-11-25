"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, CircleDashed, Download, Loader2, X } from "lucide-react";

import { WALLET_CHANGED } from "./ai-shell";
import { api, ApiError, Button, Card, credits, inputClass, Notice, Pill } from "./light";
import { STATUS_LABEL, STATUS_TONE } from "./builder";

type Job = { id: string; title: string; brief: string; quality: string; review: boolean; status: string; pauseReason: string | null; message: string; planSummary: string; budgetUnits: number; spentUnits: number };
type Step = { seq: number; kind: "plan" | "file" | "review"; label: string; model: string; status: "pending" | "running" | "completed" | "failed" | "skipped"; chargedUnits: number; modelUsed: string | null; error: string | null; hasOutput: boolean };
type Estimate = { maxUnits: number; steps: { seq: number; label: string; model: string; maxUnits: number }[] };
type Detail = { job: Job; steps: Step[]; estimate: Estimate | null; wallet: { availableUnits: number } };
type File = { path: string; content: string };

const LIVE = ["planning", "running"];
const MODEL_NAME: Record<string, string> = { fast: "Fast", balanced: "Balanced", best: "Best", "silpi-demo": "Demo" };

function StepIcon({ status }: { status: Step["status"] }) {
  if (status === "completed") return <Check size={15} className="text-emerald-600" />;
  if (status === "running") return <Loader2 size={15} className="animate-spin text-indigo-600" />;
  if (status === "failed") return <X size={15} className="text-rose-600" />;
  return <CircleDashed size={15} className="text-slate-300" />;
}

const download = (name: string, text: string, type = "text/plain") => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

/** One build: its plan, the budget, every step with its cost, and the files as they are produced. Refreshes itself while the build is running. */
export function JobView({ id }: { id: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [budget, setBudget] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [shown, setShown] = useState<{ title: string; text: string } | null>(null);
  const budgetTouched = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await api<Detail>(`/api/workspace/jobs/${id}`);
      setD(r);
      setError("");
      window.dispatchEvent(new Event(WALLET_CHANGED));
      if (r.steps.some((s) => s.kind === "file" && s.status === "completed")) setFiles((await api<{ files: File[] }>(`/api/workspace/jobs/${id}/files`)).files);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!d || !LIVE.includes(d.job.status)) return;
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [d, load]);
  // Suggest the budget the server computed (spent + worst case of the rest), unless the person has typed their own.
  useEffect(() => {
    if (d?.estimate && !budgetTouched.current) setBudget(credits(d.job.spentUnits + d.estimate.maxUnits).replace(/,/g, ""));
  }, [d]);

  const act = async (what: "approve" | "resume" | "cancel", body: object = {}) => {
    setBusy(what);
    setError("");
    try {
      await api(`/api/workspace/jobs/${id}/${what}`, { method: "POST", body });
      budgetTouched.current = false;
      await load();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy("");
    }
  };
  const view = async (s: Step) => {
    const r = await api<{ output: string | null }>(`/api/workspace/jobs/${id}/steps/${s.seq}`).catch(() => ({ output: null }));
    setShown({ title: s.label, text: r.output ?? "" });
  };

  if (!d) return error ? <Notice tone="red">{error}</Notice> : <Card className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Loading...</Card>;
  const { job, steps, estimate, wallet } = d;
  const finished = ["completed", "failed", "cancelled"].includes(job.status);
  const pct = job.budgetUnits > 0 ? Math.min(100, Math.round((job.spentUnits / job.budgetUnits) * 100)) : 0;
  const budgetUnits = Math.round(Number(budget) * 1000);
  const tooMuch = Number.isFinite(budgetUnits) && budgetUnits > wallet.availableUnits + job.spentUnits;
  const canResume = job.status === "paused" && job.pauseReason !== "needs_approval";

  return (
    <div className="space-y-5">
      <Link href="/ai/builder" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft size={14} /> All builds</Link>

      <Card className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-slate-900">{job.title}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500"><Pill tone={STATUS_TONE[job.status] ?? "slate"}>{STATUS_LABEL[job.status] ?? job.status}</Pill><span className="capitalize">{job.quality} quality</span></p>
          </div>
          <div className="flex gap-2">
            {canResume && <Button onClick={() => void act("resume")} disabled={!!busy}>{busy === "resume" && <Loader2 size={15} className="animate-spin" />} Resume</Button>}
            {!finished && <Button variant="ghost" onClick={() => void act("cancel")} disabled={!!busy}>Cancel build</Button>}
          </div>
        </div>
        {job.planSummary && <p className="text-sm text-slate-700">{job.planSummary}</p>}
        {job.message && <Notice tone={job.status === "failed" ? "red" : job.status === "paused" ? "amber" : "slate"}>{job.message}</Notice>}
        {error && <Notice tone="red">{error}</Notice>}
        <div>
          <div className="flex justify-between text-xs text-slate-500"><span>Spent <b className="text-slate-800">{credits(job.spentUnits)}</b> credits</span><span>{job.budgetUnits > 0 ? `Budget ${credits(job.budgetUnits)} credits` : "No budget approved yet"}</span></div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Budget used"><div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} /></div>
        </div>
      </Card>

      {estimate && (
        <Card className="space-y-3 border-indigo-200">
          <h3 className="text-sm font-semibold text-slate-900">{job.status === "paused" ? "More budget needed" : "Approve the budget to start building"}</h3>
          <p className="text-sm text-slate-600">The remaining {estimate.steps.length} steps could use <b>up to {credits(estimate.maxUnits)} credits</b> in the worst case. You pay only the real cost; the budget is a ceiling the build will never pass.</p>
          <ul className="divide-y divide-slate-100 text-sm">
            {estimate.steps.map((s) => <li key={s.seq} className="flex justify-between py-1.5"><span className="truncate text-slate-700">{s.label} <span className="text-xs text-slate-400">· {MODEL_NAME[s.model] ?? s.model}</span></span><span className="tabular-nums text-slate-600">up to {credits(s.maxUnits)}</span></li>)}
          </ul>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-slate-600">Total budget (credits)
              <input value={budget} onChange={(e) => { budgetTouched.current = true; setBudget(e.target.value.replace(/[^\d.]/g, "")); }} inputMode="decimal" className={inputClass + " mt-1 w-40"} aria-label="Total budget in credits" />
            </label>
            <Button onClick={() => void act("approve", { budgetUnits })} disabled={!!busy || !budget || !Number.isFinite(budgetUnits) || budgetUnits < job.spentUnits}>{busy === "approve" && <Loader2 size={15} className="animate-spin" />} Approve and {job.status === "paused" ? "continue" : "start"}</Button>
            <span className="pb-2 text-xs text-slate-500">{credits(wallet.availableUnits)} credits available</span>
          </div>
          {tooMuch && <Notice tone="amber">This budget is more than you have available now. The build will pause if the credits run out, and you can add more and resume.</Notice>}
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <Card className="space-y-2 self-start">
          <h3 className="text-sm font-semibold text-slate-900">Steps</h3>
          <ul className="space-y-1">
            {steps.map((s) => (
              <li key={s.seq} className="flex items-start gap-2 rounded-lg px-1 py-1.5 text-sm">
                <span className="mt-0.5"><StepIcon status={s.status} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-slate-800">{s.hasOutput && s.kind !== "file" ? <button onClick={() => void view(s)} className="text-left text-indigo-700 underline-offset-2 hover:underline">{s.label}</button> : s.label}</span>
                  <span className="block text-[11px] text-slate-400">{MODEL_NAME[s.modelUsed ?? s.model] ?? s.modelUsed ?? s.model}{s.status === "completed" && ` · ${s.chargedUnits === 0 ? "free" : `${credits(s.chargedUnits)} cr`}`}{s.status === "failed" && s.error ? ` · ${s.error}` : ""}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900">Files {files.length > 0 && <span className="font-normal text-slate-400">({files.length})</span>}</h3>
            {files.length > 0 && <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => download(`${job.title.replace(/[^\w-]+/g, "_") || "project"}.json`, JSON.stringify({ title: job.title, files }, null, 2), "application/json")}><Download size={13} /> Download all (JSON)</Button>}
          </div>
          {files.length === 0 && !shown ? <p className="text-sm text-slate-500">Files appear here as they are written. Generated files are saved with your build.</p> : (
            <div className="grid gap-3 md:grid-cols-[190px_1fr]">
              <ul className="space-y-0.5 text-sm">{files.map((f) => <li key={f.path}><button onClick={() => setShown({ title: f.path, text: f.content })} className="w-full truncate rounded-md px-2 py-1 text-left text-slate-700 hover:bg-slate-100">{f.path}</button></li>)}</ul>
              <div className="min-w-0">
                {shown ? (
                  <>
                    <div className="mb-1.5 flex items-center justify-between gap-2"><span className="truncate text-xs font-medium text-slate-600">{shown.title}</span>
                      <span className="flex gap-3 text-xs"><button onClick={() => void navigator.clipboard?.writeText(shown.text)} className="text-slate-500 hover:text-slate-800">Copy</button><button onClick={() => download(shown.title.split("/").pop() || "file.txt", shown.text)} className="text-slate-500 hover:text-slate-800">Download</button></span></div>
                    <pre className="max-h-[420px] overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-800">{shown.text || "(empty)"}</pre>
                  </>
                ) : <p className="text-sm text-slate-500">Choose a file to read it.</p>}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

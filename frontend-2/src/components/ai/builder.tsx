"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Hammer, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { api, Button, Card, credits, inputClass, Notice, Pill } from "./light";

export type JobSummary = { id: string; title: string; status: string; pauseReason: string | null; quality: string; spentUnits: number; budgetUnits: number; createdAt: string };

export const STATUS_TONE: Record<string, "green" | "red" | "amber" | "slate" | "indigo"> = { completed: "green", failed: "red", cancelled: "slate", paused: "amber", awaiting_approval: "indigo", planning: "indigo", running: "indigo" };
export const STATUS_LABEL: Record<string, string> = { planning: "Planning", awaiting_approval: "Waiting for your approval", running: "Building", paused: "Paused", completed: "Done", failed: "Failed", cancelled: "Cancelled" };

const QUALITY = [
  { value: "economy", title: "Economy", blurb: "Cheapest. Every file on the fast model." },
  { value: "standard", title: "Standard", blurb: "Fast model for simple files, balanced for the main logic." },
  { value: "high", title: "High", blurb: "Balanced model throughout; review on the best model." },
  { value: "demo", title: "Demo (free)", blurb: "No AI. Shows the whole flow with sample output." },
];

/** Start a build and see earlier ones. The brief becomes a plan first; nothing beyond the plan is spent until you approve a budget. */
export function BuilderHome() {
  const router = useRouter();
  const [brief, setBrief] = useState("");
  const [quality, setQuality] = useState("standard");
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);

  // A project idea typed on the front page before signing in is waiting here.
  useEffect(() => {
    try { const saved = sessionStorage.getItem("silpi:brief"); if (saved) { setBrief(saved); sessionStorage.removeItem("silpi:brief"); } } catch { /* ignore */ }
  }, []);
  useEffect(() => { api<{ jobs: JobSummary[] }>("/api/workspace/jobs").then((r) => setJobs(r.jobs)).catch(() => setJobs([])); }, []);

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ job: { id: string } }>("/api/workspace/jobs", { method: "POST", body: { brief, quality, review } });
      router.push(`/ai/builder/${r.job.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <Card className="space-y-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900"><Hammer size={18} /> Build a project</h2>
          <p className="mt-1 text-sm text-slate-600">Describe what you want. The AI first writes a plan (a list of files). You then see the most it could cost and approve a budget before any file is written.</p>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-slate-600">What should it build?</span>
          <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={5} maxLength={4000} className={inputClass} placeholder="For example: a one-page website for a bakery in Chennai with a menu, opening hours and a WhatsApp order button." />
          <span className="mt-1 block text-right text-[11px] text-slate-400">{brief.trim().length} / 4000</span>
        </label>
        <div>
          <p className="mb-1.5 text-xs font-medium text-slate-600">Quality</p>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Quality">
            {QUALITY.map((q) => (
              <button key={q.value} role="radio" aria-checked={quality === q.value} onClick={() => setQuality(q.value)} className={cn("rounded-xl border p-3 text-left transition", quality === q.value ? "border-indigo-500 bg-indigo-50 ring-2 ring-indigo-500/20" : "border-slate-200 bg-white hover:border-slate-300")}>
                <span className="block text-sm font-semibold text-slate-900">{q.title}</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">{q.blurb}</span>
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} className="h-4 w-4 rounded border-slate-300" /> Add a review step at the end (costs more)</label>
        {error && <Notice tone="red">{error}</Notice>}
        <Button onClick={() => void start()} disabled={busy || brief.trim().length < 10}>{busy && <Loader2 size={15} className="animate-spin" />} Create plan</Button>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Your builds</h2>
        {jobs === null ? <p className="text-sm text-slate-400">Loading...</p> : jobs.length === 0 ? <p className="text-sm text-slate-500">No builds yet.</p> : (
          <ul className="divide-y divide-slate-100">
            {jobs.map((j) => (
              <li key={j.id}>
                <Link href={`/ai/builder/${j.id}`} className="block py-2.5 hover:bg-slate-50">
                  <p className="truncate text-sm font-medium text-slate-900">{j.title}</p>
                  <p className="mt-0.5 flex items-center gap-2 text-xs text-slate-500"><Pill tone={STATUS_TONE[j.status] ?? "slate"}>{STATUS_LABEL[j.status] ?? j.status}</Pill><span>{credits(j.spentUnits)} credits</span><span>{new Date(j.createdAt).toLocaleDateString()}</span></p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

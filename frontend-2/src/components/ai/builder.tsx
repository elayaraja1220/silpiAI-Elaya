"use client";

import { useEffect, useRef, useState } from "react";
import { AI_IDEA_KEY, takeIdea } from "@/lib/pending-idea";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUp, Check, ChevronDown, FileCode2, Loader2, ShieldCheck } from "lucide-react";

import { cn } from "@/lib/utils";
import { STATUS_LABEL, STATUS_TONE } from "./build-status";
import { api, credits, Notice, Pill } from "./light";

export type JobSummary = { id: string; title: string; status: string; pauseReason: string | null; quality: string; spentUnits: number; budgetUnits: number; createdAt: string };

export { STATUS_LABEL, STATUS_TONE };

const QUALITY = [
  { value: "economy", title: "Economy", blurb: "Cheapest. Every file on the fast model." },
  { value: "standard", title: "Standard", blurb: "Fast model for simple files, balanced for the main logic." },
  { value: "high", title: "High", blurb: "Balanced model throughout; review on the best model." },
  { value: "demo", title: "Demo (free)", blurb: "No AI. Shows the whole flow with sample output." },
];

/** One-click starting points: they fill the box with the start of a brief for the person to finish. */
const STARTERS = [
  { label: "Business website", text: "A website for my business with a home page, about, services, gallery and a contact form with a WhatsApp button. Business: " },
  { label: "Online store", text: "An online store that lists products with photos and prices, a cart, and a checkout with UPI. Products: " },
  { label: "Booking site", text: "A booking website where customers pick a service, a date and a time and I get an email for each booking. Services: " },
  { label: "Portfolio", text: "A one-page portfolio website with my work, a short about section and a contact form. About me: " },
  { label: "Dashboard", text: "A dashboard web app with sign-in, a list of records I can add and edit, and charts for the totals. Records: " },
  { label: "Blog", text: "A blog with a home page of recent posts, a page for each post, categories and an about page. Topic: " },
];

const TILES = ["from-violet-500 to-indigo-500", "from-fuchsia-500 to-violet-500", "from-sky-500 to-indigo-500", "from-emerald-500 to-teal-500", "from-amber-500 to-rose-500", "from-rose-500 to-fuchsia-500"];
/** A steady colour per build, so a card keeps its look between visits. */
const tileOf = (id: string) => TILES[[...id].reduce((n, c) => n + c.charCodeAt(0), 0) % TILES.length];

const SHOWN = 6;

/** Start a build and see earlier ones. The brief becomes a plan first; nothing beyond the plan is spent until you approve a budget. */
export function BuilderHome() {
  const router = useRouter();
  const [brief, setBrief] = useState("");
  const [quality, setQuality] = useState("standard");
  const [review, setReview] = useState(false);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [all, setAll] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  // A project idea typed on the front page before signing in is waiting here.
  useEffect(() => {
    { const saved = takeIdea(AI_IDEA_KEY); if (saved) setBrief(saved); }
  }, []);
  useEffect(() => { api<{ jobs: JobSummary[] }>("/api/workspace/jobs").then((r) => setJobs(r.jobs)).catch(() => setJobs([])); }, []);

  const start = async () => {
    if (busy || brief.trim().length < 10) return;
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

  const current = QUALITY.find((q) => q.value === quality)!;
  const ready = brief.trim().length >= 10;
  const shown = jobs ? (all ? jobs : jobs.slice(0, SHOWN)) : [];

  return (
    <div className="space-y-14">
      {/* The prompt, front and centre */}
      <section className="relative isolate -mx-4 overflow-hidden rounded-3xl px-4 pb-10 pt-12 text-center sm:mx-0 sm:px-10 sm:pt-16">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_80%_at_50%_0%,rgba(129,140,248,.30),transparent_70%),radial-gradient(40%_50%_at_88%_10%,rgba(56,189,248,.22),transparent_70%),radial-gradient(40%_50%_at_8%_25%,rgba(244,114,182,.22),transparent_70%)]" />
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-5xl">What will you build today?</h1>
        <p className="mx-auto mt-3 max-w-xl text-sm text-slate-600 sm:text-base">Describe it in your own words. The AI writes a plan first and shows the most it could cost. Nothing is spent until you approve.</p>

        <div className="mx-auto mt-8 max-w-3xl rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-[0_20px_60px_-15px_rgba(79,70,229,0.35)] focus-within:border-indigo-400">
          <label htmlFor="builder-brief" className="sr-only">What should it build?</label>
          <textarea
            id="builder-brief"
            ref={box}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void start(); }}
            rows={4}
            maxLength={4000}
            placeholder="For example: a one-page website for a bakery in Chennai with a menu, opening hours and a WhatsApp order button."
            className="w-full resize-none bg-transparent px-2 py-2 text-[15px] leading-6 text-slate-900 outline-none placeholder:text-slate-400"
          />
          <div className="mt-1 flex flex-wrap items-center gap-2 px-1">
            <div className="relative">
              <button type="button" onClick={() => setMenu((v) => !v)} aria-haspopup="listbox" aria-expanded={menu} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
                Quality: <b className="font-semibold text-slate-900">{current.title}</b> <ChevronDown size={13} />
              </button>
              {menu && (
                <>
                  <button type="button" aria-label="Close" className="fixed inset-0 z-10 cursor-default" onClick={() => setMenu(false)} />
                  <ul role="listbox" aria-label="Quality" className="absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-xl border border-slate-200 bg-white p-1 shadow-xl">
                    {QUALITY.map((q) => (
                      <li key={q.value}>
                        <button type="button" role="option" aria-selected={quality === q.value} onClick={() => { setQuality(q.value); setMenu(false); }} className={cn("flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-slate-50", quality === q.value && "bg-indigo-50")}>
                          <Check size={14} className={cn("mt-0.5 shrink-0", quality === q.value ? "text-indigo-600" : "text-transparent")} />
                          <span><span className="block text-sm font-medium text-slate-900">{q.title}</span><span className="block text-[11px] leading-4 text-slate-500">{q.blurb}</span></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <button type="button" role="switch" aria-checked={review} onClick={() => setReview((v) => !v)} title="A review step at the end costs more" className={cn("inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition", review ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")}>
              <ShieldCheck size={13} /> Review step
            </button>
            <span className="ml-auto text-[11px] tabular-nums text-slate-400">{brief.trim().length} / 4000</span>
            <button type="button" onClick={() => void start()} disabled={busy || !ready} aria-label="Create plan" title={ready ? "Create plan (Ctrl+Enter)" : "Write at least 10 characters"} className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-600 text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400">
              {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={17} />}
            </button>
          </div>
        </div>
        <p className="mx-auto mt-3 max-w-3xl text-left text-xs text-slate-500">{current.blurb}</p>
        {error && <div className="mx-auto mt-4 max-w-3xl text-left"><Notice tone="red">{error}</Notice></div>}

        <div className="mx-auto mt-8 flex max-w-3xl flex-wrap items-center justify-center gap-2" aria-label="Ideas to start from">
          <span className="mr-1 text-xs text-slate-500">or start from</span>
          {STARTERS.map((s) => (
            <button key={s.label} type="button" onClick={() => { setBrief(s.text); box.current?.focus(); }} className="rounded-full border border-slate-200 bg-white/80 px-3.5 py-1.5 text-xs text-slate-600 backdrop-blur transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700">{s.label}</button>
          ))}
        </div>
      </section>

      {/* Earlier builds */}
      <section aria-labelledby="builds-heading">
        <div className="mb-4 flex items-end justify-between gap-3">
          <h2 id="builds-heading" className="text-xl font-semibold tracking-tight text-slate-900">Your builds {jobs && jobs.length > 0 && <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 align-middle text-xs font-medium text-slate-600">{jobs.length}</span>}</h2>
          {jobs && jobs.length > SHOWN && <button type="button" onClick={() => setAll((v) => !v)} className="text-sm text-indigo-600 hover:text-indigo-800">{all ? "Show fewer" : `View all ${jobs.length}`}</button>}
        </div>
        {jobs === null ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>{[0, 1, 2].map((i) => <div key={i} className="h-44 animate-pulse rounded-2xl bg-slate-200/70" />)}</div>
        ) : jobs.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
            <FileCode2 size={26} className="mx-auto text-slate-400" />
            <p className="mt-3 text-sm text-slate-700">No builds yet.</p>
            <p className="mt-1 text-xs text-slate-400">Describe an idea above. Your builds will be listed here, so you can come back to them.</p>
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="builds">
            {shown.map((j) => (
              <li key={j.id}>
                <Link href={`/ai/builder/${j.id}`} className="group block overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:border-indigo-300 hover:shadow-md">
                  <div className={cn("flex h-28 items-center justify-center bg-gradient-to-br opacity-90 transition group-hover:opacity-100", tileOf(j.id))}>
                    <span className="text-4xl font-semibold text-white/90">{(j.title.trim()[0] ?? "B").toUpperCase()}</span>
                  </div>
                  <div className="space-y-2 p-4">
                    <p className="truncate text-sm font-semibold text-slate-900" title={j.title}>{j.title}</p>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <Pill tone={STATUS_TONE[j.status] ?? "slate"}>{STATUS_LABEL[j.status] ?? j.status}</Pill>
                      <span>{credits(j.spentUnits)} credits</span>
                      <span className="ml-auto">{new Date(j.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</span>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

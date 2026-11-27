"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, ArrowRight, Bell, Coins, Hammer, Hourglass, Layers, Plus, Sparkles, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { AiUpdate } from "@/server/ai-updates";
import { useMe } from "./ai-shell";
import { STATUS_LABEL, STATUS_TONE } from "./build-status";
import type { JobSummary } from "./builder";
import { api, Card, credits, Pill } from "./light";

type Billing = { plan: { name: string } | null; wallet: { availableUnits: number; reservedUnits: number } };
type Usage = { summary: { month: { requests: number; chargedUnits: number }; today: { chargedUnits: number } } };

const when = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

/**
 * The AI workspace's dashboard: its own details only (credits and plan, builds, what needs the person, this month's usage, updates). The Fixed Price application has its own
 * dashboard at /client/dashboard; nothing of that is shown here, and nothing of this is shown there.
 */
export function AiDashboardPage() {
  const me = useMe();
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [updates, setUpdates] = useState<AiUpdate[] | null>(null);

  useEffect(() => {
    api<{ jobs: JobSummary[] }>("/api/workspace/jobs").then((r) => setJobs(r.jobs)).catch(() => setJobs([]));
    api<{ billing: Billing }>("/api/workspace/billing").then((r) => setBilling(r.billing)).catch(() => undefined);
    api<Usage>("/api/workspace/ai/usage").then(setUsage).catch(() => undefined);
    api<{ updates: AiUpdate[] }>("/api/workspace/updates").then((r) => setUpdates(r.updates)).catch(() => setUpdates([]));
  }, []);

  const first = me.user.name.split(" ")[0];
  const attention = (updates ?? []).filter((u) => u.needsAction);
  const unfinished = (jobs ?? []).filter((j) => !["completed", "failed", "cancelled"].includes(j.status)).length;
  const tiles: { label: string; value: string; hint: string; icon: LucideIcon; tone: string }[] = [
    { label: "Credits available", value: billing ? credits(billing.wallet.availableUnits) : "…", hint: billing ? (billing.plan ? `${billing.plan.name} plan` : "No plan yet") : "", icon: Coins, tone: "bg-indigo-100 text-indigo-700" },
    { label: "Builds", value: jobs ? String(jobs.length) : "…", hint: jobs ? `${unfinished} in progress` : "", icon: Hammer, tone: "bg-sky-100 text-sky-700" },
    { label: "Waiting for you", value: updates ? String(attention.length) : "…", hint: "plans to approve, builds to continue", icon: Hourglass, tone: "bg-amber-100 text-amber-700" },
    { label: "Used this month", value: usage ? credits(usage.summary.month.chargedUnits) : "…", hint: usage ? `${usage.summary.month.requests} requests` : "", icon: Activity, tone: "bg-emerald-100 text-emerald-700" },
  ];

  return (
    <div className="space-y-8">
      <section className="relative isolate overflow-hidden rounded-3xl border border-slate-200 bg-white px-6 py-7 shadow-sm sm:px-8" aria-label="Welcome">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(50%_90%_at_85%_0%,rgba(129,140,248,.25),transparent_70%),radial-gradient(40%_70%_at_5%_100%,rgba(244,114,182,.18),transparent_70%)]" />
        <div className="flex flex-wrap items-center justify-between gap-5">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[.2em] text-indigo-600">AI workspace</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">Welcome back, {first}</h1>
            <p className="mt-2 text-sm text-slate-600">Build with AI, keep an eye on your credits, and pick up where you left off.</p>
          </div>
          <Link href="/ai/builder" className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition hover:bg-indigo-500"><Plus size={16} /> New build</Link>
        </div>
      </section>

      <section aria-label="Summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="ai-counts">
        {tiles.map((t) => (
          <Card key={t.label} className="flex items-center gap-4 p-5">
            <span className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-xl", t.tone)}><t.icon size={22} /></span>
            <div className="min-w-0">
              <p className="text-sm text-slate-500">{t.label}</p>
              <p className="mt-0.5 text-3xl font-semibold tabular-nums text-slate-900">{t.value}</p>
              {t.hint && <p className="truncate text-[11px] text-slate-400">{t.hint}</p>}
            </div>
          </Card>
        ))}
      </section>

      {attention.length > 0 && (
        <section aria-label="Needs your attention" className="space-y-3" data-testid="ai-attention">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-indigo-700"><ArrowRight size={14} /></span> Needs your attention</h2>
          <div className="grid gap-4 lg:grid-cols-3">
            {attention.map((u) => (
              <Link key={u.id} href={u.href} className="group flex items-center gap-4 rounded-2xl border border-amber-300 bg-amber-50 p-4 transition hover:border-amber-400">
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-slate-900">{u.text}</span><span className="mt-1 block text-xs leading-4 text-amber-900/80">{u.detail}</span></span>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-amber-400 text-amber-700 transition group-hover:bg-amber-100"><ArrowRight size={15} /></span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section aria-label="Your builds" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900"><Layers size={18} className="text-indigo-600" /> Your builds</h2>
          {jobs && jobs.length > 0 && <Link href="/ai/builder#builds-heading" className="text-sm text-indigo-600 hover:text-indigo-800">See all</Link>}
        </div>
        {jobs === null ? (
          <Card className="text-sm text-slate-500">Loading...</Card>
        ) : jobs.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center" data-testid="ai-empty-builds">
            <Sparkles className="mx-auto text-slate-400" size={28} />
            <p className="mt-3 text-sm text-slate-700">No builds yet.</p>
            <Link href="/ai/builder" className="mt-4 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">Start your first build</Link>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" data-testid="ai-builds">
            {jobs.slice(0, 5).map((j) => (
              <li key={j.id}>
                <Link href={`/ai/builder/${j.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5 transition hover:bg-slate-50">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">{j.title}</span>
                  <Pill tone={STATUS_TONE[j.status] ?? "slate"}>{STATUS_LABEL[j.status] ?? j.status}</Pill>
                  <span className="text-xs text-slate-500">{credits(j.spentUnits)} credits</span>
                  <span className="text-xs text-slate-400">{when(j.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="space-y-4 p-6" data-testid="ai-plan-card">
          <h2 className="flex items-center gap-2.5 text-lg font-semibold text-slate-900"><Coins size={19} className="text-indigo-600" /> Plan and credits</h2>
          <div>
            <p className="text-sm text-slate-600">{billing ? (billing.plan ? <>Plan: <b className="text-slate-900">{billing.plan.name}</b></> : "No plan yet.") : "Loading..."}</p>
            <p className="mt-1 text-sm text-slate-500">{billing ? `${credits(billing.wallet.availableUnits)} credits available${billing.wallet.reservedUnits > 0 ? `, ${credits(billing.wallet.reservedUnits)} held for running requests` : ""}` : ""}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/ai/billing" className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"><Layers size={15} /> Plans and credits</Link>
            <Link href="/ai/usage" className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50"><Activity size={15} /> Usage</Link>
          </div>
        </Card>
        <Card className="p-6" data-testid="ai-recent-updates">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2.5 text-lg font-semibold text-slate-900"><Bell size={19} className="text-indigo-600" /> Recent updates</h2>
            {updates && updates.length > 0 && <Link href="/ai/updates" className="text-sm text-indigo-600 hover:text-indigo-800">All updates</Link>}
          </div>
          {updates === null ? <p className="mt-4 text-sm text-slate-400">Loading...</p> : updates.length === 0 ? <p className="mt-4 text-sm text-slate-500">Nothing yet. When a build changes or credits are added, it appears here.</p> : (
            <ul className="mt-4 space-y-2.5">
              {updates.slice(0, 5).map((u) => (
                <li key={u.id}>
                  <Link href={u.href} className="block rounded-xl border border-slate-100 bg-slate-50 px-4 py-2.5 transition hover:border-indigo-200">
                    <span className="block truncate text-sm text-slate-900">{u.text}</span>
                    <span className="block truncate text-xs text-slate-500">{u.detail}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

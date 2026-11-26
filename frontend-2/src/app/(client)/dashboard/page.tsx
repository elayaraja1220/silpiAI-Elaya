import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, FileText, Plus, Sparkles } from "lucide-react";

import { ProgressSteps } from "@/components/client/progress";
import { clientUpdates, listClientProjects, projectCounts } from "@/server/client-projects";
import { requireClient } from "@/server/client-page";
import { getBilling } from "@/server/subscriptions";

export const metadata: Metadata = { title: "Dashboard · SILPI AI", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const credits = (units: number) => (units / 1000).toLocaleString("en-IN", { maximumFractionDigits: 3 });
const when = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/** The client's home: what needs them, where their projects are, and their AI workspace. Everything is read from their own workspace. */
export default async function Page() {
  const session = await requireClient("/dashboard");
  const projects = listClientProjects(session.orgId);
  const counts = projectCounts(session.orgId);
  const updates = clientUpdates(session.orgId, 6);
  const billing = getBilling(session.orgId);
  const attention = projects.filter((p) => p.next.action !== null);
  const tiles: [string, number][] = [["Projects", counts.total], ["Waiting for you", counts.waitingForYou], ["In progress", counts.inProgress], ["Delivered", counts.delivered]];
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[.18em] text-violet-300">Dashboard</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Welcome back, {session.user.name.split(" ")[0]}</h1>
        </div>
        <Link href="/clients/new" className="inline-flex items-center gap-2 rounded-xl bg-violet-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-900/40 transition hover:bg-violet-400"><Plus size={16} /> New project</Link>
      </div>

      <section aria-label="Summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="counts">
        {tiles.map(([label, n]) => (
          <div key={label} className="rounded-2xl border border-white/[.08] bg-[#121622] p-5">
            <p className="text-xs text-slate-400">{label}</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums">{n}</p>
          </div>
        ))}
      </section>

      {attention.length > 0 && (
        <section aria-label="Needs your attention" className="space-y-3" data-testid="attention">
          <h2 className="text-sm font-semibold text-slate-200">Needs your attention</h2>
          {attention.map((p) => (
            <Link key={p.id} href={`/my-projects/${p.id}`} className="flex items-center justify-between gap-4 rounded-2xl border border-amber-400/25 bg-amber-500/[.06] px-5 py-4 transition hover:border-amber-400/50">
              <span><span className="block text-sm font-medium text-slate-100">{p.title}</span><span className="block text-xs text-amber-100/80">{p.next.text}</span></span>
              <ArrowRight size={16} className="shrink-0 text-amber-200" />
            </Link>
          ))}
        </section>
      )}

      <section aria-label="Your projects" className="space-y-3">
        <div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-200">Your fixed-price projects</h2>{projects.length > 0 && <Link href="/my-projects" className="text-xs text-violet-300 hover:text-violet-200">See all</Link>}</div>
        {projects.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/15 p-8 text-center" data-testid="empty-projects">
            <FileText className="mx-auto text-slate-500" size={28} />
            <p className="mt-3 text-sm text-slate-300">You have no projects yet.</p>
            <Link href="/clients/new" className="mt-4 inline-flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-400">Start your first project</Link>
          </div>
        ) : (
          projects.slice(0, 3).map((p) => (
            <Link key={p.id} href={`/my-projects/${p.id}`} className="block rounded-2xl border border-white/[.08] bg-[#121622] p-5 transition hover:border-violet-400/40">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{p.title}</span><span className="rounded-full border border-white/10 px-2.5 py-0.5 text-[11px] text-slate-300">{p.stageLabel}</span></div>
              <div className="mt-4"><ProgressSteps step={p.step} /></div>
            </Link>
          ))
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-label="AI workspace" className="rounded-2xl border border-white/[.08] bg-[#121622] p-5" data-testid="ai-card">
          <div className="flex items-center gap-2 text-emerald-300"><Sparkles size={16} /><h2 className="text-sm font-semibold text-slate-200">AI workspace</h2></div>
          <p className="mt-3 text-sm text-slate-300">{billing.plan ? <>Plan: <b className="text-white">{billing.plan.name}</b></> : "No plan yet."}</p>
          <p className="mt-1 text-xs text-slate-400">{credits(billing.wallet.availableUnits)} credits available</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href={billing.running ? "/ai/builder" : "/clients/new/saas"} className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-400">{billing.running ? "Open the workspace" : "Start with SILPI AI"}</Link>
            <Link href="/ai/billing" className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/[.05]">Plans and credits</Link>
          </div>
        </section>
        <section aria-label="Recent updates" className="rounded-2xl border border-white/[.08] bg-[#121622] p-5" data-testid="updates">
          <div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-200">Recent updates</h2>{updates.length > 0 && <Link href="/notifications" className="text-xs text-violet-300 hover:text-violet-200">All updates</Link>}</div>
          {updates.length === 0 ? <p className="mt-3 text-sm text-slate-500">Nothing yet. Updates about your projects appear here.</p> : (
            <ul className="mt-3 space-y-2.5">{updates.map((u, i) => <li key={`${u.projectId}-${i}`} className="text-sm"><Link href={`/my-projects/${u.projectId}`} className="text-slate-200 hover:text-white">{u.project}</Link><span className="text-slate-400"> · {u.label}</span><span className="block text-xs text-slate-500">{when(u.at)}</span></li>)}</ul>
          )}
        </section>
      </div>
    </div>
  );
}

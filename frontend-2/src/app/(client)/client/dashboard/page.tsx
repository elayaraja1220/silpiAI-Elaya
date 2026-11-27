import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, CheckCircle2, Code2, FileText, FolderOpen, Hourglass, Layers, MoreHorizontal, Plus, type LucideIcon } from "lucide-react";

import { LaptopArt, ProjectTile, Wave } from "@/components/client/dashboard-art";
import { ProgressSteps } from "@/components/client/progress";
import { clientUpdates, listClientProjects, projectCounts, type ClientProjectSummary } from "@/server/client-projects";
import { requireClient } from "@/server/client-page";

export const metadata: Metadata = { title: "Dashboard · SILPI AI", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const when = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/** The summary tiles: what is counted, its icon and its colours. */
const TILES: { label: string; key: "total" | "waitingForYou" | "inProgress" | "delivered"; icon: LucideIcon; box: string; iconBox: string; wave: string }[] = [
  { label: "Projects", key: "total", icon: FolderOpen, box: "from-violet-500/20 via-violet-500/[.06] to-transparent border-violet-400/25", iconBox: "bg-violet-500/30 text-violet-100", wave: "text-violet-400" },
  { label: "Waiting for you", key: "waitingForYou", icon: Hourglass, box: "from-amber-500/20 via-amber-500/[.05] to-transparent border-amber-400/25", iconBox: "bg-amber-500/25 text-amber-200", wave: "text-amber-400" },
  { label: "In progress", key: "inProgress", icon: Code2, box: "from-sky-500/20 via-sky-500/[.05] to-transparent border-sky-400/25", iconBox: "bg-sky-500/25 text-sky-200", wave: "text-sky-400" },
  { label: "Delivered", key: "delivered", icon: CheckCircle2, box: "from-emerald-500/20 via-emerald-500/[.05] to-transparent border-emerald-400/25", iconBox: "bg-emerald-500/25 text-emerald-200", wave: "text-emerald-400" },
];

/** A project's status as a small pill: violet while its quotation is waiting, green once it is approved and beyond, grey otherwise. */
const pillFor = (p: ClientProjectSummary) =>
  p.stage === "quoted" ? "border-violet-400/40 bg-violet-500/15 text-violet-200"
  : p.stage === "requirement" || p.stage === "lost" ? "border-white/10 bg-white/[.05] text-slate-300"
  : "border-emerald-400/30 bg-emerald-500/15 text-emerald-300";
const dotFor = (p: ClientProjectSummary) => (p.stage === "quoted" ? "bg-violet-400" : p.stage === "requirement" || p.stage === "lost" ? "bg-slate-500" : "bg-emerald-400");

const card = "rounded-2xl border border-white/[.08] bg-gradient-to-br from-[#171b2e] to-[#10131f]";

/** The Fixed Price dashboard: what needs the client, and where their fixed-price projects are. Only that: the AI workspace has its own dashboard (/ai/dashboard). */
export default async function Page() {
  const session = await requireClient("/client/dashboard");
  const projects = listClientProjects(session.orgId);
  const counts = projectCounts(session.orgId);
  const updates = clientUpdates(session.orgId, 6);
  const attention = projects.filter((p) => p.next.action !== null);
  return (
    <div className="space-y-8">
      <section className="relative overflow-hidden rounded-3xl border border-violet-400/20 bg-gradient-to-br from-[#1b1540] via-[#120f2b] to-[#0e1118] px-6 py-7 sm:px-8" aria-label="Welcome">
        <div aria-hidden className="pointer-events-none absolute -right-10 -top-24 h-72 w-72 rounded-full bg-violet-600/25 blur-3xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-6">
          <div className="max-w-md">
            <p className="text-[11px] font-semibold uppercase tracking-[.2em] text-violet-300">Dashboard</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">Welcome back, {session.user.name.split(" ")[0]} <span aria-hidden>👋</span></h1>
            <p className="mt-2 text-sm text-slate-300">Manage your projects, track progress, and build with SILPI AI</p>
          </div>
          <LaptopArt className="hidden h-36 w-auto md:block lg:h-40" />
          <Link href="/clients/new" className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-purple-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-900/50 transition hover:brightness-110"><Plus size={16} /> New project</Link>
        </div>
      </section>

      <section aria-label="Summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="counts">
        {TILES.map((t) => (
          <div key={t.label} className={`relative flex items-center gap-4 overflow-hidden rounded-2xl border bg-gradient-to-br p-5 ${t.box}`}>
            <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${t.iconBox}`}><t.icon size={22} /></span>
            <div className="relative z-10">
              <p className="text-sm text-slate-300">{t.label}</p>
              <p className="mt-0.5 text-3xl font-semibold tabular-nums text-white">{counts[t.key]}</p>
            </div>
            <Wave className={`absolute bottom-3 right-3 h-9 w-20 opacity-70 ${t.wave}`} />
          </div>
        ))}
      </section>

      {attention.length > 0 && (
        <section aria-label="Needs your attention" className="space-y-3" data-testid="attention">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-500/20 text-violet-300"><ArrowRight size={14} /></span> Needs your attention</h2>
          <div className="grid gap-4 lg:grid-cols-3">
            {attention.map((p) => (
              <Link key={p.id} href={`/my-projects/${p.id}`} className="group flex items-center gap-4 rounded-2xl border border-amber-400/35 bg-gradient-to-br from-amber-500/[.08] to-[#12131c] p-4 transition hover:border-amber-300/60">
                <ProjectTile id={p.id} title={p.title} className="h-16 w-16" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold leading-5 text-white">{p.title}</span>
                  <span className="mt-1 block text-xs leading-4 text-amber-100/80">{p.next.text}</span>
                </span>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-amber-300/50 text-amber-200 transition group-hover:bg-amber-400/15"><ArrowRight size={15} /></span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section aria-label="Your projects" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white"><Layers size={18} className="text-violet-300" /> Your fixed-price projects</h2>
          {projects.length > 0 && <Link href="/my-projects" className="text-sm text-violet-300 hover:text-violet-200">See all</Link>}
        </div>
        {projects.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/15 p-8 text-center" data-testid="empty-projects">
            <FileText className="mx-auto text-slate-500" size={28} />
            <p className="mt-3 text-sm text-slate-300">You have no projects yet.</p>
            <Link href="/clients/new" className="mt-4 inline-flex items-center gap-2 rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-400">Start your first project</Link>
          </div>
        ) : (
          <ul className="space-y-3">
            {projects.slice(0, 3).map((p) => (
              <li key={p.id} className={`${card} flex flex-wrap items-center gap-x-5 gap-y-4 p-4 transition hover:border-violet-400/40`}>
                <Link href={`/my-projects/${p.id}`} className="flex w-full items-center gap-4 sm:w-72 sm:shrink-0">
                  <ProjectTile id={p.id} title={p.title} className="h-[72px] w-[72px]" />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold leading-5 text-white">{p.title}</span>
                    <span className={`mt-2 inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium ${pillFor(p)}`}><span className={`h-1.5 w-1.5 rounded-full ${dotFor(p)}`} />{p.stageLabel}</span>
                  </span>
                </Link>
                <div className="min-w-0 flex-1 basis-80"><ProgressSteps step={p.step} /></div>
                <div className="flex w-full items-center justify-end gap-3 sm:w-auto">
                  <span className={`rounded-lg border px-3.5 py-2 text-xs font-medium ${p.stage === "quoted" ? "border-violet-400/50 bg-violet-500/15 text-violet-100" : "border-white/15 text-slate-200"}`}>{p.stageLabel}</span>
                  <Link href={`/my-projects/${p.id}`} aria-label={`Open ${p.title}`} className="rounded-lg p-2 text-slate-400 hover:bg-white/[.06] hover:text-white"><MoreHorizontal size={18} /></Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-label="Start a project" className={`${card} relative overflow-hidden p-6`} data-testid="new-project-card">
          <div className="flex items-center gap-2.5"><Plus size={20} className="text-violet-300" /><h2 className="text-lg font-semibold text-white">Start a new project</h2></div>
          <p className="mt-4 max-w-sm text-sm leading-6 text-slate-300">Tell us what you want built. Upload a document or describe it, choose the pages and features, and get a quotation with a fixed price. Nothing is charged until you approve it.</p>
          <div className="relative z-10 mt-5 flex flex-wrap gap-3">
            <Link href="/clients/new/fixed-price" className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-purple-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-900/40 hover:brightness-110"><Plus size={15} /> New fixed-price project</Link>
            {projects.length > 0 && <Link href="/my-projects" className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2.5 text-sm text-slate-200 hover:bg-white/[.06]"><Layers size={15} /> All my projects</Link>}
          </div>
        </section>
        <section aria-label="Recent updates" className={`${card} p-6`} data-testid="updates">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2.5 text-lg font-semibold text-white"><FileText size={19} className="text-violet-300" /> Recent updates</h2>
            {updates.length > 0 && <Link href="/notifications" className="text-sm text-violet-300 hover:text-violet-200">All updates</Link>}
          </div>
          {updates.length === 0 ? <p className="mt-4 text-sm text-slate-500">Nothing yet. Updates about your projects appear here.</p> : (
            <ul className="mt-4 space-y-3">
              {updates.map((u, i) => (
                <li key={`${u.projectId}-${i}`}>
                  <Link href={`/my-projects/${u.projectId}`} className="flex items-center gap-3 rounded-xl border border-white/[.07] bg-white/[.03] px-4 py-3 transition hover:border-violet-400/30">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-300"><CheckCircle2 size={16} /></span>
                    <span className="min-w-0 text-sm"><span className="text-slate-100">{u.project}</span><span className="text-slate-400"> · {u.label}</span><span className="block text-xs text-slate-500">{when(u.at)}</span></span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

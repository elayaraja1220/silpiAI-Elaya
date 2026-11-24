"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BadgeCheck,
  Boxes,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  ExternalLink,
  Code2,
  FilePlus2,
  FolderOpen,
  Loader2,
  Plus,
  Search,
  Send,
  Settings2,
  Trash2,
  Users,
  Wallet,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { DeleteLeadDialog } from "@/components/business/delete-lead-dialog";
import { demoApi } from "@/components/business/demo-panel";
import { LiveDemosCard } from "@/components/business/live-demos-card";
import type { DemoView } from "@/lib/demo/service";
import { jsonFetch } from "@/components/business/ui";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatINR } from "@/lib/business/pricing";
import { paymentStatus } from "@/lib/business/payment-status";
import type { Lead, Stage } from "@/lib/business/types";
import { STAGE_LABELS } from "@/lib/business/types";
import { cn, formatRelativeTime } from "@/lib/utils";
import { useProjects } from "@/lib/use-projects";

type DashboardProps = {
  onNavigate: (view: "projects" | "existing" | "activity" | "settings") => void;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 5;

const IN_DEVELOPMENT: Stage[] = ["advance_paid", "in_development", "testing", "demo_ready"];
const AFTER_APPROVAL: Stage[] = ["approved", ...IN_DEVELOPMENT, "final_paid", "delivered"];

/** The filter pills above the table. Each one is a rule over a lead. */
const FILTERS: { id: string; label: string; test: (l: Lead) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "enquiry", label: "New enquiry", test: (l) => l.stage === "requirement" },
  { id: "quoted", label: "Quoted", test: (l) => l.stage === "quoted" },
  { id: "approved", label: "Approved", test: (l) => AFTER_APPROVAL.includes(l.stage) },
  { id: "advance", label: "Advance pending", test: (l) => advanceRemaining(l) > 0 && l.stage === "approved" },
  { id: "dev", label: "In development", test: (l) => IN_DEVELOPMENT.includes(l.stage) },
  { id: "done", label: "Delivered", test: (l) => l.stage === "final_paid" || l.stage === "delivered" },
  { id: "lost", label: "Lost", test: (l) => l.stage === "lost" },
];

function advanceRemaining(l: Lead): number {
  return paymentStatus(l.quotation, l.payments).advanceRemaining;
}

type Tone = "green" | "amber" | "sky" | "violet" | "slate" | "rose";
const TONES: Record<Tone, string> = {
  green: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  amber: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  sky: "border-sky-400/25 bg-sky-400/10 text-sky-300",
  violet: "border-violet-400/25 bg-violet-400/10 text-violet-300",
  slate: "border-white/10 bg-white/[.05] text-slate-400",
  rose: "border-rose-400/25 bg-rose-400/10 text-rose-300",
};

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[10px] font-medium", TONES[tone])}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

/** Approval / payment / development columns and the next action, all derived from the lead. */
function describe(l: Lead): {
  approval: [string, Tone];
  payment: [string, Tone] | null;
  development: [string, Tone];
  action: string;
} {
  const pay = paymentStatus(l.quotation, l.payments);
  const approved = AFTER_APPROVAL.includes(l.stage);

  const approval: [string, Tone] = l.stage === "lost" ? ["Lost", "rose"] : approved ? ["Approved", "green"] : l.stage === "quoted" ? ["Awaiting client", "sky"] : ["Draft", "slate"];

  let payment: [string, Tone] | null = null;
  if (approved && l.quotation) {
    if (l.stage === "final_paid" || l.stage === "delivered") payment = ["Fully paid", "green"];
    else if (pay.advanceRemaining === 0 && pay.advanceDue > 0) payment = pay.balancePaid > 0 ? [`Balance part-paid`, "amber"] : ["Advance paid", "green"];
    else if (pay.advancePaid > 0) payment = [`Partial (${formatINR(pay.advancePaid)})`, "amber"];
    else payment = ["Advance pending", "amber"];
  }

  const development: [string, Tone] =
    l.stage === "in_development" || l.stage === "testing" ? ["In development", "violet"]
    : l.stage === "demo_ready" ? ["Demo ready", "green"]
    : l.stage === "final_paid" || l.stage === "delivered" ? ["Delivered", "green"]
    : l.stage === "advance_paid" ? ["Ready to start", "sky"]
    : ["Not started", "slate"];

  const action =
    l.stage === "requirement" ? "Review"
    : l.stage === "quoted" ? "Follow up"
    : l.stage === "approved" ? (pay.advanceRemaining > 0 ? "Record advance" : "Generate project")
    : l.stage === "advance_paid" ? "Generate project"
    : l.stage === "in_development" || l.stage === "testing" ? "Continue"
    : l.stage === "demo_ready" ? "Review demo"
    : "View";
  return { approval, payment, development, action };
}

const typeLabel = (l: Lead) => `${l.requirement.projectType.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())} · ${l.requirement.scope.replace(/^./, (c) => c.toUpperCase())}`;

export function Dashboard({ onNavigate }: DashboardProps) {
  const router = useRouter();
  const { projects, loading } = useProjects();

  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [client, setClient] = useState("");
  const [stage, setStage] = useState("");
  const [page, setPage] = useState(1);
  const [toDelete, setToDelete] = useState<Lead | null>(null);

  const load = () => {
    jsonFetch<{ leads: Lead[] }>("/api/business/leads")
      .then((r) => { setLeads(r.leads); setError(""); })
      .catch((e: Error) => { setLeads([]); setError(e.message); });
  };
  useEffect(load, []);

  // The demos that are open now, so "Review demo" can open the right one straight away.
  const [demos, setDemos] = useState<DemoView[] | null>(null);
  const [demosLocal, setDemosLocal] = useState(true);
  useEffect(() => {
    demoApi("/api/demo").then((r) => { setDemos(r.demos); setDemosLocal(r.local); }).catch(() => setDemos([]));
  }, []);
  const demoOf = (leadId: string) => demos?.find((d) => d.leadId === leadId && d.status === "live");

  const all = useMemo(() => leads ?? [], [leads]);
  const now = Date.now();

  // ---- numbers ---------------------------------------------------------------------------------
  const stats = useMemo(() => {
    const thisWeek = (l: Lead) => now - new Date(l.createdAt).getTime() < WEEK_MS;
    const quotationsOut = all.filter((l) => l.stage !== "requirement" && l.stage !== "lost" && l.quotation);
    return {
      total: all.length,
      totalWeek: all.filter(thisWeek).length,
      sent: quotationsOut.length,
      waiting: all.filter((l) => l.stage === "quoted").length,
      approved: all.filter((l) => AFTER_APPROVAL.includes(l.stage)).length,
      advancePending: all.filter((l) => l.stage === "approved" && advanceRemaining(l) > 0).length,
      inDev: all.filter((l) => IN_DEVELOPMENT.includes(l.stage)).length,
    };
  }, [all, now]);

  const followUps = useMemo(() => {
    const items: { text: string; when: string; tone: Tone; id: string }[] = [];
    for (const l of all) {
      const name = l.client.company || l.client.name;
      const age = now - new Date(l.updatedAt).getTime();
      if (l.stage === "approved" && advanceRemaining(l) > 0) items.push({ id: l.id, text: `${name} – collect advance payment`, when: formatRelativeTime(l.updatedAt), tone: "amber" });
      else if (l.stage === "quoted" && age > 2 * DAY_MS) items.push({ id: l.id, text: `${name} – follow up on quotation`, when: formatRelativeTime(l.updatedAt), tone: "sky" });
      else if (l.stage === "requirement") items.push({ id: l.id, text: `${name} – review requirement`, when: formatRelativeTime(l.updatedAt), tone: "violet" });
      else if (l.stage === "demo_ready") items.push({ id: l.id, text: `${name} – demo ready, collect balance`, when: formatRelativeTime(l.updatedAt), tone: "green" });
    }
    return items;
  }, [all, now]);

  // ---- table -----------------------------------------------------------------------------------
  const clientNames = useMemo(() => [...new Set(all.map((l) => l.client.company || l.client.name))].sort(), [all]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, all.filter(f.test).length])), [all]);
  const rows = useMemo(() => {
    const rule = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];
    const q = query.trim().toLowerCase();
    return all.filter((l) => {
      if (!rule.test(l)) return false;
      if (client && (l.client.company || l.client.name) !== client) return false;
      if (stage && l.stage !== stage) return false;
      if (!q) return true;
      return [l.client.name, l.client.company, l.requirement.title, l.quotation?.number ?? ""].some((v) => v.toLowerCase().includes(q));
    });
  }, [all, filter, query, client, stage]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const visible = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  const cards: { label: string; value: number; note: string; icon: LucideIcon; tone: string }[] = [
    { label: "Total enquiries", value: stats.total, note: stats.totalWeek ? `+${stats.totalWeek} this week` : "none this week", icon: Users, tone: "from-violet-500/20 text-violet-300" },
    { label: "Quotations sent", value: stats.sent, note: "Quoted or beyond", icon: Send, tone: "from-sky-500/20 text-sky-300" },
    { label: "Waiting for approval", value: stats.waiting, note: "Client has not replied", icon: CalendarClock, tone: "from-amber-500/20 text-amber-300" },
    { label: "Approved", value: stats.approved, note: "Approved or further", icon: BadgeCheck, tone: "from-emerald-500/20 text-emerald-300" },
    { label: "Advance pending", value: stats.advancePending, note: "Approved, not yet paid", icon: Wallet, tone: "from-sky-500/20 text-sky-300" },
    { label: "In development", value: stats.inDev, note: "Building or in review", icon: Code2, tone: "from-violet-500/20 text-violet-300" },
  ];

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      {/* ================= MAIN COLUMN ================= */}
      <div className="min-w-0 space-y-6">
        {/* Hero */}
        <section className="relative overflow-hidden rounded-2xl border border-violet-400/20 bg-gradient-to-br from-[#2a1f55] via-[#1b1840] to-[#141a2e] p-6 sm:p-7">
          <div className="absolute -right-10 -top-24 h-64 w-64 rounded-full bg-violet-500/25 blur-[80px]" />
          <div className="relative flex flex-wrap items-center justify-between gap-6">
            <div className="flex items-center gap-5">
              <span className="hidden h-20 w-20 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[.07] text-violet-200 shadow-xl sm:flex">
                <ClipboardList size={38} />
              </span>
              <div>
                <h2 className="text-2xl font-semibold tracking-tight sm:text-[28px]">
                  Client Requirements & <span className="text-violet-300">Quotations</span>
                </h2>
                <p className="mt-2 max-w-md text-sm leading-6 text-slate-300">Manage enquiries, prepare quotations, track approvals, payments and start development.</p>
              </div>
            </div>
            <div className="flex gap-2.5">
              {[
                { icon: Users, label: "From enquiry\nto delivery" },
                { icon: BadgeCheck, label: "Quotation &\napproval" },
                { icon: Code2, label: "AI development\n& delivery" },
              ].map(({ icon: I, label }) => (
                <div key={label} className="flex w-[104px] flex-col items-center gap-1.5 rounded-xl border border-white/10 bg-white/[.05] px-2 py-3 text-center text-[11px] leading-4 text-slate-300">
                  <I size={18} className="text-violet-300" />
                  <span className="whitespace-pre-line">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Stat cards */}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
          {cards.map(({ label, value, note, icon: I, tone }) => (
            <div key={label} className={cn("rounded-2xl border border-white/[.08] bg-gradient-to-br to-[#121622] p-4", tone.split(" ")[0])}>
              <span className={cn("flex h-9 w-9 items-center justify-center rounded-xl bg-white/[.07]", tone.split(" ")[1])}><I size={17} /></span>
              <p className="mt-3 text-[11px] text-slate-400">{label}</p>
              <p className="mt-0.5 text-3xl font-semibold tracking-tight">{leads ? value : "…"}</p>
              <p className="mt-1 text-[10px] text-slate-500">{note}</p>
            </div>
          ))}
        </section>

        {/* Requirements & quotations */}
        <section className="rounded-2xl border border-white/[.08] bg-[#121622] p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300"><ClipboardList size={18} /></span>
              <div>
                <h3 className="text-base font-semibold">Requirements & Quotations</h3>
                <p className="mt-0.5 text-xs text-slate-400">All client enquiries and quotations with status, payment and next action.</p>
              </div>
            </div>
          </div>

          {/* Filter pills */}
          <div className="mt-4 flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => { setFilter(f.id); setPage(1); }}
                className={cn("flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition", filter === f.id ? "border-violet-400/60 bg-violet-500/25 text-white" : "border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-200")}
              >
                {f.label}
                <span className={cn("rounded-full px-1.5 text-[10px]", filter === f.id ? "bg-violet-400/40" : "bg-white/10")}>{leads ? counts[f.id] : "…"}</span>
              </button>
            ))}
          </div>

          {/* Search + selects */}
          <div className="mt-3 flex flex-wrap gap-2">
            <label className="flex min-w-[220px] flex-1 items-center gap-2 rounded-xl border border-white/[.08] bg-white/[.03] px-3 py-2 focus-within:border-violet-400/50">
              <Search size={14} className="text-slate-500" />
              <input value={query} onChange={(e) => reset(setQuery)(e.target.value)} placeholder="Search by client, project or quotation…" className="w-full bg-transparent text-xs text-slate-100 outline-none placeholder:text-slate-600" />
            </label>
            <select value={client} onChange={(e) => reset(setClient)(e.target.value)} aria-label="Client" className="rounded-xl border border-white/[.08] bg-white/[.03] px-3 py-2 text-xs text-slate-200 outline-none [&>option]:bg-[#121622]">
              <option value="">All clients</option>
              {clientNames.map((n) => <option key={n}>{n}</option>)}
            </select>
            <select value={stage} onChange={(e) => reset(setStage)(e.target.value)} aria-label="Stage" className="rounded-xl border border-white/[.08] bg-white/[.03] px-3 py-2 text-xs text-slate-200 outline-none [&>option]:bg-[#121622]">
              <option value="">All stages</option>
              {(Object.keys(STAGE_LABELS) as Stage[]).map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
            </select>
          </div>

          {error && <p className="mt-3 rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</p>}

          {/* Table */}
          <div className="mt-4 overflow-x-auto rounded-xl border border-white/[.06]">
            <table className="w-full min-w-[980px] text-xs">
              <thead>
                <tr className="bg-white/[.03] text-left text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-3 font-medium">#</th>
                  <th className="px-3 py-3 font-medium">Client / Project</th>
                  <th className="px-3 py-3 font-medium">Quotation</th>
                  <th className="px-3 py-3 text-right font-medium">Value</th>
                  <th className="px-3 py-3 font-medium">Approval</th>
                  <th className="px-3 py-3 font-medium">Payment</th>
                  <th className="px-3 py-3 font-medium">Development</th>
                  <th className="px-3 py-3 font-medium">Updated</th>
                  <th className="px-3 py-3 font-medium">Next action</th>
                  <th className="w-8 px-2 py-3" />
                </tr>
              </thead>
              <tbody>
                {!leads && (
                  <tr><td colSpan={10} className="px-4 py-10 text-center text-slate-400"><Loader2 size={15} className="mr-2 inline animate-spin" /> Loading…</td></tr>
                )}
                {leads && visible.length === 0 && (
                  <tr><td colSpan={10} className="px-4 py-10 text-center text-slate-500">{all.length === 0 ? "No quotations yet. Click Get your quotation to create the first one." : "Nothing matches these filters."}</td></tr>
                )}
                {visible.map((l, i) => {
                  const d = describe(l);
                  return (
                    <tr key={l.id} onClick={() => router.push(`/clients/${l.id}`)} className="cursor-pointer border-t border-white/[.05] transition hover:bg-white/[.03]">
                      <td className="px-3 py-3 text-slate-500">{(current - 1) * PAGE_SIZE + i + 1}</td>
                      <td className="px-3 py-3">
                        <p className="font-semibold text-slate-100">{l.client.company || l.client.name}</p>
                        <p className="mt-0.5 max-w-[240px] truncate text-[11px] text-slate-500">{l.requirement.title}</p>
                        <p className="text-[10px] text-slate-600">{typeLabel(l)}</p>
                      </td>
                      <td className="px-3 py-3 text-slate-300">{l.quotation?.number ?? "—"}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-100">{l.quotation ? formatINR(l.quotation.grandTotal) : "—"}</td>
                      <td className="px-3 py-3"><Pill tone={d.approval[1]}>{d.approval[0]}</Pill></td>
                      <td className="px-3 py-3">{d.payment ? <Pill tone={d.payment[1]}>{d.payment[0]}</Pill> : <span className="text-slate-600">—</span>}</td>
                      <td className="px-3 py-3"><Pill tone={d.development[1]}>{d.development[0]}</Pill></td>
                      <td className="px-3 py-3 text-slate-500">{formatRelativeTime(l.updatedAt)}</td>
                      <td className="px-3 py-3">
                        {d.action === "Review demo" && demoOf(l.id) ? (
                          // One click: the demo opens in a new tab.
                          <a
                            href={demoOf(l.id)!.previewUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="Open the demo in a new tab"
                            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-violet-500 px-3 py-1.5 text-[11px] font-medium text-white transition hover:bg-violet-400"
                          >
                            Review demo <ExternalLink size={12} />
                          </a>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); router.push(d.action === "Review demo" ? `/clients/${l.id}#demo` : `/clients/${l.id}`); }}
                            className={cn("whitespace-nowrap rounded-lg px-3 py-1.5 text-[11px] font-medium transition", d.action === "Record advance" || d.action === "Generate project" ? "bg-violet-500 text-white hover:bg-violet-400" : "border border-white/10 bg-white/[.04] text-slate-200 hover:bg-white/[.08]")}
                          >
                            {d.action === "Review demo" ? "Create demo" : d.action}
                          </button>
                        )}
                      </td>
                      <td className="px-2 py-3">
                        <button aria-label={`Delete ${l.requirement.title}`} onClick={(e) => { e.stopPropagation(); setToDelete(l); }} className="rounded-md p-1.5 text-slate-600 transition hover:bg-rose-500/10 hover:text-rose-300"><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {leads && rows.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
              <span>Showing {(current - 1) * PAGE_SIZE + 1}–{Math.min(current * PAGE_SIZE, rows.length)} of {rows.length} quotation{rows.length === 1 ? "" : "s"}</span>
              {pages > 1 && (
                <div className="flex items-center gap-1">
                  <button aria-label="Previous page" disabled={current === 1} onClick={() => setPage(current - 1)} className="rounded-md p-1.5 hover:bg-white/5 disabled:opacity-30"><ChevronLeft size={14} /></button>
                  {Array.from({ length: pages }, (_, n) => n + 1).map((n) => (
                    <button key={n} onClick={() => setPage(n)} className={cn("h-7 min-w-7 rounded-md px-2 text-xs", n === current ? "bg-violet-500 font-semibold text-white" : "text-slate-400 hover:bg-white/5")}>{n}</button>
                  ))}
                  <button aria-label="Next page" disabled={current === pages} onClick={() => setPage(current + 1)} className="rounded-md p-1.5 hover:bg-white/5 disabled:opacity-30"><ChevronRight size={14} /></button>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Recent projects */}
        <section className="rounded-2xl border border-white/[.08] bg-[#121622] p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300"><Boxes size={18} /></span>
              <div>
                <h3 className="text-base font-semibold">Recent Projects</h3>
                <p className="mt-0.5 text-xs text-slate-400">Your latest development projects.</p>
              </div>
            </div>
            <button onClick={() => onNavigate("projects")} className="text-xs font-medium text-violet-300 hover:text-violet-200">
              View all projects <ArrowRight size={13} className="ml-1 inline" />
            </button>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {!loading && projects.length === 0 && <p className="col-span-full py-6 text-center text-xs text-slate-500">No generated projects yet.</p>}
            {projects.slice(0, 3).map((p) => (
              <button key={p.id} onClick={() => onNavigate("projects")} className="flex items-center gap-3 rounded-xl border border-white/[.07] bg-white/[.025] p-3.5 text-left transition hover:border-white/20 hover:bg-white/[.045]">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[.06] text-violet-300"><Boxes size={17} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-slate-100">{p.name}</span>
                  <span className="mt-1 block text-[10px] text-slate-500">Updated {formatRelativeTime(p.updatedAt)}</span>
                </span>
                <StatusBadge status={p.status} />
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* ================= SIDE COLUMN ================= */}
      <aside className="min-w-0 space-y-5">
        {/* New requirement: the main call to action */}
        <section className="relative overflow-hidden rounded-2xl border border-violet-400/30 bg-gradient-to-br from-violet-600/30 via-indigo-600/15 to-[#121622] p-5">
          <div className="absolute -right-8 -top-10 h-32 w-32 rounded-full bg-violet-500/30 blur-[50px]" />
          <div className="relative">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/10 text-violet-100"><FilePlus2 size={20} /></span>
            <h3 className="mt-3 text-base font-semibold">Get your quotation</h3>
            <p className="mt-1 text-xs leading-5 text-slate-300">Tell us what the client needs and get a priced quotation with GST in minutes.</p>
            <button onClick={() => router.push("/clients/new")} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-semibold text-violet-700 shadow-lg shadow-black/20 transition hover:bg-violet-50">
              <Plus size={17} /> Get your quotation
            </button>
            <ol className="mt-4 space-y-2 text-[11px] text-slate-300">
              {["Enter the client and requirement", "Choose pages, features and package", "Send the quotation for approval"].map((t, i) => (
                <li key={t} className="flex items-center gap-2.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[10px] font-semibold text-violet-200">{i + 1}</span>
                  {t}
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Every demo that is open right now, across all projects */}
        <LiveDemosCard demos={demos} local={demosLocal} />

        {/* Follow-ups */}
        <section className="rounded-2xl border border-white/[.08] bg-[#121622] p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300"><CalendarClock size={18} /></span>
              <h3 className="text-sm font-semibold">Follow-up & Reminders</h3>
            </div>
            {followUps.length > 0 && <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-amber-400 px-1.5 text-[11px] font-bold text-slate-900">{followUps.length}</span>}
          </div>
          <ul className="mt-4 space-y-3">
            {!leads && <li className="text-xs text-slate-500">Loading…</li>}
            {leads && followUps.length === 0 && <li className="text-xs text-slate-500">Nothing pending. You are all caught up.</li>}
            {followUps.slice(0, 5).map((f) => (
              <li key={f.id + f.text}>
                <button onClick={() => router.push(`/clients/${f.id}`)} className="flex w-full items-center gap-2.5 text-left text-xs transition hover:text-white">
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", f.tone === "amber" ? "bg-amber-400" : f.tone === "sky" ? "bg-sky-400" : f.tone === "green" ? "bg-emerald-400" : "bg-violet-400")} />
                  <span className="min-w-0 flex-1 truncate text-slate-300">{f.text}</span>
                  <span className="shrink-0 text-[10px] text-slate-500">{f.when}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* Quick actions */}
        <section className="rounded-2xl border border-white/[.08] bg-[#121622] p-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300"><Zap size={18} /></span>
            <h3 className="text-sm font-semibold">Quick Actions</h3>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2.5">
            {[
                            { label: "My projects", icon: FolderOpen, go: () => onNavigate("projects") },
              { label: "Record payment", icon: Wallet, go: () => { const next = all.find((l) => l.stage === "approved" && advanceRemaining(l) > 0); router.push(next ? `/clients/${next.id}` : "/clients"); } },
              { label: "Pricing settings", icon: Settings2, go: () => router.push("/pricing") },
              { label: "All clients", icon: Users, go: () => router.push("/clients") },
            ].map(({ label, icon: I, go }) => (
              <button key={label} onClick={go} className="flex flex-col items-start gap-3 rounded-xl border border-white/[.08] bg-white/[.03] p-3.5 text-left text-xs text-slate-200 transition hover:-translate-y-0.5 hover:border-violet-400/40 hover:bg-violet-500/10">
                <I size={17} className="text-violet-300" />
                {label}
              </button>
            ))}
          </div>
        </section>
      </aside>

      {toDelete && <DeleteLeadDialog lead={toDelete} onClose={() => setToDelete(null)} onDeleted={load} onError={setError} />}
    </div>
  );
}

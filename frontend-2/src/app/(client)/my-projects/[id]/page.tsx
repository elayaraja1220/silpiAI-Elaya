import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { ProgressSteps } from "@/components/client/progress";
import { getClientProject } from "@/server/client-projects";
import { requireClient } from "@/server/client-page";

export const metadata: Metadata = { title: "Project · SILPI AI", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const when = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const panel = "rounded-2xl border border-white/[.08] bg-[#121622] p-5";
const primary = "rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-400";

/** One project: where it is, what to do next, the quotation, what has been paid and the demo. A project that is not this client's is "not found", the same as one that does not exist. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireClient(`/my-projects/${id}`);
  const p = getClientProject(session.orgId, id);
  if (!p) notFound();
  return (
    <div className="space-y-6">
      <Link href="/my-projects" className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"><ArrowLeft size={14} /> All projects</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-3xl font-semibold tracking-tight">{p.title}</h1><p className="mt-1 text-xs text-slate-500">{p.quotationNumber ? `Quotation ${p.quotationNumber}` : "Quotation being prepared"}{p.total ? ` · ${p.total}` : ""}</p></div>
        <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-300">{p.stageLabel}</span>
      </div>

      <section className={panel} aria-label="Progress"><ProgressSteps step={p.step} /></section>

      <section className="rounded-2xl border border-violet-400/25 bg-violet-500/[.07] p-5" aria-label="Next step" data-testid="next-step">
        <p className="text-sm font-medium text-slate-100">{p.next.text}</p>
        <div className="mt-3 flex flex-wrap gap-3">
          {p.next.action === "review" && p.quotationLink && <Link href={p.quotationLink} className={primary}>Review and approve</Link>}
          {p.next.action === "pay" && p.quotationLink && <Link href={p.quotationLink} className={primary}>See how to pay</Link>}
          {p.next.action === "demo" && p.demo && <a href={p.demo.url} target="_blank" rel="noreferrer noopener" className={`inline-flex items-center gap-1.5 ${primary}`}>Open your demo <ExternalLink size={14} /></a>}
          {p.quotationLink && p.next.action === null && <Link href={p.quotationLink} className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/[.05]">View your quotation</Link>}
        </div>
        {p.next.action === "demo" && !p.demo && <p className="mt-3 text-xs text-slate-400">We will send you the demo link.</p>}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className={panel} aria-label="Payments" data-testid="payments">
          <h2 className="text-sm font-semibold text-slate-200">Payments</h2>
          {p.payment ? (
            <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-slate-400">Advance due</dt><dd className="text-right tabular-nums">{p.payment.advanceDue}</dd>
              <dt className="text-slate-400">Advance paid</dt><dd className="text-right tabular-nums">{p.payment.advancePaid}</dd>
              <dt className="text-slate-400">Still to pay (advance)</dt><dd className="text-right tabular-nums">{p.payment.advanceRemaining}</dd>
              <dt className="text-slate-400">Balance due</dt><dd className="text-right tabular-nums">{p.payment.balanceDue}</dd>
            </dl>
          ) : <p className="mt-3 text-sm text-slate-500">Nothing is due until you approve your quotation.</p>}
          {p.payments.length > 0 && (
            <ul className="mt-4 divide-y divide-white/[.06] border-t border-white/[.06] text-sm">
              {p.payments.map((x) => <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5"><span>{x.kind} · {x.mode.toUpperCase()}{x.reference ? ` · ${x.reference}` : ""}</span><span className="tabular-nums">{x.amount} <span className="text-xs text-slate-500">on {when(x.receivedOn)}</span></span></li>)}
            </ul>
          )}
        </section>
        <section className={panel} aria-label="History">
          <h2 className="text-sm font-semibold text-slate-200">History</h2>
          <ol className="mt-3 space-y-2.5 border-l border-white/10 pl-4">{p.history.map((h, i) => <li key={i} className="relative text-sm"><span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-violet-400" />{h.label}<span className="block text-xs text-slate-500">{when(h.at)}</span></li>)}</ol>
        </section>
      </div>

      <section className={panel} aria-label="What you asked for">
        <h2 className="text-sm font-semibold text-slate-200">What you asked for</h2>
        <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-400">{p.summary}</p>
        {p.pages.length > 0 && <p className="mt-3 text-xs text-slate-500">Pages: {p.pages.join(", ")}</p>}
      </section>
    </div>
  );
}

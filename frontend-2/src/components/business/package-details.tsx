"use client";

import { Check, Clock, Code2, FileText, LifeBuoy, Minus, Search, Sparkles } from "lucide-react";

import { formatINR, sectionsOf } from "@/lib/business/pricing";
import { compareProposals, type Proposal } from "@/lib/business/proposals";
import type { RateCard, Tier } from "@/lib/business/types";
import { cn } from "@/lib/utils";

import { ComparisonTable } from "./comparison-table";

const ACCENT: Record<Tier, string> = {
  basic: "border-sky-400/50 bg-sky-500/10",
  standard: "border-violet-400/60 bg-violet-500/15",
  premium: "border-amber-400/50 bg-amber-500/10",
};

/**
 * The three packages side by side, then everything about the selected one:
 * pages, features, what is not included, technology, SEO, support and payment.
 */
export function PackageDetails({
  proposals,
  rates,
  selected,
  suggested,
  budget,
  onSelect,
}: {
  proposals: Proposal[];
  rates: RateCard;
  selected: Tier;
  suggested: Tier;
  budget: number;
  onSelect: (tier: Tier) => void;
}) {
  const p = proposals.find((x) => x.tier === selected) ?? proposals[0];
  const req = p.requirement;
  const q = p.quote;

  return (
    <div className="space-y-6">
      {/* Package list */}
      <div className="grid gap-3 md:grid-cols-3">
        {proposals.map((x) => {
          const active = x.tier === selected;
          const fits = budget > 0 ? x.grandTotal <= budget : undefined;
          return (
            <button
              key={x.tier}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(x.tier)}
              className={cn("relative rounded-xl border p-4 text-left transition", active ? ACCENT[x.tier] : "border-white/[.08] bg-white/[.02] hover:border-white/20")}
            >
              {x.tier === suggested && (
                <span className="absolute -top-2.5 right-3 flex items-center gap-1 rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-semibold text-white">
                  <Sparkles size={10} /> Suggested{budget > 0 ? " for budget" : ""}
                </span>
              )}
              <p className="text-sm font-semibold text-white">{x.title}</p>
              <p className="mt-0.5 text-[11px] text-slate-400">{x.tagline}</p>
              <p className="mt-3 text-xl font-semibold tabular-nums text-white">{formatINR(x.grandTotal)}</p>
              <p className="text-[11px] text-slate-500">incl. GST · {x.quote.totalHours} h · about {x.estimatedWeeks} wk</p>
              {fits !== undefined && (
                <p className={cn("mt-2 text-[11px] font-medium", fits ? "text-emerald-300" : "text-rose-300")}>
                  {fits ? "Within the client's budget" : `Over budget by ${formatINR(x.grandTotal - budget)}`}
                </p>
              )}
              <p className="mt-2 text-[11px] text-slate-400">
                {x.pages.length} pages · {x.requirement.modules.length} features{x.terms ? ` · ${x.terms.supportDays} days support` : ""}
              </p>
            </button>
          );
        })}
      </div>

      {/* Details of the selected package */}
      <div className={cn("space-y-5 rounded-xl border p-5", ACCENT[p.tier])}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[.15em] text-slate-400">Package details</p>
            <p className="text-lg font-semibold text-white">{p.title} package</p>
            <p className="text-xs text-slate-400">{p.tagline}</p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold tabular-nums text-white">{formatINR(p.grandTotal)}</p>
            <p className="text-[11px] text-slate-400">
              {formatINR(q.subtotal - q.discount)} + GST {formatINR(q.gst.total)}
              {q.discount > 0 ? ` · discount ${formatINR(q.discount)}` : ""}
            </p>
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <Block icon={<FileText size={14} />} title={`Pages (${p.pages.length})`}>
            <ul className="space-y-1">
              {p.pages.map((page) => (
                <li key={page} className="flex justify-between gap-3">
                  <span className="min-w-0">
                    <span className="text-slate-200">{page}</span>
                    {req.pageDetails?.[page]?.purpose && <span className="block truncate text-[11px] text-slate-500">{req.pageDetails[page].purpose}</span>}
                  </span>
                  <span className="shrink-0 text-[11px] text-slate-500">{sectionsOf(req, page, rates)} sections</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-slate-500">
              Included in the set-up, not billed: shared header, footer and navigation{p.supportingPages?.length ? `; ${p.supportingPages.join(", ")}` : ""}.
            </p>
          </Block>

          <Block icon={<Check size={14} />} title="Features included">
            <ul className="space-y-1">
              {req.modules.length === 0 && <li className="text-slate-500">Information pages only, no extra features.</li>}
              {req.modules.map((m) => (
                <li key={m}>
                  <span className="flex items-center gap-1.5 text-slate-200"><Check size={12} className="text-emerald-300" /> {rates.modules[m].label}</span>
                  <span className="block pl-[18px] text-[11px] text-slate-500">{rates.modules[m].detail}</span>
                </li>
              ))}
              <li>
                <span className="flex items-center gap-1.5 text-slate-200"><Check size={12} className="text-emerald-300" /> {rates.design[req.design].label}</span>
                <span className="block pl-[18px] text-[11px] text-slate-500">{rates.design[req.design].detail}</span>
              </li>
            </ul>
            {p.leftOut.length > 0 && (
              <>
                <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Not in this package</p>
                <ul className="mt-1 space-y-0.5">
                  {p.leftOut.map((l) => (
                    <li key={l} className="flex items-start gap-1.5 text-[11px] text-slate-400"><Minus size={12} className="mt-0.5 shrink-0 text-slate-600" /> {l}</li>
                  ))}
                </ul>
              </>
            )}
          </Block>

          <Block icon={<Code2 size={14} />} title="Technology">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              <dt className="text-slate-500">Frontend</dt><dd>{q.stack.frontend}</dd>
              <dt className="text-slate-500">Backend</dt><dd>{q.stack.backend}</dd>
              <dt className="text-slate-500">Database</dt><dd>{q.stack.database}</dd>
              <dt className="text-slate-500">Styling</dt><dd>{q.stack.styling}</dd>
            </dl>
          </Block>

          <Block icon={<Search size={14} />} title="SEO included">
            <ul className="list-disc space-y-0.5 pl-4">{q.seo.included.map((s) => <li key={s}>{s}</li>)}</ul>
          </Block>

          {p.terms && (
            <Block icon={<LifeBuoy size={14} />} title="Support & extras">
              <p>{p.terms.revisions} revision round{p.terms.revisions === 1 ? "" : "s"} · {p.terms.supportDays} days free support after launch</p>
              <ul className="mt-1 space-y-0.5">
                {p.terms.extras.map((e) => <li key={e} className="flex items-center gap-1.5"><Check size={12} className="text-emerald-300" /> {e}</li>)}
              </ul>
            </Block>
          )}

          <Block icon={<Clock size={14} />} title="Timeline & payment">
            <p>{q.totalHours} development hours · about {p.estimatedWeeks} week{p.estimatedWeeks === 1 ? "" : "s"}</p>
            <ul className="mt-1 space-y-0.5">
              {q.schedule.map((s) => (
                <li key={s.label} className="flex justify-between gap-3"><span className="text-slate-400">{s.percent}% {s.label}</span><span className="tabular-nums">{formatINR(s.amount)}</span></li>
              ))}
            </ul>
          </Block>
        </div>
      </div>

      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[.15em] text-slate-500">Compare all packages</p>
        <ComparisonTable rows={compareProposals(proposals, rates)} selected={selected} tone="dark" />
      </div>
    </div>
  );
}

function Block({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-white/[.06] bg-black/10 p-3 text-xs text-slate-300">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{icon} {title}</p>
      {children}
    </section>
  );
}

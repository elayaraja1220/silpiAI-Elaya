"use client";

import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";

import { Card } from "@/components/business/ui";
import { hourlyProgress } from "@/lib/business/hourly";
import { useMoney } from "./money-context";
import { BILLING_CYCLE_LABELS, type HourlyTerms, type Lead } from "@/lib/business/types";
import { cn } from "@/lib/utils";

const STATUS_TEXT = {
  "on-track": { tone: "text-emerald-300", bar: "bg-emerald-400", text: "Within the estimate." },
  "above-estimate": { tone: "text-sky-300", bar: "bg-sky-400", text: "Above the estimate, still under the cap." },
  near: { tone: "text-amber-200", bar: "bg-amber-400", text: "Close to the cap. Talk to the client before more hours are worked." },
  over: { tone: "text-rose-300", bar: "bg-rose-400", text: "Over the cap. Do not bill the extra hours until the client approves them in writing." },
} as const;

/** Hours worked against the estimate and the cap. The hours come from the same log as the Hours tab. */
export function HourlyProgress({ terms, worked }: { terms: HourlyTerms; worked: number }) {
  const { fmt } = useMoney();
  const p = hourlyProgress(terms, worked);
  const s = STATUS_TEXT[p.status];
  const pct = Math.min(100, Math.round(p.usedOfCap * 100));
  return (
    <div className="space-y-2" data-testid="hourly-progress">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="text-slate-400">Worked <b className="tabular-nums text-slate-100">{p.worked} h</b> of the {terms.capHours} h cap ({terms.expectedHours} h estimated)</span>
        <span className="tabular-nums text-slate-300">{fmt(p.amountWorked)} before GST</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/[.08]"><div className={cn("h-full rounded-full transition-all", s.bar)} style={{ width: `${pct}%` }} /></div>
      <p className={cn("flex items-start gap-1.5 text-[11px]", s.tone)}>
        {p.status === "near" || p.status === "over" ? <AlertTriangle size={12} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={12} className="mt-0.5 shrink-0" />}
        {s.text} {p.remainingToCap > 0 ? `${p.remainingToCap} h left to the cap.` : ""}
      </p>
    </div>
  );
}

/** Team view of an hourly engagement: the terms the client approved, and how many hours are used. */
export function HourlyTermsCard({ lead }: { lead: Lead }) {
  const { fmt } = useMoney();
  const terms = lead.quotation?.hourly;
  if (!terms) return null;
  const worked = lead.workLog.reduce((s, e) => s + e.hours, 0);
  const row = (label: string, value: string, strong = false) => (
    <div className="flex justify-between gap-3 py-1"><dt className="text-slate-400">{label}</dt><dd className={cn("tabular-nums", strong ? "font-semibold text-white" : "text-slate-200")}>{value}</dd></div>
  );
  return (
    <Card className="no-print space-y-4">
      <div>
        <p className="flex items-center gap-2 text-sm font-semibold text-slate-100"><Clock size={15} className="text-violet-300" /> Hourly engagement</p>
        <p className="mt-1 text-xs text-slate-400">Billed on the hours actually worked, never above the cap without the client&apos;s written approval. Log hours in the Payments &amp; hours tab. There are no packages to choose from.</p>
      </div>
      <dl className="grid gap-x-8 text-sm sm:grid-cols-2">
        <div>
          {row("Who works", terms.role)}
          {row("Rate", `${fmt(terms.rate)} / hour`)}
          {row("Bill the client", BILLING_CYCLE_LABELS[terms.cycle])}
        </div>
        <div>
          {row(`Lowest (${terms.minHours} h)`, fmt(terms.minTotal))}
          {row(`Estimate (${terms.expectedHours} h)`, fmt(terms.expectedTotal), true)}
          {row(`Cap (${terms.capHours} h)`, fmt(terms.capTotal))}
        </div>
      </dl>
      {terms.marketNote && <p className="rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-[11px] leading-4 text-slate-300" data-testid="market-note">{terms.marketNote}</p>}
      <p className="text-[11px] text-slate-500">{lead.quotation?.gst.mode === "export" ? "No GST (export of services)." : "Amounts include GST."} The advance is taken on the estimate and adjusted in the final bill.</p>
      <HourlyProgress terms={terms} worked={worked} />
    </Card>
  );
}

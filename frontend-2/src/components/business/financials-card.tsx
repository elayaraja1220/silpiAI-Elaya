"use client";

import { useEffect, useState } from "react";

import { minorDigits } from "@/lib/business/countries";
import type { Financials } from "@/lib/business/financials";
import { formatMoney, INR_MONEY } from "@/lib/business/money";
import { Card, jsonFetch } from "./ui";

const inr = (n: number) => formatMoney(n, INR_MONEY);
const native = (minor: number, currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: minorDigits(currency), maximumFractionDigits: minorDigits(currency) }).format(minor / 10 ** minorDigits(currency));

/** The five figures of this project, kept apart: A human-equivalent value, B price, C AI cost, D infrastructure cost, E margin. Internal only. */
export function FinancialsCard({ leadId, refreshKey }: { leadId: string; refreshKey: string }) {
  const [fin, setFin] = useState<Financials | null>(null);
  useEffect(() => { jsonFetch<{ financials: Financials }>(`/api/business/leads/${leadId}/financials`).then((r) => setFin(r.financials)).catch(() => setFin(null)); }, [leadId, refreshKey]);
  if (!fin) return null;
  const a = fin.a;
  const range = a.rangeMinor && a.currency ? `${native(a.rangeMinor.min, a.currency)} to ${native(a.rangeMinor.max, a.currency)}` : "";
  const cells: { key: string; title: string; value: string; sub: string; tone?: string }[] = [
    { key: "A", title: "Human-equivalent value", value: a.status === "unavailable" ? "not available" : a.currency && a.valueMinor !== null ? native(a.valueMinor, a.currency) : "-", sub: a.status === "unavailable" ? "no verified market rate" : `${range}${a.inr !== null ? ` · ${inr(a.inr)}` : ""}${a.status === "incomplete" ? " · understated" : ""}` },
    { key: "B", title: "Customer price", value: inr(fin.b.totalInr), sub: `${inr(fin.b.taxableInr)} without GST${fin.b.currency !== "INR" ? ` · shown to the client in ${fin.b.currency}` : ""}` },
    { key: "C", title: "AI cost", value: fin.c.provided ? (fin.c.totalInr !== null ? inr(fin.c.totalInr) : `$${(fin.c.actualUsd + fin.c.estimatedUsd).toFixed(2)}`) : "not recorded", sub: fin.c.provided ? `${fin.c.records} record${fin.c.records === 1 ? "" : "s"}` : "no AI cost entered" },
    { key: "D", title: "Infrastructure cost", value: fin.d.configured ? inr(fin.d.totalInr) : "not set up", sub: fin.d.configured ? "from your settings" : "no infrastructure cost configured" },
    { key: "E", title: "Margin", value: inr(fin.e.grossProfitInr), sub: `${fin.e.marginPercent !== null ? `${fin.e.marginPercent}% of ` : ""}${inr(fin.e.revenueInr)}${fin.e.provisional ? " · provisional" : ""}`, tone: fin.e.grossProfitInr < 0 ? "text-rose-300" : fin.e.provisional ? "text-amber-200" : "" },
  ];
  return (
    <Card>
      <p className="text-xs font-semibold text-slate-300">Five figures, kept apart <span className="font-normal text-slate-500">(internal: never shown to the client)</span></p>
      <div className="mt-3 grid gap-3 sm:grid-cols-5" data-testid="financials">
        {cells.map((c) => (
          <div key={c.key} className="rounded-xl border border-white/[.08] bg-white/[.02] p-3">
            <p className="text-[11px] uppercase tracking-wider text-slate-500">{c.key} · {c.title}</p>
            <p className={`mt-1 text-sm font-semibold tabular-nums text-slate-100 ${c.tone ?? ""}`}>{c.value}</p>
            <p className="mt-0.5 text-[11px] text-slate-500">{c.sub}</p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-slate-500">E = B without GST ({inr(fin.e.revenueInr)}) less the internal cost {inr(fin.e.internalCostInr)} (people {inr(fin.e.peopleCostInr)}, AI, infrastructure and other studio costs).</p>
      {fin.warnings.length > 0 && <ul className="mt-2 space-y-1 text-[11px] text-amber-200">{fin.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      <details className="mt-2 text-[11px] text-slate-500">
        <summary className="cursor-pointer">How A is worked out, and the rules that keep the five apart</summary>
        <ul className="mt-1 list-disc space-y-1 pl-4">{a.basis.map((b) => <li key={b}>{b}</li>)}</ul>
        {a.lines.length > 0 && <ul className="mt-1 space-y-0.5">{a.lines.map((l) => <li key={l.roleId}>{l.label}: {l.hours} h{l.valueMinor !== null && l.medianMinor !== null && a.currency ? ` × ${native(l.medianMinor, a.currency)} = ${native(l.valueMinor, a.currency)}` : " · no verified rate"}</li>)}</ul>}
        <ul className="mt-2 list-disc space-y-1 pl-4">{fin.rules.map((r) => <li key={r}>{r}</li>)}</ul>
      </details>
    </Card>
  );
}

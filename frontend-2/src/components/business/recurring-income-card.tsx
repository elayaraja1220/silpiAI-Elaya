"use client";

import { useEffect, useState } from "react";
import { Loader2, Repeat } from "lucide-react";

import { AdminGate } from "./admin-gate";
import { Card, jsonFetch } from "./ui";
import { formatINR } from "@/lib/business/pricing";
import type { RecurringIncome, RecurringIncomeRow } from "@/lib/business/running-services";

type Income = Omit<RecurringIncome, "rows"> & { rows: (RecurringIncomeRow & { client: string })[] };

function Figures() {
  const [income, setIncome] = useState<Income | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    jsonFetch<{ income: Income }>("/api/business/recurring-income").then((r) => setIncome(r.income)).catch((e: Error) => setError(e.message));
  }, []);

  if (!income) return <p className="flex items-center gap-2 text-xs text-slate-400">{error ? <span className="text-rose-300">{error}</span> : <><Loader2 size={14} className="animate-spin" /> Loading...</>}</p>;
  if (income.rows.length === 0) {
    return (
      <p className="text-xs text-slate-400">
        Nothing yet. A service counts here when it is billed by SILPI, shown to the client, has an amount, repeats (monthly, quarterly or yearly) and the project is approved. Set this up in a project under Costs & services.
        {income.unpriced > 0 && <span className="text-amber-200"> {income.unpriced} service{income.unpriced === 1 ? " has" : "s have"} no client amount yet.</span>}
      </p>
    );
  }
  const stat = (label: string, value: string, note?: string) => (
    <div className="rounded-xl bg-white/[.04] p-3">
      <p className="text-[11px] text-slate-400">{label}</p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums text-slate-100">{value}</p>
      {note && <p className="text-[10px] text-slate-500">{note}</p>}
    </div>
  );
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {stat("Every month", formatINR(income.monthlyRevenue), "before GST")}
        {stat("Every year", formatINR(income.yearlyRevenue), "same, times 12")}
        {stat("Your markup / month", formatINR(income.monthlyMarkup), income.costUnknown ? `${income.costUnknown} without a provider cost` : "revenue minus provider cost")}
        {stat("Clients paying", String(income.clients))}
      </div>
      <div className="overflow-x-auto rounded-xl border border-white/[.06]">
        <table className="w-full min-w-[520px] text-xs">
          <thead><tr className="bg-white/[.03] text-left text-[10px] uppercase tracking-wider text-slate-500"><th className="px-3 py-2 font-medium">Client</th><th className="px-3 py-2 font-medium">Service</th><th className="px-3 py-2 font-medium">Billed</th><th className="px-3 py-2 text-right font-medium">Per month</th><th className="px-3 py-2 text-right font-medium">Markup</th></tr></thead>
          <tbody>
            {income.rows.map((r, i) => (
              <tr key={`${r.leadId}-${r.service}-${i}`} className="border-t border-white/[.05]">
                <td className="px-3 py-2 text-slate-200">{r.client}</td>
                <td className="px-3 py-2 text-slate-300">{r.service}</td>
                <td className="px-3 py-2 text-slate-500">{r.frequency}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-100">{formatINR(r.monthlyRevenue)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-400">{r.monthlyMarkup === null ? "cost not set" : formatINR(r.monthlyMarkup)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {income.unpriced > 0 && <p className="text-[11px] text-amber-200/80">{income.unpriced} more service{income.unpriced === 1 ? " has" : "s have"} no client amount yet and {income.unpriced === 1 ? "is" : "are"} not counted.</p>}
    </div>
  );
}

/** Admin-only: what SILPI earns every month from hosting, maintenance and other repeating services, across all clients. */
export function RecurringIncomeCard() {
  return (
    <Card className="space-y-3" data-testid="recurring-income">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-300"><Repeat size={18} /></span>
        <div>
          <h3 className="text-base font-semibold">Recurring income</h3>
          <p className="text-xs text-slate-400">Monthly money from hosting, maintenance and other repeating services you bill. Team only. Not part of any quotation.</p>
        </div>
      </div>
      <AdminGate label="recurring income"><Figures /></AdminGate>
    </Card>
  );
}

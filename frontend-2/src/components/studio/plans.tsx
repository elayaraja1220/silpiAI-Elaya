"use client";

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { Card } from "@/components/business/ui";
import { cn } from "@/lib/utils";

/**
 * The price list, read from the plans the administrator maintains (GET /api/plans). Nothing is hardcoded here:
 * prices, credits and limits are whatever is stored. Money arrives as whole paise, credits as whole units (1 credit = 1000).
 * Choosing a plan is done by an owner or admin from their workspace; that screen is not built yet, so no button is offered.
 */
type Plan = { id: string; name: string; description: string; monthlyPricePaise: number | null; annualPricePaise: number | null; monthlyCreditUnits: number; maxActiveProjects: number | null; isCustom: boolean; family?: string | null };

const UNITS_PER_CREDIT = 1000;
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export function PlansPage() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [error, setError] = useState("");
  const [yearly, setYearly] = useState(false);

  useEffect(() => {
    fetch("/api/plans", { cache: "no-store" })
      .then((r) => r.json())
      .then((b: { success?: boolean; plans?: Plan[]; error?: string }) => (b.success && b.plans ? setPlans(b.plans.filter((p) => !p.family || p.family === p.id)) : setError(b.error || "Could not load the plans.")))
      .catch(() => setError("Could not load the plans."));
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Plans</h2>
          <p className="mt-1 text-xs text-slate-500">Each plan includes a number of credits every period. Prices exclude GST.</p>
        </div>
        <div className="flex rounded-full border border-white/10 p-0.5 text-xs" role="group" aria-label="Billing period">
          {[{ y: false, label: "Monthly" }, { y: true, label: "Yearly" }].map((o) => (
            <button key={o.label} onClick={() => setYearly(o.y)} aria-pressed={yearly === o.y} className={cn("rounded-full px-3 py-1.5 transition", yearly === o.y ? "bg-violet-500 text-white" : "text-slate-400 hover:text-slate-200")}>{o.label}</button>
          ))}
        </div>
      </div>

      <p className="rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-100" data-testid="plans-sample-note">
        These prices and credit amounts are proposed starting values and can be changed. Payments are recorded by the administrator for now; online payment is not connected.
      </p>

      {!plans && <Card className="flex items-center gap-2 text-sm text-slate-400">{error ? <span className="text-rose-300">{error}</span> : <><Loader2 size={15} className="animate-spin" /> Loading...</>}</Card>}

      {plans && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {plans.map((p) => {
            const annual = yearly && p.annualPricePaise !== null && p.annualPricePaise > 0;
            const price = p.isCustom ? null : annual ? p.annualPricePaise! : p.monthlyPricePaise;
            const credits = (p.monthlyCreditUnits * (annual ? 12 : 1)) / UNITS_PER_CREDIT;
            return (
              <Card key={p.id} className="flex flex-col space-y-4 p-5" data-plan={p.id}>
                <div>
                  <h3 className="text-base font-semibold text-slate-100">{p.name}</h3>
                  <p className="mt-1 text-xs text-slate-400">{p.description}</p>
                </div>
                <p className="text-3xl font-semibold tabular-nums text-slate-100">
                  {price === null ? "Custom" : price === 0 ? "Free" : rupees(price)}
                  {price !== null && price > 0 && <span className="text-xs font-normal text-slate-500"> / {annual ? "year" : "month"}</span>}
                </p>
                <ul className="flex-1 space-y-2 text-xs text-slate-200">
                  {!p.isCustom && (
                    <li className="flex items-start gap-2"><Check size={14} className="mt-px shrink-0 text-emerald-300" /><span>{credits.toLocaleString("en-IN")} credits {annual ? "per year" : "per month"}</span></li>
                  )}
                  <li className="flex items-start gap-2"><Check size={14} className="mt-px shrink-0 text-emerald-300" /><span>{p.maxActiveProjects === null ? "No project limit" : `${p.maxActiveProjects} active projects`}</span></li>
                  {p.isCustom && <li className="flex items-start gap-2"><Check size={14} className="mt-px shrink-0 text-emerald-300" /><span>Credits and terms arranged with you</span></li>}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

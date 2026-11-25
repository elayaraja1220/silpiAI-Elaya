"use client";

import { useState } from "react";
import { Check, Minus } from "lucide-react";

import { Card } from "@/components/business/ui";
import { formatINR } from "@/lib/business/pricing";
import { cn } from "@/lib/utils";

/**
 * SAMPLE plans page. The prices and limits below are guesses to look at and discuss, not decided numbers, and no
 * payment or limit is connected yet. Change them in one place: PLANS.
 */
type Plan = { id: string; name: string; tagline: string; monthly: number; popular?: boolean; features: { text: string; on: boolean }[] };

const PLANS: Plan[] = [
  {
    id: "free", name: "Free", tagline: "Try SILPI on one real client", monthly: 0,
    features: [
      { text: "1 active project", on: true },
      { text: "Quotation with GST", on: true },
      { text: "Client approval link", on: true },
      { text: "Print / save as PDF", on: true },
      { text: "Demo preview and AI build", on: false },
      { text: "Recurring income view", on: false },
    ],
  },
  {
    id: "pro", name: "Pro", tagline: "For a working freelancer", monthly: 999, popular: true,
    features: [
      { text: "Unlimited projects", on: true },
      { text: "Quotation with GST", on: true },
      { text: "Client approval link and payments tracking", on: true },
      { text: "Demo preview and AI build (monthly allowance)", on: true },
      { text: "Hosting and maintenance billing, recurring income view", on: true },
      { text: "Team members", on: false },
    ],
  },
  {
    id: "business", name: "Business", tagline: "For a small agency", monthly: 2999,
    features: [
      { text: "Everything in Pro", on: true },
      { text: "Bigger AI build allowance", on: true },
      { text: "Up to 5 team members", on: true },
      { text: "Your own logo and details on every quotation", on: true },
      { text: "Priority support", on: true },
    ],
  },
];

const YEARLY_MONTHS = 10; // pay for 10, get 12

export function PlansPage() {
  const [yearly, setYearly] = useState(false);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Plans</h2>
          <p className="mt-1 text-xs text-slate-500">Choose how you want to use SILPI. You can change the plan later.</p>
        </div>
        <div className="flex rounded-full border border-white/10 p-0.5 text-xs" role="group" aria-label="Billing period">
          {[{ y: false, label: "Monthly" }, { y: true, label: "Yearly · 2 months free" }].map((o) => (
            <button key={o.label} onClick={() => setYearly(o.y)} aria-pressed={yearly === o.y} className={cn("rounded-full px-3 py-1.5 transition", yearly === o.y ? "bg-violet-500 text-white" : "text-slate-400 hover:text-slate-200")}>{o.label}</button>
          ))}
        </div>
      </div>

      <p className="rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-100" data-testid="plans-sample-note">
        Sample plans for review. The prices and limits are not final and payment is not connected yet.
      </p>

      <div className="grid gap-4 lg:grid-cols-3">
        {PLANS.map((p) => {
          const perMonth = yearly ? Math.round((p.monthly * YEARLY_MONTHS) / 12) : p.monthly;
          return (
            <Card key={p.id} className={cn("flex flex-col space-y-4", p.popular && "border-violet-400/50")}>
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-slate-100">{p.name}</h3>
                  {p.popular && <span className="rounded-full bg-violet-500/25 px-2 py-0.5 text-[10px] font-medium text-violet-200">Most chosen</span>}
                </div>
                <p className="mt-1 text-xs text-slate-400">{p.tagline}</p>
              </div>
              <p className="text-3xl font-semibold tabular-nums text-slate-100">
                {p.monthly === 0 ? "Free" : formatINR(perMonth)}
                {p.monthly > 0 && <span className="text-xs font-normal text-slate-500"> / month</span>}
              </p>
              {yearly && p.monthly > 0 && <p className="-mt-3 text-[11px] text-slate-500">{formatINR(p.monthly * YEARLY_MONTHS)} billed once a year</p>}
              <ul className="flex-1 space-y-2 text-xs">
                {p.features.map((f) => (
                  <li key={f.text} className={cn("flex items-start gap-2", f.on ? "text-slate-200" : "text-slate-600")}>
                    {f.on ? <Check size={14} className="mt-px shrink-0 text-emerald-300" /> : <Minus size={14} className="mt-px shrink-0" />}
                    <span>{f.text}</span>
                  </li>
                ))}
              </ul>
              <button disabled className="w-full cursor-not-allowed rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-500" title="Payment is not connected yet">Billing not connected yet</button>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";

import { CURRENCY_CODES, CURRENCY_INFO, formatAmount, type CurrencyCode } from "@/lib/currencies";
import { cn } from "@/lib/utils";
import { api, Button, Card, credits, inputClass, Notice, Pill } from "./light";

type PlanPrice = { currency: string; period: "monthly" | "annual"; amountMinor: number };
type AdminPlan = { id: string; name: string; description: string; prices: PlanPrice[]; monthlyCreditUnits: number; active: boolean; isCustom: boolean; trialDays: number | null; trialCreditUnits: number; sortOrder: number };

const priceOf = (p: AdminPlan, currency: string, period: "monthly" | "annual") => p.prices.find((x) => x.currency === currency && x.period === period)?.amountMinor ?? null;
const exponent = (c: string) => CURRENCY_INFO[c as CurrencyCode]?.exponent ?? 2;
const toInput = (minor: number | null, c: string) => (minor === null ? "" : String(minor / 10 ** exponent(c)));
const toMinor = (text: string, c: string) => Math.round(Number(text) * 10 ** exponent(c));

/** Plans: what each costs in every currency, its credits, its free trial, and whether it is on sale. Changes reach only people who subscribe AFTER them. */
export function PlansAdmin({ onNote, onError }: { onNote: (m: string) => void; onError: (e: unknown) => void }) {
  const [plans, setPlans] = useState<AdminPlan[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => { api<{ plans: AdminPlan[] }>("/api/admin/plans").then((r) => setPlans(r.plans)).catch(onError); }, [onError]);
  useEffect(load, [load]);
  if (!plans) return <Card className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Loading plans...</Card>;
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Plans</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">Prices are written in each currency's own units. A change reaches only organizations that subscribe afterwards: everyone already subscribed keeps the price and the credits they were sold at. Yearly is normally ten times the monthly price (two months free).</p>
      </div>
      <ul className="divide-y divide-slate-100">
        {plans.map((p) => (
          <li key={p.id} className="py-2.5">
            <button onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 text-left">
              <span className="min-w-36 text-sm font-semibold text-slate-900">{p.name} <span className="font-normal text-slate-400">({p.id})</span></span>
              <span className="text-sm tabular-nums text-slate-700">{p.isCustom ? "custom" : `${credits(p.monthlyCreditUnits)} credits`}</span>
              <span className="text-sm tabular-nums text-slate-700">{[["USD", "monthly"], ["INR", "monthly"], ["GBP", "monthly"]].map(([c, per]) => { const v = priceOf(p, c!, per as "monthly"); return v === null ? null : formatAmount(v, c as CurrencyCode); }).filter(Boolean).join(" · ") || "no price"}</span>
              {p.trialDays && <Pill tone="indigo">{p.trialDays}-day trial</Pill>}
              {!p.active && <Pill tone="red">off sale</Pill>}
              <ChevronDown size={16} className={cn("ml-auto shrink-0 text-slate-400 transition", open === p.id && "rotate-180")} />
            </button>
            {open === p.id && <PlanEditor plan={p} onSaved={(m) => { onNote(m); load(); }} onError={onError} />}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PlanEditor({ plan, onSaved, onError }: { plan: AdminPlan; onSaved: (m: string) => void; onError: (e: unknown) => void }) {
  const [creditsText, setCreditsText] = useState(String(plan.monthlyCreditUnits / 1000));
  const [trialDays, setTrialDays] = useState(plan.trialDays === null ? "" : String(plan.trialDays));
  const [trialCredits, setTrialCredits] = useState(String(plan.trialCreditUnits / 1000));
  const savePlan = (active = plan.active) =>
    api("/api/admin/plans", { method: "PUT", body: { id: plan.id, monthlyCreditUnits: Math.round(Number(creditsText) * 1000), trialDays: trialDays.trim() === "" ? null : Number(trialDays), trialCreditUnits: Math.round(Number(trialCredits) * 1000), active } }).then(() => onSaved(`${plan.name} saved.`)).catch(onError);
  return (
    <div className="mt-3 space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-600">Credits a month<input value={creditsText} onChange={(e) => setCreditsText(e.target.value.replace(/[^\d.]/g, ""))} className={inputClass + " mt-1 w-32"} /></label>
        <label className="text-xs text-slate-600">Trial days (empty = none)<input value={trialDays} onChange={(e) => setTrialDays(e.target.value.replace(/\D/g, ""))} disabled={plan.id === "free"} className={inputClass + " mt-1 w-32"} /></label>
        <label className="text-xs text-slate-600">Trial credits<input value={trialCredits} onChange={(e) => setTrialCredits(e.target.value.replace(/[^\d.]/g, ""))} disabled={plan.id === "free"} className={inputClass + " mt-1 w-32"} /></label>
        <Button variant="ghost" onClick={() => void savePlan()}>Save</Button>
        <Button variant={plan.active ? "danger" : "primary"} onClick={() => void savePlan(!plan.active)}>{plan.active ? "Take off sale" : "Put on sale"}</Button>
      </div>
      {plan.id !== "free" && !plan.isCustom && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead><tr className="text-left text-xs text-slate-500"><th className="py-1 pr-3 font-medium">Currency</th><th className="py-1 pr-3 font-medium">Monthly</th><th className="py-1 pr-3 font-medium">Yearly</th><th /></tr></thead>
            <tbody>{CURRENCY_CODES.map((c) => <PriceRow key={c + priceOf(plan, c, "monthly") + priceOf(plan, c, "annual")} plan={plan} currency={c} onSaved={onSaved} onError={onError} />)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PriceRow({ plan, currency, onSaved, onError }: { plan: AdminPlan; currency: CurrencyCode; onSaved: (m: string) => void; onError: (e: unknown) => void }) {
  const [m, setM] = useState(toInput(priceOf(plan, currency, "monthly"), currency));
  const [y, setY] = useState(toInput(priceOf(plan, currency, "annual"), currency));
  const set = (period: "monthly" | "annual", text: string) => api("/api/admin/plans/prices", { method: "PUT", body: { planId: plan.id, currency, period, amountMinor: text.trim() === "" ? null : toMinor(text, currency) } });
  const save = () => Promise.all([set("monthly", m), set("annual", y)]).then(() => onSaved(`${plan.name} price in ${currency} saved.`)).catch(onError);
  const field = "w-28 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm tabular-nums outline-none focus:border-indigo-500";
  return (
    <tr className="border-t border-slate-200">
      <td className="py-1.5 pr-3 text-slate-800">{currency} <span className="text-xs text-slate-400">{CURRENCY_INFO[currency].name}</span></td>
      <td className="py-1.5 pr-3"><input value={m} onChange={(e) => { setM(e.target.value.replace(/[^\d.]/g, "")); }} placeholder="not sold" aria-label={`${currency} monthly price`} className={field} /></td>
      <td className="py-1.5 pr-3"><input value={y} onChange={(e) => setY(e.target.value.replace(/[^\d.]/g, ""))} placeholder="not sold" aria-label={`${currency} yearly price`} className={field} /></td>
      <td className="py-1.5"><Button variant="ghost" className="px-3 py-1" onClick={() => void save()}>Save</Button></td>
    </tr>
  );
}

// ---- coupons ------------------------------------------------------------------------------------------------------------------
type Coupon = { id: string; code: string; name: string; kind: "percent" | "fixed"; percentBp: number | null; fixedAmountMinor: number | null; fixedCurrency: string | null; duration: string; durationMonths: number | null; validFrom: string | null; validUntil: string | null; maxRedemptions: number | null; active: boolean; redemptions: number };

export function CouponsAdmin({ onNote, onError }: { onNote: (m: string) => void; onError: (e: unknown) => void }) {
  const [coupons, setCoupons] = useState<Coupon[] | null>(null);
  const [f, setF] = useState({ code: "", kind: "percent", amount: "20", currency: "USD", duration: "once", months: "3", limit: "" });
  const [error, setError] = useState("");
  const load = useCallback(() => { api<{ coupons: Coupon[] }>("/api/admin/coupons").then((r) => setCoupons(r.coupons)).catch(onError); }, [onError]);
  useEffect(load, [load]);
  const create = () => {
    setError("");
    const body: Record<string, unknown> = { code: f.code, duration: f.duration };
    if (f.kind === "percent") body.percentBasisPoints = Math.round(Number(f.amount) * 100);
    else { body.fixedAmountMinor = toMinor(f.amount, f.currency); body.fixedCurrency = f.currency; }
    if (f.duration === "repeating") body.durationMonths = Number(f.months);
    if (f.limit.trim()) body.maxRedemptions = Number(f.limit);
    api("/api/admin/coupons", { method: "PUT", body }).then(() => { onNote("Coupon saved."); setF({ ...f, code: "" }); load(); }).catch((e: Error) => setError(e.message));
  };
  const toggle = (c: Coupon) =>
    api("/api/admin/coupons", { method: "PUT", body: { code: c.code, name: c.name, ...(c.kind === "percent" ? { percentBasisPoints: c.percentBp } : { fixedAmountMinor: c.fixedAmountMinor, fixedCurrency: c.fixedCurrency }), duration: c.duration, durationMonths: c.durationMonths ?? undefined, validFrom: c.validFrom, validUntil: c.validUntil, maxRedemptions: c.maxRedemptions, active: !c.active } }).then(() => { onNote("Coupon updated."); load(); }).catch(onError);
  const describe = (c: Coupon) => `${c.kind === "percent" ? `${(c.percentBp ?? 0) / 100}% off` : `${formatAmount(c.fixedAmountMinor ?? 0, c.fixedCurrency as CurrencyCode)} off`} · ${c.duration === "once" ? "first invoice" : c.duration === "forever" ? "every invoice" : `first ${c.durationMonths} months`}`;
  const sel = "rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm outline-none focus:border-indigo-500";
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Coupons</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">A discount code a customer enters when they subscribe. Each organization can use a coupon once. After a coupon has been used its discount cannot change: switch it off and make a new one.</p>
      </div>
      {coupons === null ? <p className="text-sm text-slate-400">Loading...</p> : coupons.length === 0 ? <p className="text-sm text-slate-500">No coupons yet.</p> : (
        <ul className="divide-y divide-slate-100">
          {coupons.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
              <span className="font-mono font-semibold text-slate-900">{c.code}</span>
              <span className="text-slate-600">{describe(c)}</span>
              <span className="text-xs text-slate-400">{c.redemptions}{c.maxRedemptions ? ` of ${c.maxRedemptions}` : ""} used</span>
              {!c.active && <Pill tone="red">off</Pill>}
              <Button variant="ghost" className="ml-auto px-3 py-1.5" onClick={() => void toggle(c)}>{c.active ? "Turn off" : "Turn on"}</Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <label className="text-xs text-slate-600">Code<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "") })} className={inputClass + " mt-1 w-40"} placeholder="SPRING20" /></label>
        <label className="text-xs text-slate-600">Type<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} className={sel + " mt-1 block"}><option value="percent">Percent off</option><option value="fixed">Amount off</option></select></label>
        <label className="text-xs text-slate-600">{f.kind === "percent" ? "Percent" : "Amount"}<input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, "") })} className={inputClass + " mt-1 w-24"} /></label>
        {f.kind === "fixed" && <label className="text-xs text-slate-600">Currency<select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} className={sel + " mt-1 block"}>{CURRENCY_CODES.map((c) => <option key={c}>{c}</option>)}</select></label>}
        <label className="text-xs text-slate-600">Lasts<select value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })} className={sel + " mt-1 block"}><option value="once">First invoice</option><option value="repeating">A number of months</option><option value="forever">Every invoice</option></select></label>
        {f.duration === "repeating" && <label className="text-xs text-slate-600">Months<input value={f.months} onChange={(e) => setF({ ...f, months: e.target.value.replace(/\D/g, "") })} className={inputClass + " mt-1 w-20"} /></label>}
        <label className="text-xs text-slate-600">Limit (empty = none)<input value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value.replace(/\D/g, "") })} className={inputClass + " mt-1 w-28"} /></label>
        <Button onClick={create} disabled={f.code.length < 3 || !f.amount}>Add coupon</Button>
      </div>
      {error && <Notice tone="red">{error}</Notice>}
    </Card>
  );
}

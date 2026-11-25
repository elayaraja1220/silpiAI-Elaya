"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { CURRENCY_CODES, CURRENCY_INFO, formatAmount, isCurrency, type CurrencyCode } from "@/lib/currencies";
import { currencyFromQuery, pickCurrency } from "@/lib/geo";
import { WALLET_CHANGED } from "./ai-shell";
import { api, Button, Card, credits, inputClass, Notice, Pill, Stat } from "./light";

type PlanPrice = { currency: string; period: "monthly" | "annual"; amountMinor: number };
type Plan = { id: string; name: string; description: string; prices: PlanPrice[]; monthlyCreditUnits: number; isCustom: boolean; trialDays: number | null };
type Sub = { id: string; planId: string; pendingPlanId: string | null; status: string; billingPeriod: "monthly" | "annual"; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; currency: string; unitAmountMinor: number | null; allowanceMonthlyUnits: number | null; trialEndsAt: string | null };
type Invoice = { id: string; number: string; currency: string; listPriceMinor: number; discountMinor: number; couponCode: string | null; gstPaise: number; totalPaise: number; status: "open" | "paid" | "void"; issuedAt: string; paidAt: string | null; periodStart: string; periodEnd: string };
type Billing = { running: Sub | null; plan: Plan | null; scheduledPlan: Plan | null; pending: Sub | null; pendingPlan: Plan | null; openInvoices: Invoice[] };
type LedgerRow = { id: number; kind: string; deltaUnits: number; note: string; createdAt: string };
type BillingResponse = { canManage: boolean; billing: Billing; invoices?: Invoice[]; ledger?: LedgerRow[] };
type Wallet = { wallet: { balanceUnits: number; reservedUnits: number; availableUnits: number }; summary: { byCategory: Record<string, { remainingUnits: number; heldUnits: number }>; nextExpiry: { at: string; units: number } | null }; buckets: { id: string; category: string; remainingUnits: number; expiresAt: string | null }[] };
type Pack = { id: string; name: string; creditUnits: number; prices: { currency: string; amountMinor: number }[] };
type Topup = { id: string; number: string; creditUnits: number; currency: string; totalMinor: number; status: "pending" | "paid" | "cancelled"; createdAt: string };
type PaymentRow = { id: string; purpose: string; currency: string; amountMinor: number; status: string; refundedMinor: number; createdAt: string };
type Profile = { legalName: string; country: string; addressLine1: string; addressLine2: string; city: string; region: string; postalCode: string; taxId: string; taxIdType: string };
type TopupResponse = { packages: Pack[]; topups: Topup[]; payments: PaymentRow[] };

const fmt = (minor: number, c: string) => (isCurrency(c) ? formatAmount(minor, c) : `${minor} ${c}`);
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "-");
const CATEGORY: Record<string, string> = { promotional: "Free & bonus", subscription: "From your plan", purchased: "Bought" };
const KIND: Record<string, string> = { grant: "Credits added", purchase: "Credits bought", refund: "Refund", adjust: "Adjustment", settle: "AI use", reserve: "Held", release: "Released", extend: "Held more" };
const priceOf = (p: Plan, c: string, period: "monthly" | "annual") => p.prices.find((x) => x.currency === c && x.period === period)?.amountMinor ?? null;
const exponent = (c: string) => CURRENCY_INFO[c as CurrencyCode]?.exponent ?? 2;
const toneOf = (s: string): "green" | "red" | "amber" | "slate" => (s === "paid" || s === "succeeded" || s === "active" ? "green" : s === "void" || s === "failed" || s === "cancelled" || s === "ended" ? "red" : s === "open" || s === "pending" || s === "pending_payment" || s === "past_due" ? "amber" : "slate");

/** The customer's billing page: plan, credits, plan changes, buying credits, and every invoice, payment and credit movement. */
export function BillingPage() {
  const [b, setB] = useState<BillingResponse | null>(null);
  const [w, setW] = useState<Wallet | null>(null);
  const [t, setT] = useState<TopupResponse | null>(null);
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [guess, setGuess] = useState<CurrencyCode>("USD");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const billing = await api<BillingResponse>("/api/workspace/billing");
      setB(billing);
      setW(await api<Wallet>("/api/workspace/wallet"));
      if (billing.canManage) {
        setT(await api<TopupResponse>("/api/workspace/billing/topup"));
        setProfile((await api<{ profile: Profile | null }>("/api/workspace/billing/profile")).profile);
      }
      window.dispatchEvent(new Event(WALLET_CHANGED));
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => {
    void load();
    fetch("/api/plans", { cache: "no-store" }).then((r) => r.json()).then((x: { plans?: Plan[]; country?: string | null }) => {
      setPlans(x.plans ?? []);
      setGuess(currencyFromQuery(new URLSearchParams(window.location.search).get("currency")) ?? pickCurrency({ country: x.country, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: navigator.language }));
    }).catch(() => undefined);
  }, [load]);

  if (error) return <Notice tone="red">{error}</Notice>;
  if (!b || !w) return <Card className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Loading...</Card>;
  const flash = (m: string) => { setNote(m); setTimeout(() => setNote(""), 5000); };
  const fail = (e: unknown) => setError((e as Error).message);
  const paidCurrency = b.billing.running && b.billing.running.unitAmountMinor ? b.billing.running.currency : null;
  const waitingCurrency = b.billing.openInvoices[0]?.currency ?? b.billing.pending?.currency;
  const startCurrency: CurrencyCode = !paidCurrency && waitingCurrency && isCurrency(waitingCurrency) ? waitingCurrency : guess;
  const done = (m: string) => { flash(m); void load(); };

  return (
    <div className="space-y-5">
      {note && <Notice tone="green">{note}</Notice>}
      <PlanCard billing={b.billing} canManage={b.canManage} onDone={done} onError={fail} />
      <CreditsCard wallet={w} />
      {b.canManage ? (
        <>
          <BillingDetails profile={profile ?? null} loaded={profile !== undefined} onDone={done} onError={fail} />
          <ChangePlan billing={b.billing} plans={plans} fixedCurrency={paidCurrency} guess={startCurrency} onDone={done} onError={fail} />
          {t && <BuyCredits data={t} fixedCurrency={paidCurrency} guess={startCurrency} onDone={done} onError={fail} />}
          <History invoices={b.invoices ?? []} payments={t?.payments ?? []} ledger={b.ledger ?? []} />
        </>
      ) : <Notice tone="slate">Only an owner or an admin of this organization can change the plan, buy credits or see invoices.</Notice>}
    </div>
  );
}

function PlanCard({ billing, canManage, onDone, onError }: { billing: Billing; canManage: boolean; onDone: (m: string) => void; onError: (e: unknown) => void }) {
  const s = billing.running;
  const plan = billing.plan;
  const [busy, setBusy] = useState(false);
  const act = (action: "cancel" | "keep") => {
    setBusy(true);
    api("/api/workspace/billing/cancel", { method: "POST", body: { action } }).then(() => onDone(action === "cancel" ? "Your plan will end at the end of this period. You keep everything until then." : "Your plan will continue.")).catch(onError).finally(() => setBusy(false));
  };
  const trial = s?.trialEndsAt && new Date(s.trialEndsAt) > new Date();
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-slate-900">{plan?.name ?? "No plan yet"}</h2>
        {s && <Pill tone={toneOf(s.status)}>{s.status.replace("_", " ")}</Pill>}
        {trial && <Pill tone="indigo">free trial until {day(s!.trialEndsAt)}</Pill>}
        {s?.cancelAtPeriodEnd && <Pill tone="amber">ends {day(s.currentPeriodEnd)}</Pill>}
      </div>
      {s && plan && (
        <p className="text-sm text-slate-600">
          {s.unitAmountMinor ? <><b className="text-slate-900">{fmt(s.unitAmountMinor, s.currency)}</b> per {s.billingPeriod === "annual" ? "year" : "month"}, </> : null}
          {credits(s.allowanceMonthlyUnits ?? plan.monthlyCreditUnits)} credits every month.
          {s.currentPeriodEnd && s.unitAmountMinor ? <> Current period ends <b>{day(s.currentPeriodEnd)}</b>.</> : null}
          {s.unitAmountMinor ? " The price and credits you signed up at stay the same while you remain subscribed." : ""}
        </p>
      )}
      {!s && <p className="text-sm text-slate-600">Choose a plan below to get your monthly credits.</p>}
      {billing.scheduledPlan && <Notice tone="slate">You move to <b>{billing.scheduledPlan.name}</b> when this period ends.</Notice>}
      {billing.pending && billing.pendingPlan && <Notice tone="amber">Your request for <b>{billing.pendingPlan.name}</b> is waiting for payment. It starts as soon as the payment is confirmed.</Notice>}
      {billing.openInvoices.map((i) => (
        <Notice key={i.id} tone="amber">Invoice <b>{i.number}</b> for <b>{fmt(i.totalPaise, i.currency)}</b> is waiting for payment. Pay it and quote the invoice number; your plan and credits start when the payment is confirmed.</Notice>
      ))}
      {canManage && s && (s.unitAmountMinor ?? 0) > 0 && (
        <div>{s.cancelAtPeriodEnd ? <Button variant="ghost" onClick={() => act("keep")} disabled={busy}>Keep my plan</Button> : <Button variant="ghost" onClick={() => act("cancel")} disabled={busy}>Cancel at the end of the period</Button>}</div>
      )}
    </Card>
  );
}

function CreditsCard({ wallet }: { wallet: Wallet }) {
  const { wallet: w, summary, buckets } = wallet;
  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-semibold text-slate-900">Your credits</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Available now" value={credits(w.availableUnits)} hint={w.reservedUnits > 0 ? `${credits(w.reservedUnits)} held for running work` : "nothing held"} />
        {(["subscription", "purchased", "promotional"] as const).map((c) => <Stat key={c} label={CATEGORY[c]!} value={credits(summary.byCategory[c]?.remainingUnits ?? 0)} />)}
      </div>
      <p className="text-xs leading-5 text-slate-600">
        Credits are spent in this order: free and bonus credits first, then your plan&apos;s credits, then credits you bought. Credits that expire are used before ones that do not.
        {summary.nextExpiry ? <> Next to expire: <b>{credits(summary.nextExpiry.units)}</b> on {day(summary.nextExpiry.at)}.</> : <> None of your credits are due to expire.</>}
      </p>
      {buckets.length > 0 && (
        <ul className="divide-y divide-slate-100 text-sm">
          {buckets.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-3 py-1.5"><span className="min-w-32 text-slate-700">{CATEGORY[x.category] ?? x.category}</span><span className="tabular-nums font-medium text-slate-900">{credits(x.remainingUnits)}</span><span className="text-xs text-slate-500">{x.expiresAt ? `expires ${day(x.expiresAt)}` : "does not expire"}</span></li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CurrencyPick({ value, onChange, fixed }: { value: string; onChange: (c: string) => void; fixed: string | null }) {
  if (fixed) return <p className="text-xs text-slate-500">Billed in {fixed}. A subscription stays in the currency it started in.</p>;
  return (
    <label className="inline-block text-xs text-slate-600">Currency
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass + " mt-1 block !w-40"} aria-label="Currency">{CURRENCY_CODES.map((c) => <option key={c} value={c}>{c} {CURRENCY_INFO[c].symbol}</option>)}</select>
    </label>
  );
}

const EMPTY: Profile = { legalName: "", country: "", addressLine1: "", addressLine2: "", city: "", region: "", postalCode: "", taxId: "", taxIdType: "" };

/** Who invoices are made out to. The country also decides which tax is added. */
function BillingDetails({ profile, loaded, onDone, onError }: { profile: Profile | null; loaded: boolean; onDone: (m: string) => void; onError: (e: unknown) => void }) {
  const [f, setF] = useState<Profile>(profile ?? EMPTY);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (profile) setF(profile); }, [profile]);
  if (!loaded) return null;
  const set = (k: keyof Profile, v: string) => setF({ ...f, [k]: v });
  const save = () => {
    setBusy(true);
    api("/api/workspace/billing/profile", { method: "PUT", body: f }).then(() => { setOpen(false); onDone("Billing details saved. They apply to invoices raised from now on."); }).catch(onError).finally(() => setBusy(false));
  };
  const complete = f.legalName.trim().length >= 2 && /^[A-Za-z]{2}$/.test(f.country) && f.addressLine1.trim().length >= 2 && f.city.trim().length >= 1;
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-slate-900">Billing details</h2>
        {!profile && <Pill tone="amber">not added yet</Pill>}
        <Button variant="ghost" className="ml-auto px-3 py-1.5" onClick={() => setOpen(!open)}>{open ? "Close" : profile ? "Edit" : "Add"}</Button>
      </div>
      {!open && (profile ? (
        <p className="text-sm text-slate-600"><b className="text-slate-900">{profile.legalName}</b>, {[profile.addressLine1, profile.city, profile.country].filter(Boolean).join(", ")}{profile.taxId ? ` · ${profile.taxIdType || "Tax no."} ${profile.taxId}` : ""}</p>
      ) : <p className="text-sm text-slate-600">Add your company or personal billing details so invoices carry your name, address and tax number. The country you choose decides which tax is added to new invoices.</p>)}
      {open && (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-slate-600">Name on the invoice<input value={f.legalName} onChange={(e) => set("legalName", e.target.value)} className={inputClass + " mt-1"} aria-label="Legal name" /></label>
          <label className="text-xs text-slate-600">Country (2 letters, e.g. IN, GB, US)<input value={f.country} onChange={(e) => set("country", e.target.value.toUpperCase().slice(0, 2))} className={inputClass + " mt-1"} aria-label="Country" /></label>
          <label className="text-xs text-slate-600">Address<input value={f.addressLine1} onChange={(e) => set("addressLine1", e.target.value)} className={inputClass + " mt-1"} aria-label="Address line 1" /></label>
          <label className="text-xs text-slate-600">Address line 2 (optional)<input value={f.addressLine2} onChange={(e) => set("addressLine2", e.target.value)} className={inputClass + " mt-1"} aria-label="Address line 2" /></label>
          <label className="text-xs text-slate-600">City<input value={f.city} onChange={(e) => set("city", e.target.value)} className={inputClass + " mt-1"} aria-label="City" /></label>
          <div className="flex gap-2">
            <label className="flex-1 text-xs text-slate-600">State or region<input value={f.region} onChange={(e) => set("region", e.target.value)} className={inputClass + " mt-1"} aria-label="State or region" /></label>
            <label className="w-28 text-xs text-slate-600">Postal code<input value={f.postalCode} onChange={(e) => set("postalCode", e.target.value)} className={inputClass + " mt-1"} aria-label="Postal code" /></label>
          </div>
          <label className="text-xs text-slate-600">Tax number, e.g. GSTIN or VAT (optional)<input value={f.taxId} onChange={(e) => set("taxId", e.target.value)} className={inputClass + " mt-1"} aria-label="Tax number" /></label>
          <label className="text-xs text-slate-600">Type of number (optional)<input value={f.taxIdType} onChange={(e) => set("taxIdType", e.target.value)} placeholder="GSTIN, VAT..." className={inputClass + " mt-1"} aria-label="Type of tax number" /></label>
          <div className="sm:col-span-2"><Button onClick={save} disabled={!complete || busy}>{busy && <Loader2 size={14} className="animate-spin" />} Save details</Button></div>
        </div>
      )}
    </Card>
  );
}

function ChangePlan({ billing, plans, fixedCurrency, guess, onDone, onError }: { billing: Billing; plans: Plan[]; fixedCurrency: string | null; guess: CurrencyCode; onDone: (m: string) => void; onError: (e: unknown) => void }) {
  const [currency, setCurrency] = useState<string>(guess);
  const [period, setPeriod] = useState<"monthly" | "annual">("monthly");
  const [coupon, setCoupon] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setCurrency(guess), [guess]);
  const cur = fixedCurrency ?? currency;
  const shown = useMemo(() => plans.filter((p) => !p.isCustom && (priceOf(p, cur, "monthly") !== null || p.id === "free")), [plans, cur]);
  const choose = async (p: Plan) => {
    setBusy(p.id);
    try {
      const r = await api<{ result: { kind: string; invoice: Invoice | null; effectiveAt?: string | null } }>("/api/workspace/billing/plan", { method: "POST", body: { planId: p.id, period, currency: cur, ...(coupon.trim() ? { couponCode: coupon.trim() } : {}) } });
      const inv = r.result.invoice;
      onDone(inv ? `Invoice ${inv.number} for ${fmt(inv.totalPaise, inv.currency)} created. Your ${p.name} plan starts when the payment is confirmed.` : r.result.kind === "scheduled" ? `You will move to ${p.name} at the end of this period.` : `You are on ${p.name}.`);
    } catch (e) { onError(e); } finally { setBusy(null); }
  };
  const current = billing.plan?.id;
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Change plan</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">Choosing a plan creates an invoice. Nothing is charged until the payment is confirmed. Moving to a cheaper plan takes effect when the current period ends.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <CurrencyPick value={currency} onChange={setCurrency} fixed={fixedCurrency} />
        <label className="text-xs text-slate-600">Billed<select value={period} onChange={(e) => setPeriod(e.target.value as typeof period)} className={inputClass + " mt-1 block !w-40"} aria-label="Billing period"><option value="monthly">Monthly</option><option value="annual">Yearly (2 months free)</option></select></label>
        <label className="text-xs text-slate-600">Coupon code (optional)<input value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} className={inputClass + " mt-1 block !w-44"} aria-label="Coupon code" /></label>
      </div>
      <ul className="divide-y divide-slate-100">
        {shown.map((p) => {
          const price = priceOf(p, cur, period);
          return (
            <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm">
              <span className="min-w-28 font-semibold text-slate-900">{p.name}</span>
              <span className="tabular-nums text-slate-700">{credits(p.monthlyCreditUnits)} credits / month</span>
              <span className="tabular-nums text-slate-700">{price === null ? "Free" : `${fmt(price, cur)} / ${period === "annual" ? "year" : "month"}`}</span>
              {p.trialDays && !billing.running?.trialEndsAt ? <Pill tone="indigo">{p.trialDays}-day free trial</Pill> : null}
              <span className="ml-auto">{p.id === current ? <Pill tone="green">current plan</Pill> : <Button variant="ghost" className="px-3 py-1.5" disabled={busy !== null} onClick={() => void choose(p)}>{busy === p.id && <Loader2 size={14} className="animate-spin" />} Choose</Button>}</span>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-slate-500">Need more than Studio? Enterprise plans are made to order: contact us.</p>
    </Card>
  );
}

function BuyCredits({ data, fixedCurrency, guess, onDone, onError }: { data: TopupResponse; fixedCurrency: string | null; guess: CurrencyCode; onDone: (m: string) => void; onError: (e: unknown) => void }) {
  const [currency, setCurrency] = useState<string>(guess);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setCurrency(guess), [guess]);
  const cur = fixedCurrency ?? currency;
  const order = async (p: Pack) => {
    setBusy(p.id);
    try {
      const r = await api<{ topup: Topup }>("/api/workspace/billing/topup", { method: "POST", body: { packageId: p.id, currency: cur } });
      onDone(`Order ${r.topup.number} created for ${fmt(r.topup.totalMinor, r.topup.currency)}. Pay it and quote the order number; ${credits(r.topup.creditUnits)} credits are added as soon as the payment is confirmed.`);
    } catch (e) { onError(e); } finally { setBusy(null); }
  };
  const cancel = (id: string) => api(`/api/workspace/billing/topup?id=${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => onDone("Order cancelled.")).catch(onError);
  const unpaid = data.topups.filter((x) => x.status === "pending");
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Buy more credits</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">Extra credits for when your plan&apos;s credits run out. They are used after your plan&apos;s credits. Credits you buy are only added once the payment is confirmed. Rupee prices include GST (added at checkout).</p>
      </div>
      <CurrencyPick value={currency} onChange={setCurrency} fixed={fixedCurrency} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {data.packages.map((p) => {
          const price = p.prices.find((x) => x.currency === cur)?.amountMinor ?? null;
          return (
            <div key={p.id} className="rounded-xl border border-slate-200 p-3">
              <p className="text-lg font-semibold tabular-nums text-slate-900">{credits(p.creditUnits)}</p>
              <p className="text-xs text-slate-500">credits</p>
              <p className="mt-2 text-sm font-medium text-slate-800">{price === null ? "Not sold in " + cur : fmt(price, cur)}</p>
              <Button variant="ghost" className="mt-2 w-full justify-center" disabled={price === null || busy !== null} onClick={() => void order(p)}>{busy === p.id && <Loader2 size={14} className="animate-spin" />} Order</Button>
            </div>
          );
        })}
      </div>
      {unpaid.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-slate-700">Orders waiting for payment</p>
          {unpaid.map((x) => (
            <div key={x.id} className="flex flex-wrap items-center gap-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <b>{x.number}</b><span>{credits(x.creditUnits)} credits</span><span>{fmt(x.totalMinor, x.currency)}</span><a href={`/ai/billing/document?kind=topup&id=${encodeURIComponent(x.id)}`} className="text-xs underline">View / print</a>
              <Button variant="ghost" className="ml-auto px-3 py-1" onClick={() => void cancel(x.id)}>Cancel order</Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function History({ invoices, payments, ledger }: { invoices: Invoice[]; payments: PaymentRow[]; ledger: LedgerRow[] }) {
  const th = "py-2 pr-4 text-left text-xs font-medium text-slate-500";
  return (
    <Card className="space-y-5">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">Invoices</h2>
        {invoices.length === 0 ? <p className="text-sm text-slate-500">No invoices yet.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-slate-200"><th className={th}>Number</th><th className={th}>Date</th><th className={th}>Period</th><th className={th + " text-right"}>Amount</th><th className={th}>Status</th><th className={th}></th></tr></thead>
            <tbody>{invoices.map((i) => (
              <tr key={i.id} className="border-b border-slate-100 last:border-0">
                <td className="py-2 pr-4 font-medium text-slate-800">{i.number}</td><td className="py-2 pr-4 text-slate-600">{day(i.issuedAt)}</td><td className="py-2 pr-4 text-slate-600">{day(i.periodStart)} - {day(i.periodEnd)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{fmt(i.totalPaise, i.currency)}{i.discountMinor > 0 && <span className="block text-xs text-emerald-700">{i.couponCode ?? "discount"}: -{fmt(i.discountMinor, i.currency)}</span>}{i.gstPaise > 0 && <span className="block text-xs text-slate-500">incl. GST {fmt(i.gstPaise, i.currency)}</span>}</td>
                <td className="py-2 pr-4"><Pill tone={toneOf(i.status)}>{i.status}</Pill></td>
                <td className="py-2"><a href={`/ai/billing/document?kind=invoice&id=${encodeURIComponent(i.id)}`} className="text-xs text-indigo-700 hover:underline">View / print</a></td>
              </tr>
            ))}</tbody></table></div>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">Payments</h2>
        {payments.length === 0 ? <p className="text-sm text-slate-500">No payments yet.</p> : (
          <ul className="divide-y divide-slate-100 text-sm">{payments.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 py-2"><span className="tabular-nums font-medium text-slate-900">{fmt(p.amountMinor, p.currency)}</span><Pill tone={toneOf(p.status)}>{p.status.replace("_", " ")}</Pill><span className="text-xs text-slate-500">{p.purpose === "topup" ? "credits" : "plan"} · {day(p.createdAt)}</span>{p.refundedMinor > 0 && <span className="text-xs text-slate-500">refunded {fmt(p.refundedMinor, p.currency)}</span>}</li>
          ))}</ul>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">Credit history</h2>
        {ledger.length === 0 ? <p className="text-sm text-slate-500">Nothing yet.</p> : (
          <ul className="divide-y divide-slate-100 text-sm">{ledger.filter((l) => l.deltaUnits !== 0).map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-3 py-2"><span className={"w-24 tabular-nums font-medium " + (l.deltaUnits > 0 ? "text-emerald-700" : "text-slate-900")}>{l.deltaUnits > 0 ? "+" : ""}{credits(l.deltaUnits)}</span><span className="text-slate-700">{KIND[l.kind] ?? l.kind}</span><span className="text-xs text-slate-500">{l.note}</span><span className="ml-auto text-xs text-slate-400">{day(l.createdAt)}</span></li>
          ))}</ul>
        )}
      </section>
    </Card>
  );
}

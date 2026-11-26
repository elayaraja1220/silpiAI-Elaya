"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Check, Clock, FileText, Loader2, Timer, Users } from "lucide-react";

import { BudgetInput } from "@/components/business/budget-input";
import { Card, Field, Input, Section, Select, Textarea, jsonFetch } from "@/components/business/ui";
import { countryOf, currencyOfCountry, flagOf } from "@/lib/business/countries";
import { hourlyTerms } from "@/lib/business/hourly";
import { BENCHMARK_LABELS } from "@/lib/business/market-rates";
import { formatMoney, isForeign, symbolOf, type Money } from "@/lib/business/money";
import { formatINR, quoteMoney } from "@/lib/business/pricing";
import { INDIAN_STATES } from "@/lib/business/rate-card";
import { BILLING_CYCLES, BILLING_CYCLE_LABELS, type BillingCycle, type BillingMode, type Client, type Lead, type RateCard, type Requirement } from "@/lib/business/types";
import { cn } from "@/lib/utils";

const ROLES = ["Senior developer", "Full-stack developer", "Frontend developer", "Backend developer", "UI/UX designer", "Technical consultant", "Project manager"];
const emptyClient: Client = { name: "", email: "", phone: "", company: "", gstin: "", state: "Tamil Nadu", address: "", country: "IN" };

type Reference = { countries: { code: string; name: string; currency: string }[]; roles: { id: string; label: string }[]; levels: { id: string; label: string }[]; benchmark: { hourly: string }; location: { code: string } | null };
type Market =
  | { ok: true; currency: string; kind: keyof typeof BENCHMARK_LABELS; minMinor: number; medianMinor: number; maxMinor: number; billedMinMinor: number; billedMinor: number; billedMaxMinor: number; source: string; effectiveDate: string; ageDays: number; stale: boolean; illustrative: boolean; billsAtCost: boolean; matchedRole: string }
  | { ok: false; message: string };

/** Two ways to bill a project. The fixed-price flow is the existing requirement analysis; hourly is the freelancer / consultant flow below. */
export function BillingModePicker({ mode, onChange }: { mode: BillingMode; onChange: (m: BillingMode) => void }) {
  const options: { id: BillingMode; title: string; detail: string; icon: typeof FileText }[] = [
    { id: "fixed", title: "Fixed price: full project", detail: "Analyse the client's documents, choose pages and features, and quote one price for the whole project.", icon: FileText },
    { id: "hourly", title: "Hourly basis: consultant / freelancer", detail: "Your people work and bill by the hour. Quote a rate, an estimated range and a cap the client approves.", icon: Timer },
  ];
  return (
    <div role="radiogroup" aria-label="How is this project billed?" className="grid gap-3 sm:grid-cols-2" data-testid="billing-mode">
      {options.map((o) => {
        const on = o.id === mode;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.id)}
            className={cn("flex items-start gap-3 rounded-2xl border p-4 text-left transition", on ? "border-violet-400/60 bg-violet-500/[.12] shadow-[0_0_0_1px_rgba(167,139,250,.25)]" : "border-white/[.08] bg-white/[.02] hover:border-white/20 hover:bg-white/[.04]")}
            data-testid={`billing-${o.id}`}
          >
            <span className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", on ? "bg-violet-500 text-white" : "bg-white/[.06] text-slate-400")}><o.icon size={17} /></span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-slate-100">{o.title}</span>
              <span className="mt-1 block text-xs leading-5 text-slate-400">{o.detail}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The official market rate for the chosen country, role and level: the range, what to charge, where it comes from, and every reason to be careful with it. */
function MarketPanel({ market, showPrice, mismatch, moneyCode, country }: { market: Market | null; showPrice: (minor: number) => string; mismatch: boolean; moneyCode: string; country: string }) {
  if (!country) return null;
  if (!market) return <p className="text-xs text-slate-500">Looking up the market rate...</p>;
  if (!market.ok) return <p className="rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-xs text-slate-400">{market.message}</p>;
  return (
    <div className="space-y-1.5 rounded-xl border border-emerald-400/20 bg-emerald-500/[.05] px-3 py-2.5 text-xs" data-testid="market-panel">
      <p className="font-medium text-emerald-100">Market rate · {BENCHMARK_LABELS[market.kind]}{market.matchedRole === "any" ? " (any software role)" : ""}</p>
      <p className="tabular-nums text-slate-200">Range {showPrice(market.billedMinMinor)} to {showPrice(market.billedMaxMinor)} · <b>charge {showPrice(market.billedMinor)}/hour</b></p>
      <p className="text-[11px] text-slate-400">From {market.effectiveDate}. Source: {market.source}</p>
      {market.illustrative && <p className="text-[11px] text-amber-200">This is an illustrative assumption, not a measured market rate.</p>}
      {market.stale && <p className="text-[11px] text-amber-200">This figure is {market.ageDays} days old: check it before relying on it.</p>}
      {market.billsAtCost && <p className="text-[11px] text-amber-200">This price is the benchmark itself with no multiplier, overhead or margin, so it earns nothing above cost. An administrator can set them in Global pricing.</p>}
      {mismatch && <p className="rounded-md border border-rose-400/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">This rate is in {market.currency} but the quotation would be in {moneyCode}. Add {market.currency} under &quot;Prices for clients abroad&quot; in Business &amp; pricing and choose it for this client.</p>}
    </div>
  );
}

/** Hourly engagement: who works, at what rate, for about how many hours, and the cap the client approves. */
export function HourlyEngagementForm({ onCreated, onCancel }: { onCreated: (lead: Lead) => void; onCancel: () => void }) {
  const [rates, setRates] = useState<RateCard | null>(null);
  const [client, setClient] = useState<Client>(emptyClient);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [role, setRole] = useState("Full Stack Developer");
  const [rate, setRate] = useState(0);
  const [hours, setHours] = useState(40);
  const [rangePct, setRangePct] = useState(20);
  const [cycle, setCycle] = useState<BillingCycle>("monthly");
  const [budget, setBudget] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [ref, setRef] = useState<Reference | null>(null);
  const [roleId, setRoleId] = useState("full-stack");
  const [levelId, setLevelId] = useState("mid");
  const [native, setNative] = useState(0); // the hourly price in the quotation's own currency, when that is not rupees
  const [market, setMarket] = useState<Market | null>(null);
  const [priceTouched, setPriceTouched] = useState(false);

  useEffect(() => { jsonFetch<Reference>("/api/business/pricing-reference").then(setRef).catch(() => undefined); }, []);

  useEffect(() => {
    jsonFetch<{ rateCard: RateCard }>("/api/business/rate-card")
      .then((r) => { setRates(r.rateCard); setRate((v) => v || r.rateCard.hourlyRate); })
      .catch((e: Error) => setError(e.message));
  }, []);

  const setC = <K extends keyof Client>(key: K, value: Client[K]) => setClient((c) => ({ ...c, [key]: value }));
  // The country decides the state ("Outside India" for a client abroad) and the currency the quotation is written in.
  const pickCountry = (code: string) => {
    const cur = currencyOfCountry(code);
    setClient((c) => ({ ...c, country: code, state: code === "IN" ? (c.state === "Outside India" ? "Tamil Nadu" : c.state) : "Outside India", currency: code === "IN" ? undefined : cur ?? undefined }));
    setPriceTouched(false);
  };
  const money: Money = rates ? quoteMoney(client, rates, "hourly") : { code: "INR", unit: 1 };
  const foreign = isForeign(money);
  const fmt = (inr: number) => formatMoney(inr, money);
  // The official market rate for this country, role and level (read only).
  useEffect(() => {
    if (!client.country) { setMarket(null); return; }
    let live = true;
    jsonFetch<{ rate: Market; minorDigits?: number }>(`/api/business/market-rate?country=${client.country}&role=${roleId}&level=${levelId}&mode=hourly`)
      .then((r) => { if (live) setMarket(r.rate); })
      .catch(() => { if (live) setMarket(null); });
    return () => { live = false; };
  }, [client.country, roleId, levelId]);
  const digits = market && market.ok ? (market.currency === "JPY" || market.currency === "KRW" ? 0 : ["KWD", "OMR", "BHD"].includes(market.currency) ? 3 : 2) : 2;
  const marketPrice = market && market.ok ? market.billedMinor / 10 ** digits : 0;
  const mismatch = market && market.ok && market.currency !== money.code;
  // Use the market price until the team types their own.
  useEffect(() => {
    if (market && market.ok && !mismatch && !priceTouched) {
      if (foreign) setNative(marketPrice); else setRate(Math.round(marketPrice));
    }
  }, [market, mismatch, priceTouched, foreign, marketPrice]);
  const showPrice = (minor: number) => `${symbolOf(market && market.ok ? market.currency : "INR")}${(minor / 10 ** digits).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

  const effectiveRate = foreign ? Math.max(0, Math.round(native * money.unit)) : rate;
  const terms = useMemo(() => (rates && effectiveRate > 0 && hours > 0 ? hourlyTerms({ role, rate: effectiveRate, estimatedHours: hours, rangePct, cycle, ...(foreign ? { rateNative: native } : {}) }, client, rates) : null), [rates, role, effectiveRate, native, foreign, hours, rangePct, cycle, client]);
  const overBudget = !!terms && budget > 0 && terms.capTotal > budget;

  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      const requirement: Requirement = {
        title: title.trim() || `${client.company.trim() || client.name.trim() || "Client"}: ${role.toLowerCase()} (hourly)`,
        summary,
        scope: "full",
        existingProject: "",
        version: "",
        projectType: "business-website",
        complexity: "standard",
        pages: [],
        modules: [],
        design: "ai",
        references: "",
        domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 },
        hosting: { needed: false, choice: "self", plan: "static", years: 1 },
        deadlineWeeks: 0,
        budget,
        billing: "hourly",
        hourly: { role, rate: effectiveRate, estimatedHours: hours, rangePct, cycle, ...(foreign ? { rateNative: native } : {}), country: client.country, roleId, levelId },
      };
      const { lead } = await jsonFetch<{ lead: Lead }>("/api/business/leads", { method: "POST", body: JSON.stringify({ client, requirement }) });
      onCreated(lead);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!rates) {
    return <Card className="flex items-center gap-3 text-sm text-slate-400">{error ? <span className="text-rose-300">{error}</span> : <><Loader2 size={16} className="animate-spin" /> Loading rate card...</>}</Card>;
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_340px]" data-testid="hourly-form">
      <Card className="min-w-0 space-y-6">
        <Section title="Client" hint="Who is the engagement for. The state decides the GST on the bill.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Client name *"><Input value={client.name} onChange={(e) => setC("name", e.target.value)} /></Field>
            <Field label="Company"><Input value={client.company} onChange={(e) => setC("company", e.target.value)} /></Field>
            <Field label="Email *"><Input type="email" value={client.email} onChange={(e) => setC("email", e.target.value)} /></Field>
            <Field label="Phone *"><Input value={client.phone} onChange={(e) => setC("phone", e.target.value)} /></Field>
            <Field label="Country *" hint={ref?.location && ref.location.code !== client.country ? `This computer seems to be in ${countryOf(ref.location.code)?.name ?? ref.location.code}: that is a guess about YOU, not the client. Choose the client's country.` : "Decides the currency and the market rate."}>
              <Select value={client.country ?? "IN"} onChange={(e) => pickCountry(e.target.value)} aria-label="Country">
                {(ref?.countries ?? [{ code: "IN", name: "India", currency: "INR" }]).map((c) => <option key={c.code} value={c.code}>{flagOf(c.code)} {c.name} ({c.currency})</option>)}
              </Select>
            </Field>
            {client.country === "IN" || !client.country
              ? <Field label="State *"><Select value={client.state} onChange={(e) => setC("state", e.target.value)}>{INDIAN_STATES.filter((s) => s !== "Outside India").map((s) => <option key={s}>{s}</option>)}</Select></Field>
              : <Field label="Tax" hint="No Indian GST on a client abroad (export of services). Local taxes are not added."><Input value="Outside India" readOnly /></Field>}
            <Field label="GSTIN (optional)"><Input value={client.gstin} onChange={(e) => setC("gstin", e.target.value.toUpperCase())} maxLength={15} /></Field>
          </div>
          <Field label="Address (optional)"><Textarea rows={2} value={client.address} onChange={(e) => setC("address", e.target.value)} className="min-h-0" /></Field>
        </Section>

        <Section title="The work" hint="What the person will do. The client sees this on the quotation.">
          <Field label="Engagement title"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Website performance and security review" /></Field>
          <Field label="What will be done *" hint="At least a sentence or two: the goal, the main tasks and anything out of scope.">
            <Textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </Field>
        </Section>

        <Section title="Hours and rate" hint="The estimate is your own. The client is billed for the hours actually worked, never above the cap without approving more.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Developer role">
              <Select value={roleId} onChange={(e) => { setRoleId(e.target.value); setRole(ref?.roles.find((r) => r.id === e.target.value)?.label ?? role); setPriceTouched(false); }} aria-label="Developer role">
                {(ref?.roles ?? []).filter((r) => r.id !== "any").map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </Select>
            </Field>
            <Field label="Experience level">
              <Select value={levelId} onChange={(e) => { setLevelId(e.target.value); setPriceTouched(false); }} aria-label="Experience level">
                {(ref?.levels ?? []).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </Select>
            </Field>
            <div className="sm:col-span-2">
              <MarketPanel market={market} showPrice={showPrice} mismatch={!!mismatch} moneyCode={money.code} country={client.country ?? ""} />
            </div>
            <Field label={foreign ? `Price of one hour (${symbolOf(money.code)}, ${money.code}, before tax)` : "Price of one hour (₹, before GST)"} hint={market && market.ok && !mismatch ? "Starts at the market price. Type a different price if you must: it is recorded as set by hand." : foreign ? "Type the price in the client's currency." : `Your standard rate is ${formatINR(rates.hourlyRate)}.`}>
              {foreign
                ? <Input type="number" min={0.01} step={0.01} value={native || ""} onChange={(e) => { setPriceTouched(true); setNative(Math.max(0, Math.round((Number(e.target.value) || 0) * 100) / 100)); }} />
                : <Input type="number" min={1} value={rate || ""} onChange={(e) => { setPriceTouched(true); setRate(Math.max(0, Math.round(Number(e.target.value) || 0))); }} />}
            </Field>
            <Field label="Estimated hours"><Input type="number" min={1} step={0.5} value={hours || ""} onChange={(e) => setHours(Math.max(0, Number(e.target.value) || 0))} /></Field>
            <Field label="Range around the estimate" hint="The upper end is the cap.">
              <Select value={rangePct} onChange={(e) => setRangePct(Number(e.target.value))}>
                {[0, 10, 20, 30, 50].map((p) => <option key={p} value={p}>{p === 0 ? "Exactly the estimate (no range)" : `± ${p}%`}</option>)}
              </Select>
            </Field>
            <Field label="Bill the client"><Select value={cycle} onChange={(e) => setCycle(e.target.value as BillingCycle)}>{BILLING_CYCLES.map((c) => <option key={c} value={c}>{BILLING_CYCLE_LABELS[c]}</option>)}</Select></Field>
            <div className="sm:col-span-2"><BudgetInput value={budget} onChange={(inr) => setBudget(Math.max(0, Math.round(inr)))} hint="Optional, including GST. It is compared with the cap and never used to change the price." /></div>
          </div>
        </Section>

        {error && <p className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</p>}

        <div className="flex flex-wrap justify-between gap-3 border-t border-white/[.06] pt-4">
          <button type="button" onClick={onCancel} className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-slate-400 transition hover:bg-white/5 hover:text-white"><ArrowLeft size={15} /> Cancel</button>
          <button type="button" onClick={submit} disabled={saving} className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-500 to-indigo-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-500/25 transition hover:brightness-110 disabled:opacity-60" data-testid="hourly-save">
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Save & create quotation
          </button>
        </div>
      </Card>

      <aside className="xl:sticky xl:top-24 xl:self-start">
        <Card className="space-y-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-100"><Clock size={15} className="text-violet-300" /> Hourly estimate</p>
          {terms ? (
            <>
              <div>
                <p className="text-3xl font-semibold tabular-nums text-white">{fmt(terms.expectedTotal)}</p>
                <p className="text-[11px] text-slate-500">estimate{foreign ? "" : " incl. GST"} · {terms.expectedHours} h at {fmt(terms.rate)}/h</p>
              </div>
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between gap-3"><dt className="text-slate-400">Lowest ({terms.minHours} h)</dt><dd className="tabular-nums text-slate-200">{fmt(terms.minTotal)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-slate-400">Cap ({terms.capHours} h)</dt><dd className="font-semibold tabular-nums text-amber-200">{fmt(terms.capTotal)}</dd></div>
                <div className="flex items-center gap-2 border-t border-white/[.07] pt-2 text-slate-400"><Users size={12} /> {role || "Specialist"} · billed {BILLING_CYCLE_LABELS[cycle]}</div>
              </dl>
              {overBudget && (
                <p className="flex gap-2 rounded-lg border border-amber-400/25 bg-amber-500/10 p-3 text-[11px] leading-4 text-amber-100">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" /> The cap ({fmt(terms.capTotal)}) is above the client&apos;s budget of {fmt(budget)}. The price is not reduced for you: agree fewer hours with the client, or tell them the limit.
                </p>
              )}
              <p className="text-[11px] leading-4 text-slate-500">The client approves this estimate and the cap. Hours beyond the cap need their written approval.</p>
            </>
          ) : (
            <p className="text-xs text-slate-500">Enter a rate and the estimated hours to see the estimate.</p>
          )}
        </Card>
      </aside>
    </div>
  );
}

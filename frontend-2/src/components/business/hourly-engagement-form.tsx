"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Check, Clock, FileText, Loader2, Timer, Users } from "lucide-react";

import { BudgetInput } from "@/components/business/budget-input";
import { Card, Field, Input, Section, Select, Textarea, jsonFetch } from "@/components/business/ui";
import { hourlyTerms } from "@/lib/business/hourly";
import { formatINR } from "@/lib/business/pricing";
import { INDIAN_STATES } from "@/lib/business/rate-card";
import { BILLING_CYCLES, BILLING_CYCLE_LABELS, type BillingCycle, type BillingMode, type Client, type Lead, type RateCard, type Requirement } from "@/lib/business/types";
import { cn } from "@/lib/utils";

const ROLES = ["Senior developer", "Full-stack developer", "Frontend developer", "Backend developer", "UI/UX designer", "Technical consultant", "Project manager"];
const emptyClient: Client = { name: "", email: "", phone: "", company: "", gstin: "", state: "Tamil Nadu", address: "" };

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

/** Hourly engagement: who works, at what rate, for about how many hours, and the cap the client approves. */
export function HourlyEngagementForm({ onCreated, onCancel }: { onCreated: (lead: Lead) => void; onCancel: () => void }) {
  const [rates, setRates] = useState<RateCard | null>(null);
  const [client, setClient] = useState<Client>(emptyClient);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [role, setRole] = useState("Senior developer");
  const [rate, setRate] = useState(0);
  const [hours, setHours] = useState(40);
  const [rangePct, setRangePct] = useState(20);
  const [cycle, setCycle] = useState<BillingCycle>("monthly");
  const [budget, setBudget] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    jsonFetch<{ rateCard: RateCard }>("/api/business/rate-card")
      .then((r) => { setRates(r.rateCard); setRate((v) => v || r.rateCard.hourlyRate); })
      .catch((e: Error) => setError(e.message));
  }, []);

  const setC = <K extends keyof Client>(key: K, value: Client[K]) => setClient((c) => ({ ...c, [key]: value }));

  const terms = useMemo(() => (rates && rate > 0 && hours > 0 ? hourlyTerms({ role, rate, estimatedHours: hours, rangePct, cycle }, client, rates) : null), [rates, role, rate, hours, rangePct, cycle, client]);
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
        hourly: { role, rate, estimatedHours: hours, rangePct, cycle },
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
            <Field label="State *"><Select value={client.state} onChange={(e) => setC("state", e.target.value)}>{INDIAN_STATES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
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
            <Field label="Who works">
              <Input list="hourly-roles" value={role} onChange={(e) => setRole(e.target.value)} />
              <datalist id="hourly-roles">{ROLES.map((r) => <option key={r} value={r} />)}</datalist>
            </Field>
            <Field label="Price of one hour (₹, before GST)" hint={`Your standard rate is ${formatINR(rates.hourlyRate)}.`}>
              <Input type="number" min={1} value={rate || ""} onChange={(e) => setRate(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
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
                <p className="text-3xl font-semibold tabular-nums text-white">{formatINR(terms.expectedTotal)}</p>
                <p className="text-[11px] text-slate-500">estimate incl. GST · {terms.expectedHours} h at {formatINR(terms.rate)}/h</p>
              </div>
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between gap-3"><dt className="text-slate-400">Lowest ({terms.minHours} h)</dt><dd className="tabular-nums text-slate-200">{formatINR(terms.minTotal)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-slate-400">Cap ({terms.capHours} h)</dt><dd className="font-semibold tabular-nums text-amber-200">{formatINR(terms.capTotal)}</dd></div>
                <div className="flex items-center gap-2 border-t border-white/[.07] pt-2 text-slate-400"><Users size={12} /> {role || "Specialist"} · billed {BILLING_CYCLE_LABELS[cycle]}</div>
              </dl>
              {overBudget && (
                <p className="flex gap-2 rounded-lg border border-amber-400/25 bg-amber-500/10 p-3 text-[11px] leading-4 text-amber-100">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" /> The cap ({formatINR(terms.capTotal)}) is above the client&apos;s budget of {formatINR(budget)}. The price is not reduced for you: agree fewer hours with the client, or tell them the limit.
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

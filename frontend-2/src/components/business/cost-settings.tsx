"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, CircleDashed, Loader2, Lock, Plus, Save, Trash2, Wallet } from "lucide-react";

import { costConfigReadiness } from "@/lib/business/cost-view";
import {
  INFRA_BASES,
  LINE_KINDS,
  LINE_KIND_LABELS,
  RECURRING_CATEGORIES,
  ROLES,
  ROLE_LABELS,
  type Allocation,
  type CostConfig,
  type CostConfigPatch,
  type InfraRate,
  type RecurringCategory,
  type RunningCostDefault,
} from "@/lib/business/cost-types";
import { DEFAULT_TECH_CATALOG } from "@/lib/business/tech-catalog";
import { cn } from "@/lib/utils";

import { Card, jsonFetch } from "./ui";

const CATEGORY_LABELS: Record<RecurringCategory, string> = {
  "domain-renewal": "Domain renewal",
  "shared-hosting": "Shared hosting",
  vps: "VPS",
  "cloud-hosting": "Cloud hosting",
  "managed-database": "Managed database subscription",
  "paid-api": "Paid API subscription",
  "email-service": "Email service",
  "storage-cdn": "Storage and CDN",
  "payment-gateway": "Payment gateway charges",
  "maintenance-support": "Maintenance and support",
  other: "Other third-party subscription",
};
const BASIS_LABELS = { "per-project": "Per project", "per-dev-hour": "Per development hour", "per-week": "Per week" } as const;
const input = "w-full rounded-lg border border-white/[.08] bg-white/[.03] px-2.5 py-1.5 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-violet-400/60 [&>option]:bg-[#121620]";

type AiRow = { model: string; input: string; output: string; cacheRead: string; cacheWrite: string };
const toNum = (s: string): number | null => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));
const str = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

function Block({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2.5 rounded-xl border border-white/[.06] p-4">
      <div>
        <p className="text-xs font-semibold text-slate-200">{title}</p>
        {hint && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function Num({ value, onChange, placeholder, step, label }: { value: number | null; onChange: (n: number | null) => void; placeholder?: string; step?: number; label: string }) {
  return <input aria-label={label} type="number" min={0} step={step} value={str(value)} placeholder={placeholder ?? "Not set"} onChange={(e) => onChange(toNum(e.target.value))} className={input} />;
}

/**
 * The studio's own costs: internal hourly rates, role allocation, technology effort, AI prices, infrastructure,
 * margin target and running-cost suggestions. Private (never shown to clients). Nothing is pre-filled: an empty
 * field means "not configured" and is reported as missing in the cost screens.
 */
export function CostSettings() {
  const [saved, setSaved] = useState<CostConfig | null>(null);
  const [draft, setDraft] = useState<CostConfig | null>(null);
  const [aiRows, setAiRows] = useState<AiRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback((config: CostConfig) => {
    setSaved(config);
    setDraft(config);
    setAiRows(Object.entries(config.aiPricing).map(([model, p]) => ({ model, input: str(p.inputPerMTok), output: str(p.outputPerMTok), cacheRead: str(p.cacheReadPerMTok), cacheWrite: str(p.cacheWritePerMTok) })));
    setDirty(false);
  }, []);

  useEffect(() => {
    jsonFetch<{ config: CostConfig }>("/api/business/cost-config").then((r) => load(r.config)).catch((e: Error) => setMessage({ ok: false, text: e.message }));
  }, [load]);

  const readiness = useMemo(() => (draft ? costConfigReadiness(draft) : []), [draft]);
  if (!draft || !saved) {
    return <Card className="flex items-center gap-2 text-xs text-slate-400">{message ? <span className="text-rose-300">{message.text}</span> : <><Loader2 size={14} className="animate-spin" /> Loading internal cost settings...</>}</Card>;
  }

  const edit = (fn: (d: CostConfig) => CostConfig) => {
    setDraft((d) => (d ? fn(d) : d));
    setDirty(true);
    setMessage(null);
  };

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const nulls = <T,>(map: Record<string, T>) => Object.fromEntries(Object.keys(map).map((k) => [k, null]));
      const aiPricing = Object.fromEntries(
        aiRows
          .filter((r) => r.model.trim())
          .map((r) => [r.model.trim(), { inputPerMTok: toNum(r.input) ?? NaN, outputPerMTok: toNum(r.output) ?? NaN, ...(toNum(r.cacheRead) !== null ? { cacheReadPerMTok: toNum(r.cacheRead)! } : {}), ...(toNum(r.cacheWrite) !== null ? { cacheWritePerMTok: toNum(r.cacheWrite)! } : {}) }]),
      );
      const patch: CostConfigPatch = {
        roleRates: draft.roleRates,
        allocation: draft.allocation,
        techFactors: { ...nulls(saved.techFactors), ...draft.techFactors },
        uplifts: { scale: { ...nulls(saved.uplifts.scale), ...draft.uplifts.scale }, security: { ...nulls(saved.uplifts.security), ...draft.uplifts.security } },
        usdToInr: draft.usdToInr,
        aiPricing: { ...nulls(saved.aiPricing), ...aiPricing } as CostConfigPatch["aiPricing"],
        infra: draft.infra,
        minMarginPercent: draft.minMarginPercent,
        runningCosts: { ...nulls(saved.runningCosts), ...draft.runningCosts } as CostConfigPatch["runningCosts"],
      };
      const r = await jsonFetch<{ config: CostConfig }>("/api/business/cost-config", { method: "PUT", body: JSON.stringify({ config: patch }) });
      load(r.config);
      setMessage({ ok: true, text: "Saved. The cost screens now use these settings." });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const setAllocation = (kind: (typeof LINE_KINDS)[number], role: (typeof ROLES)[number], value: number | null) =>
    edit((d) => {
      const current: Allocation = { ...(d.allocation[kind] ?? {}) };
      if (value === null) delete current[role];
      else current[role] = value;
      return { ...d, allocation: { ...d.allocation, [kind]: Object.keys(current).length ? current : null } };
    });
  const setRunning = (category: RecurringCategory, patch: Partial<RunningCostDefault> | null) =>
    edit((d) => {
      const next = { ...d.runningCosts };
      if (patch === null) delete next[category];
      else next[category] = { ...(next[category] as RunningCostDefault), ...patch };
      return { ...d, runningCosts: next };
    });
  const setInfra = (items: InfraRate[] | null) => edit((d) => ({ ...d, infra: items }));

  return (
    <Card className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-100"><Wallet size={16} className="text-amber-300" /> Internal costs and profit settings</p>
          <p className="mt-1 max-w-2xl text-[11px] text-slate-500">
            The studio&apos;s own costs. <span className="inline-flex items-center gap-1 text-slate-400"><Lock size={10} /> Private: never shown to clients.</span> Nothing is pre-filled. An empty field means &quot;not configured&quot;, and the cost screens say so instead of showing zero.
          </p>
        </div>
        <button type="button" onClick={save} disabled={busy || !dirty} className="flex items-center gap-1.5 rounded-lg bg-violet-500 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-400 disabled:opacity-40">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save internal costs
        </button>
      </div>
      {message && <p className={cn("rounded-lg border px-3 py-2 text-xs", message.ok ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200" : "border-rose-400/30 bg-rose-500/10 text-rose-200")}>{message.ok && <Check size={12} className="mr-1 inline" />}{message.text}</p>}

      <ul className="grid gap-1.5 text-[11px] sm:grid-cols-2 xl:grid-cols-3" data-testid="cost-readiness">
        {readiness.map((r) => (
          <li key={r.key} className="flex items-start gap-2 rounded-md bg-white/[.03] px-2.5 py-1.5">
            {r.state === "done" ? <Check size={13} className="mt-0.5 shrink-0 text-emerald-300" /> : <CircleDashed size={13} className={cn("mt-0.5 shrink-0", r.state === "missing" ? "text-amber-300" : "text-slate-600")} />}
            <span><span className="text-slate-200">{r.label}</span><span className="block text-slate-500">{r.detail}</span></span>
          </li>
        ))}
      </ul>

      <div className="grid gap-4 lg:grid-cols-2">
        <Block title="Internal hourly rates" hint="What an hour of each kind of work costs the studio. This is not the client billing rate.">
          <div className="grid grid-cols-2 gap-2">
            {ROLES.map((role) => (
              <label key={role} className="space-y-1 text-[11px] text-slate-400">
                {ROLE_LABELS[role]}
                <Num label={`${ROLE_LABELS[role]} hourly cost`} value={draft.roleRates[role]} onChange={(n) => edit((d) => ({ ...d, roleRates: { ...d.roleRates, [role]: n } }))} placeholder="₹ per hour" />
              </label>
            ))}
          </div>
        </Block>

        <Block title="Rates and targets">
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-[11px] text-slate-400">USD to INR rate<Num label="USD to INR rate" step={0.01} value={draft.usdToInr} onChange={(n) => edit((d) => ({ ...d, usdToInr: n }))} placeholder="₹ per US$" /></label>
            <label className="space-y-1 text-[11px] text-slate-400">Minimum gross margin<Num label="Minimum gross margin" value={draft.minMarginPercent} onChange={(n) => edit((d) => ({ ...d, minMarginPercent: n }))} placeholder="% of revenue" /></label>
            <label className="space-y-1 text-[11px] text-slate-400">Extra effort, medium scale<Num label="Uplift medium scale" value={draft.uplifts.scale.medium ?? null} onChange={(n) => edit((d) => ({ ...d, uplifts: { ...d.uplifts, scale: omit(d.uplifts.scale, "medium", n) } }))} placeholder="% (optional)" /></label>
            <label className="space-y-1 text-[11px] text-slate-400">Extra effort, large scale<Num label="Uplift large scale" value={draft.uplifts.scale.large ?? null} onChange={(n) => edit((d) => ({ ...d, uplifts: { ...d.uplifts, scale: omit(d.uplifts.scale, "large", n) } }))} placeholder="% (optional)" /></label>
            <label className="space-y-1 text-[11px] text-slate-400">Extra effort, elevated security<Num label="Uplift elevated security" value={draft.uplifts.security.elevated ?? null} onChange={(n) => edit((d) => ({ ...d, uplifts: { ...d.uplifts, security: omit(d.uplifts.security, "elevated", n) } }))} placeholder="% (optional)" /></label>
            <label className="space-y-1 text-[11px] text-slate-400">Extra effort, high security<Num label="Uplift high security" value={draft.uplifts.security.high ?? null} onChange={(n) => edit((d) => ({ ...d, uplifts: { ...d.uplifts, security: omit(d.uplifts.security, "high", n) } }))} placeholder="% (optional)" /></label>
          </div>
        </Block>
      </div>

      <Block title="Role allocation" hint="How the hours of each kind of quoted work are shared between roles, in percent of that work's hours. The total may exceed 100 when extra effort is needed. Leave a row empty if you do not use it.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
                <th className="py-1 pr-2 font-medium">Kind of work</th>
                {ROLES.map((r) => <th key={r} className="py-1 pr-2 font-medium">{ROLE_LABELS[r].split(" ")[0]}</th>)}
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {LINE_KINDS.map((kind) => (
                <tr key={kind} className="border-t border-white/[.05]">
                  <td className="py-1.5 pr-2 text-slate-300">{LINE_KIND_LABELS[kind]}</td>
                  {ROLES.map((role) => (
                    <td key={role} className="py-1 pr-2"><Num label={`${LINE_KIND_LABELS[kind]} to ${ROLE_LABELS[role]}`} value={draft.allocation[kind]?.[role] ?? null} onChange={(n) => setAllocation(kind, role, n)} placeholder="%" /></td>
                  ))}
                  <td className="py-1"><button type="button" aria-label={`Clear ${LINE_KIND_LABELS[kind]}`} onClick={() => edit((d) => ({ ...d, allocation: { ...d.allocation, [kind]: null } }))} className="text-slate-600 hover:text-rose-300"><Trash2 size={12} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Block>

      <Block title="Technology effort factors" hint="Internal effort of each technology compared with your usual (1 = the same), on top of the hours already quoted. Leave empty where you have no factor.">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
          {DEFAULT_TECH_CATALOG.map((t) => (
            <label key={t.id} className="space-y-1 text-[11px] text-slate-400">
              {t.label}
              <Num label={`${t.label} effort factor`} step={0.05} value={draft.techFactors[t.id] ?? null} onChange={(n) => edit((d) => ({ ...d, techFactors: omit(d.techFactors, t.id, n) }))} placeholder="factor" />
            </label>
          ))}
        </div>
      </Block>

      <div className="grid gap-4 lg:grid-cols-2">
        <Block title="AI model pricing" hint="What your AI provider charges, in US dollars per million tokens. Enter the prices from your provider's price list.">
          <div className="space-y-2">
            {aiRows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1.4fr_1fr_1fr_auto] items-end gap-1.5">
                <label className="space-y-1 text-[10px] text-slate-500">Model<input aria-label="AI model name" value={r.model} onChange={(e) => { setAiRows(aiRows.map((x, j) => (j === i ? { ...x, model: e.target.value } : x))); setDirty(true); }} placeholder="model name" className={input} /></label>
                <label className="space-y-1 text-[10px] text-slate-500">Input $/M<input aria-label="AI input price" type="number" min={0} step={0.01} value={r.input} onChange={(e) => { setAiRows(aiRows.map((x, j) => (j === i ? { ...x, input: e.target.value } : x))); setDirty(true); }} className={input} /></label>
                <label className="space-y-1 text-[10px] text-slate-500">Output $/M<input aria-label="AI output price" type="number" min={0} step={0.01} value={r.output} onChange={(e) => { setAiRows(aiRows.map((x, j) => (j === i ? { ...x, output: e.target.value } : x))); setDirty(true); }} className={input} /></label>
                <button type="button" aria-label="Remove model" onClick={() => { setAiRows(aiRows.filter((_, j) => j !== i)); setDirty(true); }} className="pb-2 text-slate-600 hover:text-rose-300"><Trash2 size={13} /></button>
              </div>
            ))}
            <button type="button" onClick={() => { setAiRows([...aiRows, { model: "", input: "", output: "", cacheRead: "", cacheWrite: "" }]); setDirty(true); }} className="flex items-center gap-1 text-[11px] text-violet-300 hover:text-white"><Plus size={12} /> Add a model</button>
          </div>
        </Block>

        <Block title="Infrastructure" hint="Studio-side resources such as a development server, build and test runner or storage.">
          {draft.infra === null ? (
            <div className="flex flex-wrap gap-2 text-[11px]">
              <span className="w-full text-amber-200/90">Not configured yet.</span>
              <button type="button" onClick={() => setInfra([{ key: "item-1", name: "", basis: "per-project", amount: null }])} className="rounded-md border border-white/10 px-2 py-1 text-slate-200 hover:bg-white/5">Add an item</button>
              <button type="button" onClick={() => setInfra([])} className="rounded-md border border-white/10 px-2 py-1 text-slate-200 hover:bg-white/5">I have no internal infrastructure costs</button>
            </div>
          ) : (
            <div className="space-y-2">
              {draft.infra.length === 0 && <p className="text-[11px] text-slate-500">Set to none: no infrastructure cost is counted.</p>}
              {draft.infra.map((item, i) => (
                <div key={item.key} className="grid grid-cols-[1.3fr_1.2fr_1fr_auto] items-end gap-1.5">
                  <label className="space-y-1 text-[10px] text-slate-500">Name<input aria-label="Infrastructure name" value={item.name} onChange={(e) => setInfra(draft.infra!.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="e.g. development server" className={input} /></label>
                  <label className="space-y-1 text-[10px] text-slate-500">Charged<select aria-label="Infrastructure basis" value={item.basis} onChange={(e) => setInfra(draft.infra!.map((x, j) => (j === i ? { ...x, basis: e.target.value as InfraRate["basis"] } : x)))} className={input}>{INFRA_BASES.map((b) => <option key={b} value={b}>{BASIS_LABELS[b]}</option>)}</select></label>
                  <label className="space-y-1 text-[10px] text-slate-500">Amount (₹)<Num label="Infrastructure amount" value={item.amount} onChange={(n) => setInfra(draft.infra!.map((x, j) => (j === i ? { ...x, amount: n } : x)))} /></label>
                  <button type="button" aria-label="Remove infrastructure item" onClick={() => setInfra(draft.infra!.filter((_, j) => j !== i))} className="pb-2 text-slate-600 hover:text-rose-300"><Trash2 size={13} /></button>
                </div>
              ))}
              <button type="button" onClick={() => setInfra([...draft.infra!, { key: `item-${draft.infra!.length + 1}-${Date.now() % 100000}`, name: "", basis: "per-project", amount: null }])} className="flex items-center gap-1 text-[11px] text-violet-300 hover:text-white"><Plus size={12} /> Add an item</button>
            </div>
          )}
        </Block>
      </div>

      <Block title="Running cost suggestions" hint="Your reference for the costs a client pays separately (hosting, domain, subscriptions). They are suggested on each quotation but never added to its total. Leave the amount empty if you do not know it: it then shows as unknown.">
        <div className="space-y-2">
          {RECURRING_CATEGORIES.filter((c) => draft.runningCosts[c]).map((category) => {
            const r = draft.runningCosts[category]!;
            return (
              <div key={category} className="grid grid-cols-2 items-end gap-1.5 rounded-lg border border-white/[.05] p-2 sm:grid-cols-4 xl:grid-cols-8">
                <p className="col-span-2 text-[11px] font-medium text-slate-200 xl:col-span-1">{CATEGORY_LABELS[category]}</p>
                <label className="space-y-1 text-[10px] text-slate-500">Provider<input aria-label={`${CATEGORY_LABELS[category]} provider`} value={r.provider ?? ""} onChange={(e) => setRunning(category, { provider: e.target.value })} placeholder="optional" className={input} /></label>
                <label className="space-y-1 text-[10px] text-slate-500">{r.amountType === "percent-of-transaction" ? "Percent of sales" : "Amount (₹)"}<Num label={`${CATEGORY_LABELS[category]} amount`} value={r.amount} onChange={(n) => setRunning(category, { amount: n })} placeholder="Unknown" /></label>
                <label className="space-y-1 text-[10px] text-slate-500">Billing<select aria-label={`${CATEGORY_LABELS[category]} billing`} value={r.kind === "one-time" ? "one-time" : r.frequency ?? ""} onChange={(e) => (e.target.value === "one-time" ? setRunning(category, { kind: "one-time", frequency: undefined }) : setRunning(category, { kind: "recurring", frequency: (e.target.value || undefined) as RunningCostDefault["frequency"] }))} className={input}><option value="">Not set</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option><option value="one-time">One-time</option></select></label>
                <label className="space-y-1 text-[10px] text-slate-500">Need<select aria-label={`${CATEGORY_LABELS[category]} need`} value={r.necessity} onChange={(e) => setRunning(category, { necessity: e.target.value as RunningCostDefault["necessity"] })} className={input}><option value="mandatory">Mandatory</option><option value="optional">Optional</option></select></label>
                <label className="space-y-1 text-[10px] text-slate-500">Paid by<select aria-label={`${CATEGORY_LABELS[category]} payer`} value={r.payer} onChange={(e) => setRunning(category, { payer: e.target.value as RunningCostDefault["payer"] })} className={input}><option value="client">Client</option><option value="studio">Studio</option></select></label>
                <label className="space-y-1 text-[10px] text-slate-500">Status<select aria-label={`${CATEGORY_LABELS[category]} status`} value={r.status} onChange={(e) => setRunning(category, { status: e.target.value as RunningCostDefault["status"] })} className={input}><option value="estimated">Estimated</option><option value="actual">Actual</option></select></label>
                <button type="button" aria-label={`Remove ${CATEGORY_LABELS[category]}`} onClick={() => setRunning(category, null)} className="pb-2 text-left text-slate-600 hover:text-rose-300"><Trash2 size={13} /></button>
              </div>
            );
          })}
          <div className="flex flex-wrap gap-1.5">
            {RECURRING_CATEGORIES.filter((c) => !draft.runningCosts[c]).map((category) => (
              <button
                key={category}
                type="button"
                onClick={() => setRunning(category, { kind: "recurring", amount: null, necessity: category === "domain-renewal" || category.endsWith("hosting") || category === "vps" ? "mandatory" : "optional", payer: "client", status: "estimated", ...(category === "payment-gateway" ? { amountType: "percent-of-transaction" as const } : {}) })}
                className="flex items-center gap-1 rounded-md border border-dashed border-white/[.12] px-2 py-1 text-[11px] text-slate-400 hover:text-white"
              >
                <Plus size={11} /> {CATEGORY_LABELS[category]}
              </button>
            ))}
          </div>
        </div>
      </Block>
    </Card>
  );
}

/** A copy of a map with one key set, or removed when the value is empty. */
function omit<T extends Record<string, number | undefined>>(map: T, key: string, value: number | null): T {
  const next: Record<string, number | undefined> = { ...map };
  if (value === null) delete next[key];
  else next[key] = value;
  return next as T;
}

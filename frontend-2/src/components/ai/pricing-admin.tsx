"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { flagOf, minorDigits } from "@/lib/business/countries";
import { BENCHMARK_KINDS, BENCHMARK_LABELS, type BenchmarkKind, type MarketRate, type PricingConfig } from "@/lib/business/market-rates";
import { api, Button, Card, inputClass, Notice, Pill } from "./light";

type Ref = {
  countries: { code: string; name: string; currency: string; active: boolean }[];
  roles: { id: string; label: string; active: boolean }[];
  levels: { id: string; label: string; active: boolean }[];
};

const todayIso = () => new Date().toISOString().slice(0, 10);
const money = (minor: number, currency: string) => (minor / 10 ** minorDigits(currency)).toLocaleString("en-US", { minimumFractionDigits: minorDigits(currency), maximumFractionDigits: minorDigits(currency) });
const sel = "rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500";

/** Global pricing: which benchmark powers each quotation mode, the multipliers, every market rate with its source, and the lists. */
export function PricingAdmin({ onNote, onError, readOnly = false }: { onNote: (m: string) => void; onError: (e: unknown) => void; readOnly?: boolean }) {
  const [reason, setReason] = useState("");
  const [rev, setRev] = useState(0);
  const [data, setData] = useState<{ reference: Ref; config: PricingConfig; rates: MarketRate[] } | null>(null);
  const [country, setCountry] = useState("");
  const load = useCallback(() => { api<{ reference: Ref; config: PricingConfig; rates: MarketRate[] }>(`/api/admin/pricing${country ? `?country=${country}` : ""}`).then(setData).catch(onError); }, [country, onError]);
  useEffect(load, [load]);
  if (!data) return <Card className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Loading...</Card>;
  const done = (m: string) => { onNote(m); setRev((n) => n + 1); load(); };
  const why = reason.trim().length >= 5 ? reason.trim() : "";
  return (
    <div className="space-y-5">
      {readOnly && <Notice tone="amber">You are signed in as a viewer: you can look at everything and download the rates, but not change anything.</Notice>}
      <Card className="space-y-2">
        <label className="block text-xs font-medium text-slate-700">Why are you making the next change? <span className="font-normal text-slate-500">(required for settings and switches; kept in the history with your name)</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: new ONS survey published" className={inputClass + " mt-1 block"} aria-label="Reason for the change" disabled={readOnly} />
        </label>
        <p className="text-[11px] text-slate-500">Tax rules and exchange rates are in the &quot;Tax &amp; currency&quot; tab. Prices for clients abroad are in Business &amp; pricing.</p>
      </Card>
      <fieldset disabled={readOnly} className="space-y-5 border-0 p-0 disabled:opacity-60">
      <Notice tone="amber">No market rate is built in. Every figure below was entered by a person with its source. Where a country, role and level has no figure, quotations fall back to a price typed by hand. India&apos;s three starting wages are an illustrative assumption, not a market rate.</Notice>
      <Settings config={data.config} onDone={done} onError={onError} reason={why} />
      <Rates data={data} country={country} setCountry={setCountry} onDone={done} onError={onError} reason={why} />
      <AddRate reference={data.reference} onDone={done} onError={onError} />
      <Import onDone={done} onError={onError} />
      <Lists reference={data.reference} onDone={done} onError={onError} reason={why} />
      </fieldset>
      <History rev={rev} onError={onError} />
    </div>
  );
}

function Settings({ config, onDone, onError, reason }: { config: PricingConfig; onDone: (m: string) => void; onError: (e: unknown) => void; reason: string }) {
  const [c, setC] = useState(config);
  useEffect(() => setC(config), [config]);
  const pct = (bp: number) => String(bp / 100);
  const toBp = (text: string) => Math.round(Number(text) * 100);
  const setBilling = (k: BenchmarkKind, patch: Partial<PricingConfig["billing"][BenchmarkKind]>) => setC({ ...c, billing: { ...c.billing, [k]: { ...c.billing[k], ...patch } } });
  const atCost = (["hourly", "fixed"] as const).filter((m) => c.benchmark[m] === "employee" && c.billing.employee.multiplierBp === 10_000 && c.billing.employee.marginBp === 0 && c.billing.employee.overheadBp === 0);
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Which benchmark powers each quotation, and how it becomes a price</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">An <b>employee wage</b> is what a company pays a person: a cost, not a price. A <b>freelancer</b> or <b>agency</b> rate is what is charged. Choose the benchmark for each mode, then set a multiplier, overhead and margin for each kind (1.00 and 0% change nothing). Price = benchmark × multiplier × (1 + overhead) × (1 + margin).</p>
      </div>
      <div className="flex flex-wrap gap-4">
        {(["hourly", "fixed"] as const).map((m) => (
          <label key={m} className="text-xs text-slate-600">{m === "hourly" ? "Hourly quotations use" : "Fixed-price quotations use"}
            <select value={c.benchmark[m]} onChange={(e) => setC({ ...c, benchmark: { ...c.benchmark, [m]: e.target.value as BenchmarkKind } })} className={sel + " mt-1 block"} aria-label={`${m} benchmark`}>{BENCHMARK_KINDS.map((k) => <option key={k} value={k}>{BENCHMARK_LABELS[k]}</option>)}</select>
          </label>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {BENCHMARK_KINDS.map((k) => (
          <div key={k} className="space-y-2 rounded-xl border border-slate-200 p-3">
            <p className="text-xs font-semibold text-slate-800">{BENCHMARK_LABELS[k]}</p>
            <label className="block text-xs text-slate-600">Multiplier (x)<input value={String(c.billing[k].multiplierBp / 10_000)} onChange={(e) => setBilling(k, { multiplierBp: Math.round(Number(e.target.value.replace(/[^\d.]/g, "")) * 10_000) })} className={inputClass + " mt-1 block !w-28"} aria-label={`${k} multiplier`} /></label>
            <label className="block text-xs text-slate-600">Overhead (%)<input value={pct(c.billing[k].overheadBp)} onChange={(e) => setBilling(k, { overheadBp: toBp(e.target.value.replace(/[^\d.]/g, "")) })} className={inputClass + " mt-1 block !w-28"} aria-label={`${k} overhead`} /></label>
            <label className="block text-xs text-slate-600">Margin (%)<input value={pct(c.billing[k].marginBp)} onChange={(e) => setBilling(k, { marginBp: toBp(e.target.value.replace(/[^\d.]/g, "")) })} className={inputClass + " mt-1 block !w-28"} aria-label={`${k} margin`} /></label>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="text-xs text-slate-600">Risk allowance on fixed prices (%)<input value={pct(c.riskAllowanceBp)} onChange={(e) => setC({ ...c, riskAllowanceBp: toBp(e.target.value.replace(/[^\d.]/g, "")) })} className={inputClass + " mt-1 block !w-28"} aria-label="Risk allowance" /></label>
        <label className="text-xs text-slate-600">A rate is out of date after (days)<input value={String(c.staleAfterDays)} onChange={(e) => setC({ ...c, staleAfterDays: Number(e.target.value.replace(/\D/g, "")) })} className={inputClass + " mt-1 block !w-28"} aria-label="Days before a rate is out of date" /></label>
        <label className="text-xs text-slate-600">Paid hours in a year<input value={String(c.hoursPerYear)} onChange={(e) => setC({ ...c, hoursPerYear: Number(e.target.value.replace(/\D/g, "")) })} className={inputClass + " mt-1 block !w-28"} aria-label="Paid hours per year" /></label>
      </div>
      {atCost.length > 0 && <Notice tone="red">The employee wage is selected for {atCost.join(" and ")} quotations with a multiplier of 1.00 and no overhead or margin: clients would be charged what the wage costs you, and you would earn nothing above it.</Notice>}
      <Button disabled={!reason} onClick={() => api("/api/admin/pricing/config", { method: "PUT", body: { ...c, reason } }).then(() => onDone("Pricing settings saved.")).catch(onError)}>Save settings</Button>
      {!reason && <p className="text-[11px] text-slate-500">Write the reason at the top of this tab to save.</p>}
    </Card>
  );
}

function Rates({ data, country, setCountry, onDone, onError, reason }: { data: { reference: Ref; config: PricingConfig; rates: MarketRate[] }; country: string; setCountry: (c: string) => void; onDone: (m: string) => void; onError: (e: unknown) => void; reason: string }) {
  const roles = useMemo(() => new Map(data.reference.roles.map((r) => [r.id, r.label])), [data]);
  const levels = useMemo(() => new Map(data.reference.levels.map((l) => [l.id, l.label])), [data]);
  const now = todayIso();
  const age = (d: string) => Math.floor((Date.parse(now) - Date.parse(d)) / 86_400_000);
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Market rates, with their sources</h2>
          <p className="mt-1 text-xs leading-5 text-slate-600">Newest first. A figure is never edited: add a new one with a later start date and the old one stays here as history. Amounts are per hour, in the country&apos;s currency.</p>
        </div>
        <a href={"/api/admin/pricing/rates/export" + (country ? "?country=" + country : "")} className="text-xs text-indigo-700 underline" download>Download as a spreadsheet (CSV)</a>
        <label className="text-xs text-slate-600">Country<select value={country} onChange={(e) => setCountry(e.target.value)} className={sel + " mt-1 block"} aria-label="Filter by country"><option value="">All</option>{data.reference.countries.map((c) => <option key={c.code} value={c.code}>{flagOf(c.code)} {c.name}</option>)}</select></label>
      </div>
      {data.rates.length === 0 ? <p className="text-sm text-slate-500">No rates yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="border-b border-slate-200 text-left text-slate-500"><th className="py-2 pr-3 font-medium">Country</th><th className="py-2 pr-3 font-medium">Role · level</th><th className="py-2 pr-3 font-medium">Kind</th><th className="py-2 pr-3 text-right font-medium">Min / median / max</th><th className="py-2 pr-3 font-medium">From</th><th className="py-2 pr-3 font-medium">Source</th><th className="py-2 font-medium"></th></tr></thead>
            <tbody>
              {data.rates.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 align-top last:border-0">
                  <td className="py-2 pr-3">{flagOf(r.country)} {r.country}</td>
                  <td className="py-2 pr-3">{roles.get(r.roleId) ?? r.roleId} · {levels.get(r.levelId) ?? r.levelId}</td>
                  <td className="py-2 pr-3">{r.kind}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{r.currency} {money(r.minMinor, r.currency)} / <b>{money(r.medianMinor, r.currency)}</b> / {money(r.maxMinor, r.currency)}</td>
                  <td className="py-2 pr-3 tabular-nums">{r.effectiveDate}{age(r.effectiveDate) > data.config.staleAfterDays && <span className="ml-1"><Pill tone="amber">out of date</Pill></span>}</td>
                  <td className="max-w-xs py-2 pr-3 text-slate-600">{r.source}{r.sourceUrl && <> · <a href={r.sourceUrl} target="_blank" rel="noreferrer noopener" className="text-indigo-700 underline">link</a></>}{r.illustrative && <span className="ml-1"><Pill tone="amber">illustrative</Pill></span>}<span className="block text-[10px] text-slate-400">entered by {r.enteredBy || "?"}</span></td>
                  <td className="py-2"><Button variant="ghost" className="px-2 py-1 text-[11px]" disabled={!reason} onClick={() => api("/api/admin/pricing/rates", { method: "PUT", body: { id: r.id, enabled: !r.enabled, reason } }).then(() => onDone(r.enabled ? "Rate switched off." : "Rate switched on.")).catch(onError)}>{r.enabled ? "Switch off" : "Switch on"}</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function AddRate({ reference, onDone, onError }: { reference: Ref; onDone: (m: string) => void; onError: (e: unknown) => void }) {
  const [f, setF] = useState({ country: "US", roleId: "any", levelId: "mid", kind: "freelancer" as BenchmarkKind, min: "", median: "", max: "", source: "", sourceUrl: "", effectiveDate: todayIso(), note: "" });
  const currency = reference.countries.find((c) => c.code === f.country)?.currency ?? "";
  const digits = minorDigits(currency || "USD");
  const toMinor = (text: string): number | null => { const m = new RegExp(`^(\\d{1,9})(?:\\.(\\d{1,${Math.max(digits, 1)}}))?$`).exec(text.trim()); return !m || (digits === 0 && m[2]) ? null : Number(m[1]) * 10 ** digits + Number((m[2] ?? "").padEnd(digits, "0") || 0); };
  const ready = toMinor(f.min) !== null && toMinor(f.median) !== null && toMinor(f.max) !== null && f.source.trim().length >= 8;
  const add = () => api("/api/admin/pricing/rates", { method: "POST", body: { ...f, min: toMinor(f.min), median: toMinor(f.median), max: toMinor(f.max) } }).then(() => { setF({ ...f, min: "", median: "", max: "", source: "", sourceUrl: "", note: "" }); onDone("Rate added."); }).catch(onError);
  const field = (label: string, key: keyof typeof f, width = "!w-28", ph = "") => <label className="text-xs text-slate-600">{label}<input value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} placeholder={ph} className={inputClass + ` mt-1 block ${width}`} aria-label={label} /></label>;
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Add a market rate</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">Enter the hourly figures in the main unit of {currency || "the currency"} (for example 45.50), from a source you can name: the survey or statistics table and its year. A source and a start date are required. The rate applies in the country&apos;s own currency.</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">Country<select value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })} className={sel + " mt-1 block"} aria-label="Country">{reference.countries.map((c) => <option key={c.code} value={c.code}>{flagOf(c.code)} {c.name} ({c.currency})</option>)}</select></label>
        <label className="text-xs text-slate-600">Role<select value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })} className={sel + " mt-1 block"} aria-label="Role">{reference.roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
        <label className="text-xs text-slate-600">Level<select value={f.levelId} onChange={(e) => setF({ ...f, levelId: e.target.value })} className={sel + " mt-1 block"} aria-label="Level">{reference.levels.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select></label>
        <label className="text-xs text-slate-600">Kind<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as BenchmarkKind })} className={sel + " mt-1 block"} aria-label="Kind">{BENCHMARK_KINDS.map((k) => <option key={k} value={k}>{BENCHMARK_LABELS[k]}</option>)}</select></label>
        {field("Minimum", "min")}{field("Median", "median")}{field("Maximum", "max")}
        {field("Applies from", "effectiveDate", "!w-36", "2026-01-01")}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {field("Source (required)", "source", "!w-96", "Office for National Statistics, ASHE 2025, table 14")}
        {field("Link (optional)", "sourceUrl", "!w-64", "https://...")}
        <Button onClick={() => void add()} disabled={!ready}>Add rate</Button>
      </div>
    </Card>
  );
}

function Import({ onDone, onError }: { onDone: (m: string) => void; onError: (e: unknown) => void }) {
  const [csv, setCsv] = useState("");
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Load many rates from a spreadsheet</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">Paste CSV with this header, amounts in the main unit of each country&apos;s currency. All rows are checked first: if any is wrong, none is added and the line is named.</p>
        <p className="mt-1 font-mono text-[11px] text-slate-500">country,role,level,kind,min,median,max,source,source_url,effective_date</p>
      </div>
      <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={5} className={inputClass + " font-mono text-xs"} aria-label="CSV of market rates" />
      <Button onClick={() => api<{ added: number }>("/api/admin/pricing/rates/import", { method: "POST", body: { csv } }).then((r) => { setCsv(""); onDone(`${r.added} rate${r.added === 1 ? "" : "s"} added.`); }).catch(onError)} disabled={csv.trim().length < 20}>Load the rates</Button>
    </Card>
  );
}

function Lists({ reference, onDone, onError, reason }: { reference: Ref; onDone: (m: string) => void; onError: (e: unknown) => void; reason: string }) {
  const [role, setRole] = useState({ id: "", label: "" });
  const flip = (kind: string, id: string, active: boolean) => api("/api/admin/pricing/reference", { method: "PUT", body: { kind, id, active, reason } }).then(() => onDone(active ? "Switched on." : "Switched off for new quotations.")).catch(onError);
  const chip = (kind: string, id: string, label: string, active: boolean) => (
    <button key={id} type="button" disabled={!reason} onClick={() => void flip(kind, id, !active)} aria-pressed={active} title={active ? "Click to switch off for new quotations" : "Click to switch on"} className={"rounded-full border px-2.5 py-1 text-[11px] " + (active ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-400 line-through")}>{label}</button>
  );
  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-semibold text-slate-900">Countries, roles and levels</h2>
      <p className="text-xs leading-5 text-slate-600">Click one to switch it off for new quotations (nothing is deleted and rates already entered stay).</p>
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">{reference.countries.map((c) => chip("country", c.code, `${flagOf(c.code)} ${c.name} · ${c.currency}`, c.active))}</div>
        <div className="flex flex-wrap gap-1.5">{reference.roles.filter((r) => r.id !== "any").map((r) => chip("role", r.id, r.label, r.active))}</div>
        <div className="flex flex-wrap gap-1.5">{reference.levels.map((l) => chip("level", l.id, l.label, l.active))}</div>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">New role id<input value={role.id} onChange={(e) => setRole({ ...role, id: e.target.value.toLowerCase() })} placeholder="data-engineer" className={inputClass + " mt-1 block !w-40"} aria-label="New role id" /></label>
        <label className="text-xs text-slate-600">Name<input value={role.label} onChange={(e) => setRole({ ...role, label: e.target.value })} placeholder="Data Engineer" className={inputClass + " mt-1 block !w-48"} aria-label="New role name" /></label>
        <Button variant="ghost" disabled={role.id.length < 2 || role.label.length < 2} onClick={() => api("/api/admin/pricing/reference", { method: "POST", body: role }).then(() => { setRole({ id: "", label: "" }); onDone("Role added."); }).catch(onError)}>Add role</Button>
      </div>
    </Card>
  );
}

type Entry = { id: number; at: string; actor: string; action: string; entity: string; reason: string };
const ACTIONS: Record<string, string> = { "pricing.rate_added": "Rate added", "pricing.rates_imported": "Rates loaded from CSV", "pricing.rate_switched": "Rate switched", "pricing.config_changed": "Settings changed", "pricing.reference_switched": "List item switched", "pricing.role_added": "Role added" };

/** Who changed what in the pricing, when and why (read only, newest first). */
function History({ rev, onError }: { rev: number; onError: (e: unknown) => void }) {
  const [rows, setRows] = useState<Entry[] | null>(null);
  useEffect(() => { api<{ history: Entry[] }>("/api/admin/pricing/history?limit=50").then((r) => setRows(r.history)).catch(onError); }, [rev, onError]);
  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-semibold text-slate-900">Who changed what</h2>
      {!rows ? <p className="text-sm text-slate-500">Loading...</p> : rows.length === 0 ? <p className="text-sm text-slate-500">No pricing change has been made yet.</p> : (
        <ol className="space-y-1.5 text-xs" data-testid="pricing-history">
          {rows.map((h) => (
            <li key={h.id} className="rounded-lg border border-slate-100 px-3 py-1.5">
              <span className="font-medium text-slate-800">{ACTIONS[h.action] ?? h.action}</span> <span className="text-slate-500">{h.entity}</span>
              <span className="block text-slate-500">{new Date(h.at).toLocaleString("en-IN")} · {h.actor}{h.reason && <> · &quot;{h.reason}&quot;</>}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

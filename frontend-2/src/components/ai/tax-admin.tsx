"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { CURRENCY_CODES, CURRENCY_INFO } from "@/lib/currencies";
import { api, ApiError, Button, Card, inputClass, Notice, Pill } from "./light";

type Rate = { currency: string; perUsdMicro: number; source: string; setAt: string };
type Rule = { id: number; country: string; currency: string | null; label: string; rateBasisPoints: number; active: boolean; note: string };
type Seller = { legalName: string; address: string; country: string; taxId: string; taxIdType: string; email: string };

const NON_USD = CURRENCY_CODES.filter((c) => c !== "USD");
const trimRate = (micro: number) => String(micro / 1_000_000);

/** Exchange rates (for reports only), tax rules, and who invoices come from. */
export function TaxAdmin({ onNote, onError }: { onNote: (m: string) => void; onError: (e: unknown) => void }) {
  return (
    <div className="space-y-5">
      <Rates onNote={onNote} onError={onError} />
      <Rules onNote={onNote} onError={onError} />
      <SellerCard onNote={onNote} onError={onError} />
    </div>
  );
}

function Rates({ onNote, onError }: { onNote: (m: string) => void; onError: (e: unknown) => void }) {
  const [rates, setRates] = useState<Rate[] | null>(null);
  const [edit, setEdit] = useState<Record<string, { rate: string; source: string }>>({});
  const load = useCallback(() => { api<{ rates: Rate[] }>("/api/admin/fx").then((r) => setRates(r.rates)).catch(onError); }, [onError]);
  useEffect(load, [load]);
  if (!rates) return <Card className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Loading...</Card>;
  const save = async (currency: string) => {
    const e = edit[currency];
    if (!e) return;
    const send = (confirm: boolean) => api("/api/admin/fx", { method: "PUT", body: { currency, perUsd: e.rate, source: e.source, confirm } });
    try {
      try { await send(false); } catch (err) {
        if (err instanceof ApiError && /more than 30%/.test(err.message) && window.confirm(`${err.message}\n\nSave it anyway?`)) await send(true); else throw err;
      }
      setEdit((x) => { const n = { ...x }; delete n[currency]; return n; });
      onNote(`${currency} rate saved.`);
      load();
    } catch (err) { onError(err); }
  };
  const current = (c: string) => rates.find((r) => r.currency === c);
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Exchange rates (for reports only)</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">Used only to add up money from different currencies in the Finance tab. Customers always pay in their plan&apos;s currency: a rate never changes an invoice. Type the rate as <b>how many units of the currency equal 1 US dollar</b> (for rupees, about 85) and where you got it. Nothing is fetched automatically. A currency with no rate is left out of the dollar totals and listed as missing.</p>
      </div>
      <ul className="divide-y divide-slate-100 text-sm">
        {NON_USD.map((c) => {
          const cur = current(c);
          const e = edit[c];
          return (
            <li key={c} className="flex flex-wrap items-end gap-3 py-2.5">
              <div className="min-w-32"><span className="font-semibold text-slate-900">{c}</span> <span className="text-xs text-slate-500">{CURRENCY_INFO[c].name}</span></div>
              <div className="min-w-44 text-xs text-slate-600">{cur ? <>1 USD = <b className="tabular-nums text-slate-900">{trimRate(cur.perUsdMicro)}</b> {c}<br /><span className="text-slate-500">{cur.source} · {cur.setAt.slice(0, 10)}</span></> : <Pill tone="amber">no rate yet</Pill>}</div>
              <label className="text-xs text-slate-600">New rate<input value={e?.rate ?? ""} onChange={(ev) => setEdit({ ...edit, [c]: { rate: ev.target.value.replace(/[^\d.]/g, ""), source: e?.source ?? "" } })} inputMode="decimal" className={inputClass + " mt-1 block !w-28"} aria-label={`${c} per US dollar`} /></label>
              <label className="text-xs text-slate-600">Where from<input value={e?.source ?? ""} onChange={(ev) => setEdit({ ...edit, [c]: { rate: e?.rate ?? "", source: ev.target.value } })} placeholder="bank or site, date" className={inputClass + " mt-1 block !w-56"} aria-label={`${c} rate source`} /></label>
              <Button variant="ghost" onClick={() => void save(c)} disabled={!e || !e.rate || e.source.trim().length < 3}>Save</Button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function Rules({ onNote, onError }: { onNote: (m: string) => void; onError: (e: unknown) => void }) {
  const [data, setData] = useState<{ rules: Rule[]; gstBasisPoints: number } | null>(null);
  const [f, setF] = useState({ country: "", currency: "", label: "VAT", rate: "" });
  const load = useCallback(() => { api<{ rules: Rule[]; gstBasisPoints: number }>("/api/admin/tax").then(setData).catch(onError); }, [onError]);
  useEffect(load, [load]);
  if (!data) return null;
  const put = (body: object, note: string) => api("/api/admin/tax", { method: "PUT", body }).then(() => { onNote(note); load(); }).catch(onError);
  const sel = "rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500";
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Tax rules</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">
          A customer&apos;s tax follows the <b>billing country</b> they give. If a rule matches that country (and the invoice currency), it is used. Otherwise a <b>rupee</b> invoice to an Indian or unknown country gets GST at <b>{data.gstBasisPoints / 100}%</b>, and everything else gets no tax. No other rate is built in: add each rule only after checking the rate with your accountant. A change affects new invoices only; invoices already issued keep the tax they were issued with. Reverse charge, tax-exempt customers and checking tax numbers are not handled.
        </p>
      </div>
      {data.rules.length === 0 ? <p className="text-sm text-slate-500">No rules yet.</p> : (
        <ul className="divide-y divide-slate-100 text-sm">
          {data.rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
              <b className="w-10 text-slate-900">{r.country}</b>
              <span className="text-slate-700">{r.label} {r.rateBasisPoints / 100}%</span>
              <span className="text-xs text-slate-500">{r.currency ? `only ${r.currency} invoices` : "any currency"}</span>
              {!r.active && <Pill tone="red">off</Pill>}
              <Button variant="ghost" className="ml-auto px-3 py-1.5" onClick={() => void put({ country: r.country, currency: r.currency, label: r.label, rateBasisPoints: r.rateBasisPoints, active: !r.active, note: r.note }, r.active ? "Rule switched off." : "Rule switched on.")}>{r.active ? "Switch off" : "Switch on"}</Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <label className="text-xs text-slate-600">Country (2 letters)<input value={f.country} onChange={(e) => setF({ ...f, country: e.target.value.toUpperCase().slice(0, 2) })} className={inputClass + " mt-1 block !w-24"} aria-label="Tax country" /></label>
        <label className="text-xs text-slate-600">Currency<select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} className={sel + " mt-1 block"} aria-label="Tax currency"><option value="">any</option>{CURRENCY_CODES.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className="text-xs text-slate-600">Tax name<input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} className={inputClass + " mt-1 block !w-28"} aria-label="Tax name" /></label>
        <label className="text-xs text-slate-600">Rate %<input value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value.replace(/[^\d.]/g, "") })} className={inputClass + " mt-1 block !w-24"} aria-label="Tax rate percent" /></label>
        <Button onClick={() => void put({ country: f.country, currency: f.currency || null, label: f.label, rateBasisPoints: Math.round(Number(f.rate) * 100) }, "Rule saved.").then(() => setF({ country: "", currency: "", label: "VAT", rate: "" }))} disabled={f.country.length !== 2 || !f.rate}>Save rule</Button>
      </div>
    </Card>
  );
}

function SellerCard({ onNote, onError }: { onNote: (m: string) => void; onError: (e: unknown) => void }) {
  const [s, setS] = useState<Seller | null>(null);
  useEffect(() => { api<{ seller: Seller }>("/api/admin/seller").then((r) => setS(r.seller)).catch(onError); }, [onError]);
  if (!s) return null;
  const set = (k: keyof Seller, v: string) => setS({ ...s, [k]: v });
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Who invoices come from</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">Printed at the top of every invoice. Fill in your registered business name, address and tax number exactly as they appear on your registration. Leave blank to omit.</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-slate-600">Legal name<input value={s.legalName} onChange={(e) => set("legalName", e.target.value)} className={inputClass + " mt-1"} aria-label="Seller legal name" /></label>
        <label className="text-xs text-slate-600">Billing email<input value={s.email} onChange={(e) => set("email", e.target.value)} className={inputClass + " mt-1"} aria-label="Seller email" /></label>
        <label className="text-xs text-slate-600 sm:col-span-2">Address<input value={s.address} onChange={(e) => set("address", e.target.value)} className={inputClass + " mt-1"} aria-label="Seller address" /></label>
        <label className="text-xs text-slate-600">Country (2 letters)<input value={s.country} onChange={(e) => set("country", e.target.value.toUpperCase().slice(0, 2))} className={inputClass + " mt-1"} aria-label="Seller country" /></label>
        <div className="flex gap-2">
          <label className="w-28 text-xs text-slate-600">Number type<input value={s.taxIdType} onChange={(e) => set("taxIdType", e.target.value)} placeholder="GSTIN" className={inputClass + " mt-1"} aria-label="Seller tax number type" /></label>
          <label className="flex-1 text-xs text-slate-600">Tax number<input value={s.taxId} onChange={(e) => set("taxId", e.target.value)} className={inputClass + " mt-1"} aria-label="Seller tax number" /></label>
        </div>
      </div>
      <Button onClick={() => api("/api/admin/seller", { method: "PUT", body: s }).then(() => onNote("Saved.")).catch(onError)}>Save</Button>
      {!s.legalName && <Notice tone="amber">Invoices will not show a seller name until you fill this in.</Notice>}
    </Card>
  );
}

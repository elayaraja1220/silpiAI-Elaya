"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, Loader2, Lock, Plus, Save, Server, Trash2 } from "lucide-react";

import { formatINR } from "@/lib/business/pricing";
import {
  ARRANGEMENTS, ARRANGEMENT_LABELS, FREQUENCY_TEXT, INTERNAL_STATUSES, INTERNAL_STATUS_LABELS, RESPONSIBILITY, SERVICE_FREQUENCIES,
  adminRunningSummary, publicRunningServices, serviceMarkup, type Arrangement, type InternalStatus, type RunningService, type ServiceFrequency,
} from "@/lib/business/running-services";
import { RECURRING_CATEGORIES } from "@/lib/business/cost-types";
import { cn } from "@/lib/utils";

import { AdminGate } from "./admin-gate";
import { RunningServicesSection } from "./running-services-view";
import { Card, jsonFetch } from "./ui";

type Loaded = { saved: boolean; services: RunningService[] };

const field = "w-full rounded-md border border-white/[.08] bg-white/[.03] px-2.5 py-1.5 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-violet-400/60";
const label = "block space-y-1 text-[10px] font-medium uppercase tracking-wider text-slate-500";

const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "service";

function Body({ leadId }: { leadId: string }) {
  const [services, setServices] = useState<RunningService[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    jsonFetch<Loaded>(`/api/business/leads/${leadId}/running-services`)
      .then((r) => { setServices(r.services); setSaved(r.saved); setDirty(false); })
      .catch((e: Error) => setMessage({ ok: false, text: e.message }));
  }, [leadId]);
  useEffect(load, [load]);

  const preview = useMemo(() => (services ? publicRunningServices(services) : null), [services]);
  const summary = useMemo(() => (services ? adminRunningSummary(services) : null), [services]);
  if (!services) return message ? <p className="text-xs text-rose-300">{message.text}</p> : <p className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={14} className="animate-spin" /> Loading running services...</p>;

  const update = (id: string, patch: Partial<RunningService>) => { setServices(services.map((s) => (s.id === id ? { ...s, ...patch } : s))); setDirty(true); setMessage(null); };
  const add = () => {
    let id = "custom";
    for (let n = 1; services.some((s) => s.id === id); n++) id = `custom-${n}`;
    setServices([...services, { id, service: "New service", category: "other", provider: "", providerCost: null, suggestedPrice: null, clientAmount: null, gstIncluded: false, frequency: "annual", arrangement: "client-direct", internalStatus: "to-review", showToClient: false, renewalTerms: "", internalNotes: "" }]);
    setDirty(true);
  };
  const remove = (id: string) => { setServices(services.filter((s) => s.id !== id)); setDirty(true); };
  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await jsonFetch<Loaded>(`/api/business/leads/${leadId}/running-services`, { method: "PUT", body: JSON.stringify({ services }) });
      setServices(r.services); setSaved(true); setDirty(false);
      setMessage({ ok: true, text: "Saved. The client sees only the services you approved, with the fields shown in the preview." });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="running-editor">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
        <p>
          {saved ? "Saved arrangements." : "Starting list from the suggested running costs. Nothing is shown to the client until you tick “Show in client quotation” and save."}
          {summary && <span className="ml-2 text-slate-500">{summary.visibleToClient} of {summary.total} shown to the client{summary.priceMissing > 0 ? ` · ${summary.priceMissing} billed by SILPI without a client amount` : ""}</span>}
        </p>
        <button type="button" onClick={add} className="flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1.5 text-slate-200 hover:bg-white/5"><Plus size={12} /> Add service</button>
      </div>

      <div className="space-y-3">
        {services.map((s) => {
          const markup = serviceMarkup(s);
          const billed = s.arrangement === "agency-bills";
          return (
            <div key={s.id} className={cn("space-y-3 rounded-xl border p-3", s.showToClient && s.arrangement !== "not-applicable" ? "border-sky-400/30 bg-sky-500/[.04]" : "border-white/[.07] bg-white/[.02]")} data-testid={`service-${s.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <input aria-label={`Service name ${s.id}`} value={s.service} onChange={(e) => update(s.id, { service: e.target.value })} className={cn(field, "min-w-0 flex-1 basis-full font-semibold sm:basis-0")} maxLength={120} />
                <span className="rounded-full bg-white/[.06] px-2 py-0.5 text-[10px] text-slate-400">{RESPONSIBILITY[s.arrangement]}</span>
                <button type="button" onClick={() => remove(s.id)} aria-label={`Remove ${s.service}`} className="rounded-md p-1.5 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"><Trash2 size={14} /></button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className={label}>Arrangement
                  <select aria-label={`Arrangement ${s.id}`} value={s.arrangement} onChange={(e) => update(s.id, { arrangement: e.target.value as Arrangement })} className={field}>
                    {ARRANGEMENTS.map((a) => <option key={a} value={a}>{ARRANGEMENT_LABELS[a]}</option>)}
                  </select>
                </label>
                <label className={label}>Billing frequency
                  <select aria-label={`Frequency ${s.id}`} value={s.frequency ?? ""} onChange={(e) => update(s.id, { frequency: (e.target.value || null) as ServiceFrequency | null })} className={field}>
                    <option value="">Not set</option>
                    {SERVICE_FREQUENCIES.map((f) => <option key={f} value={f}>{FREQUENCY_TEXT[f]}</option>)}
                  </select>
                </label>
                <label className={label}>Category
                  <select aria-label={`Category ${s.id}`} value={s.category} onChange={(e) => update(s.id, { category: e.target.value as RunningService["category"] })} className={field}>
                    {RECURRING_CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/-/g, " ")}</option>)}
                  </select>
                </label>
                <label className={label}>Internal status
                  <select aria-label={`Internal status ${s.id}`} value={s.internalStatus} onChange={(e) => update(s.id, { internalStatus: e.target.value as InternalStatus })} className={field}>
                    {INTERNAL_STATUSES.map((x) => <option key={x} value={x}>{INTERNAL_STATUS_LABELS[x]}</option>)}
                  </select>
                </label>
              </div>

              <div className="grid gap-3 rounded-lg border border-amber-400/15 bg-amber-500/[.03] p-3 sm:grid-cols-2 lg:grid-cols-4">
                <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-200/80 sm:col-span-2 lg:col-span-4"><Lock size={10} /> Internal: never shown to the client</p>
                <label className={label}>Provider
                  <input aria-label={`Provider ${s.id}`} value={s.provider} onChange={(e) => update(s.id, { provider: e.target.value })} className={field} maxLength={120} placeholder="e.g. Hostinger" />
                </label>
                <label className={label}>Provider actual cost (₹)
                  <input aria-label={`Provider cost ${s.id}`} type="number" min={0} value={s.providerCost ?? ""} onChange={(e) => update(s.id, { providerCost: num(e.target.value) })} className={field} placeholder="Unknown" />
                </label>
                <label className={label}>Suggested client price (₹)
                  <input aria-label={`Suggested price ${s.id}`} type="number" min={0} value={s.suggestedPrice ?? ""} onChange={(e) => update(s.id, { suggestedPrice: num(e.target.value) })} className={field} placeholder="Not set" />
                </label>
                <div className="space-y-1 text-[11px] text-slate-400">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Markup</p>
                  <p className="tabular-nums text-slate-200">{markup ? `${formatINR(markup.amount)}${markup.percent !== null ? ` (${markup.percent}%)` : ""}` : "Needs provider cost and client amount"}</p>
                </div>
                <label className={cn(label, "sm:col-span-2")}>Internal notes
                  <input aria-label={`Internal notes ${s.id}`} value={s.internalNotes} onChange={(e) => update(s.id, { internalNotes: e.target.value })} className={field} maxLength={500} />
                </label>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className={label}>Client billing amount (₹){!billed && <span className="ml-1 normal-case text-slate-600">(shown only when SILPI bills)</span>}
                  <input aria-label={`Client amount ${s.id}`} type="number" min={0} value={s.clientAmount ?? ""} onChange={(e) => update(s.id, { clientAmount: num(e.target.value) })} className={field} placeholder="Not set" />
                </label>
                <label className="flex items-end gap-2 pb-1.5 text-xs text-slate-300"><input type="checkbox" checked={s.gstIncluded} onChange={(e) => update(s.id, { gstIncluded: e.target.checked })} className="accent-violet-500" /> Amount includes GST</label>
                <label className={cn(label, "sm:col-span-2")}>Renewal terms (shown to the client)
                  <input aria-label={`Renewal terms ${s.id}`} value={s.renewalTerms} onChange={(e) => update(s.id, { renewalTerms: e.target.value })} className={field} maxLength={300} placeholder="e.g. Renews every year on the same date" />
                </label>
                <p className="text-xs text-slate-400">Included in package: <span className="font-semibold text-slate-200">{s.arrangement === "included" ? "Yes" : "No"}</span></p>
                <label className="flex items-center gap-2 text-xs font-medium text-sky-200 sm:col-span-2">
                  <input aria-label={`Show in client quotation ${s.id}`} type="checkbox" checked={s.showToClient} onChange={(e) => update(s.id, { showToClient: e.target.checked })} className="accent-sky-500" /> Show in client quotation
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={save} disabled={busy || !dirty} className="flex items-center gap-1.5 rounded-lg bg-violet-500 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-400 disabled:opacity-40" data-testid="save-running">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save running services
        </button>
        {dirty && <span className="text-[11px] text-amber-200">Unsaved changes: the client still sees the last saved version.</span>}
      </div>
      {message && <p className={cn("rounded-lg border px-3 py-2 text-xs", message.ok ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200" : "border-rose-400/30 bg-rose-500/10 text-rose-200")}>{message.text}</p>}

      <details className="rounded-xl border border-white/[.07] p-3" data-testid="client-preview">
        <summary className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-200"><Eye size={13} /> What the client will see {dirty && <span className="text-[10px] font-normal text-amber-200">(including unsaved changes)</span>}</summary>
        <div className="mt-3 rounded-xl bg-white p-4 text-slate-800">
          {preview ? <RunningServicesSection running={preview} /> : <p className="text-xs text-slate-500">Nothing is shown to the client yet: the quotation keeps its standard note that domain and hosting are bought separately.</p>}
        </div>
      </details>
    </div>
  );
}

/** Admin screen for the running services of one quotation. Signed-in administrator only. */
export function RunningServicesEditor({ leadId }: { leadId: string }) {
  return (
    <div data-testid="running-services-admin"><Card className="space-y-3">
      <div>
        <p className="flex items-center gap-2 text-sm font-semibold text-slate-100"><Server size={15} className="text-teal-300" /> Running services: domain, hosting, maintenance</p>
        <p className="mt-0.5 text-[11px] text-slate-500">Decide who provides and pays for each service, and which ones the client sees. Provider costs, suggested prices, markup, status and notes stay private.</p>
      </div>
      <AdminGate label="running services">
        <Body leadId={leadId} />
      </AdminGate>
    </Card></div>
  );
}

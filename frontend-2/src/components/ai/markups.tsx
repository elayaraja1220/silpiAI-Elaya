"use client";

import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";

import { api, Button, Card, inputClass, Pill } from "./light";

export type Rule = { id: number; provider: string | null; modelId: string | null; taskType: string | null; markupBasisPoints: number; enabled: boolean; note: string };

const TASKS = ["chat", "document_analysis", "architecture_planning", "code_generation", "bug_fixing", "code_review", "other"];
const pct = (bp: number) => `${(bp / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
const times = (bp: number) => `${(bp / 10_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}x`;

/** Markup rules: what customers are charged over the provider's cost, for a provider, a model, a kind of task, or a mix. The most specific rule wins. */
export function MarkupRules({ rules, modelIds, providers, onSaved, onError }: { rules: Rule[]; modelIds: string[]; providers: string[]; onSaved: () => void; onError: (e: unknown) => void }) {
  const [f, setF] = useState({ provider: "", modelId: "", taskType: "", markup: "250" });
  const [busy, setBusy] = useState(false);
  const save = (body: object) => api("/api/admin/ai/markups", { method: "PUT", body }).then(onSaved).catch(onError);
  const add = async () => {
    setBusy(true);
    await save({ provider: f.provider || null, modelId: f.modelId || null, taskType: f.taskType || null, markupBasisPoints: Math.round(Number(f.markup) * 100) });
    setBusy(false);
    setF({ provider: "", modelId: "", taskType: "", markup: "250" });
  };
  const sel = "rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500";
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Markup rules</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">
          What customers are charged on top of the provider's cost. 100% charges the provider's cost as it is; 250% is 2.5 times. A rule can name a provider, a model, a kind of task, or a mix. When several match, the most specific wins: a model counts most, then a task, then a provider. With no rule, the model's own markup applies.
        </p>
      </div>
      {rules.length === 0 ? <p className="text-sm text-slate-500">No rules yet: every model uses its own markup.</p> : (
        <ul className="divide-y divide-slate-100">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
              <span className="flex flex-wrap gap-1.5">
                {r.modelId && <Pill tone="indigo">model {r.modelId}</Pill>}
                {r.taskType && <Pill tone="amber">task {r.taskType}</Pill>}
                {r.provider && <Pill tone="slate">provider {r.provider}</Pill>}
              </span>
              <span className="font-semibold tabular-nums text-slate-900">{pct(r.markupBasisPoints)} <span className="font-normal text-slate-400">({times(r.markupBasisPoints)})</span></span>
              {!r.enabled && <Pill tone="red">off</Pill>}
              <span className="ml-auto flex gap-2">
                <Button variant="ghost" className="px-3 py-1.5" onClick={() => void save({ id: r.id, provider: r.provider, modelId: r.modelId, taskType: r.taskType, markupBasisPoints: r.markupBasisPoints, enabled: !r.enabled })}>{r.enabled ? "Turn off" : "Turn on"}</Button>
                <button aria-label={`Delete rule ${r.id}`} onClick={() => api(`/api/admin/ai/markups?id=${r.id}`, { method: "DELETE" }).then(onSaved).catch(onError)} className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 size={15} /></button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <label className="text-xs text-slate-600">Provider<select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} className={sel + " mt-1 block"}><option value="">any</option>{providers.map((p) => <option key={p}>{p}</option>)}</select></label>
        <label className="text-xs text-slate-600">Model<select value={f.modelId} onChange={(e) => setF({ ...f, modelId: e.target.value })} className={sel + " mt-1 block"}><option value="">any</option>{modelIds.map((m) => <option key={m}>{m}</option>)}</select></label>
        <label className="text-xs text-slate-600">Task<select value={f.taskType} onChange={(e) => setF({ ...f, taskType: e.target.value })} className={sel + " mt-1 block"}><option value="">any</option>{TASKS.map((t) => <option key={t}>{t}</option>)}</select></label>
        <label className="text-xs text-slate-600">Markup %<input value={f.markup} onChange={(e) => setF({ ...f, markup: e.target.value.replace(/[^\d.]/g, "") })} className={inputClass + " mt-1 w-24"} /></label>
        <Button onClick={() => void add()} disabled={busy || (!f.provider && !f.modelId && !f.taskType) || !f.markup}>{busy && <Loader2 size={15} className="animate-spin" />} Add rule</Button>
      </div>
    </Card>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Lock } from "lucide-react";

import { Customers } from "./customers";
import { api, ApiError, Button, Card, credits, inputClass, Notice, Pill, usd } from "./light";

type Model = { id: string; provider: string; providerModel: string; label: string; tier: string; inputUsdMicroPerMtok: number; outputUsdMicroPerMtok: number; markupBasisPoints: number; maxOutputTokens: number; priority: number; enabled: boolean };
type Org = { orgId: string; orgName: string; requests: number; failed: number; providerCostMicroUsd: number; chargedUnits: number; chargedUsdAtCurrentRate: number; dailyCapUnits: number | null };
type Overview = { unitsPerUsd: number; models: Model[]; organizations: Org[] };

/** Administrator view: what the AI really costs, what customers are charged, and the dials. Needs the administrator token. */
export function AiAdmin() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    api<{ overview: Overview }>("/api/admin/ai")
      .then((r) => { setOverview(r.overview); setNeedsSignIn(false); })
      .catch((e: ApiError) => (e.status === 401 || e.status === 403 ? setNeedsSignIn(true) : setError(e.message)));
  }, []);
  useEffect(load, [load]);

  if (needsSignIn) return <TokenSignIn onDone={load} />;
  if (error) return <Notice tone="red">{error}</Notice>;
  if (!overview) return <Card className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Loading...</Card>;

  const flash = (m: string) => { setNote(m); setTimeout(() => setNote(""), 3000); };
  const fail = (e: unknown) => setError((e as Error).message);

  return (
    <div className="space-y-5">
      {note && <Notice tone="green">{note}</Notice>}
      <Customers onChanged={flash} onError={fail} />
      <Notice tone="amber">The starting prices and the credit conversion below are proposed values, not verified. Check each price against the provider&apos;s own price page before real customers use them.</Notice>
      <Conversion value={overview.unitsPerUsd} onSaved={(v) => { setOverview({ ...overview, unitsPerUsd: v }); flash("Conversion saved."); }} onError={fail} />
      <Models models={overview.models} onSaved={() => { flash("Model saved."); load(); }} onError={fail} />
      <Orgs orgs={overview.organizations} onSaved={() => { flash("Limit saved."); load(); }} onError={fail} />
    </div>
  );
}

function TokenSignIn({ onDone }: { onDone: () => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [help, setHelp] = useState("");
  useEffect(() => {
    api<{ configured: boolean }>("/api/admin/session")
      .then((r) => {
        setConfigured(r.configured);
        // The server words the setup instruction itself (it names the setting); an empty attempt only fetches that text.
        if (!r.configured) api("/api/admin/session", { method: "POST", body: { token: "" } }).catch((e: Error) => setHelp(e.message));
      })
      .catch(() => setConfigured(true));
  }, []);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setError("");
    try { await api("/api/admin/session", { method: "POST", body: { token } }); setToken(""); onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  if (configured === false) {
    return (
      <Card className="mx-auto max-w-lg space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><Lock size={17} /> Set up the administrator token first</h2>
        <p className="text-sm text-slate-600">The administrator pages are locked until a secret token exists.</p>
        {help && <Notice tone="amber">{help}</Notice>}
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-700">
          <li>Choose a long secret (16 or more characters) and add it to the file named above, as the setting the message names.</li>
          <li>Stop the server (Ctrl+C) and start it again with <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">npm run dev</code>.</li>
          <li>Reload this page and sign in with that secret.</li>
        </ol>
      </Card>
    );
  }
  return (
    <Card className="mx-auto max-w-md space-y-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><Lock size={17} /> Administrator sign-in</h2>
      <p className="text-sm text-slate-600">Prices, markup and limits are for the administrator only. Enter the administrator token.</p>
      <input type="password" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === "Enter" && token && void go()} className={inputClass} placeholder="Administrator token" aria-label="Administrator token" autoComplete="off" />
      {error && <Notice tone="red">{error}</Notice>}
      <Button onClick={() => void go()} disabled={!token || busy}>{busy && <Loader2 size={15} className="animate-spin" />} Sign in</Button>
    </Card>
  );
}

function Conversion({ value, onSaved, onError }: { value: number; onSaved: (v: number) => void; onError: (e: unknown) => void }) {
  const [v, setV] = useState(String(value));
  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-semibold text-slate-900">Credit conversion</h2>
      <p className="text-xs leading-5 text-slate-600">How many credit units one US dollar of provider cost is worth (1 credit = 1,000 units). With the model markups below, this sets your margin. Now: <b>$1 of AI cost = {credits(value)} credits</b>.</p>
      <div className="flex max-w-sm gap-2">
        <input value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, ""))} inputMode="numeric" className={inputClass} aria-label="Units per US dollar" />
        <Button onClick={() => api<{ unitsPerUsd: number }>("/api/admin/ai/settings", { method: "PUT", body: { unitsPerUsd: Number(v) } }).then((r) => onSaved(r.unitsPerUsd)).catch(onError)} disabled={!v || Number(v) === value}>Save</Button>
      </div>
    </Card>
  );
}

const perMtok = (micro: number) => (micro / 1_000_000).toString();
const toMicro = (s: string) => Math.round(Number(s) * 1_000_000);

function Models({ models, onSaved, onError }: { models: Model[]; onSaved: () => void; onError: (e: unknown) => void }) {
  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-semibold text-slate-900">Models</h2>
      <p className="text-xs text-slate-600">Prices are US dollars per million tokens, as the provider charges you. Markup 100% means no markup on top of the conversion above.</p>
      <div className="space-y-3">{models.map((m) => <ModelRow key={m.id + m.inputUsdMicroPerMtok + m.outputUsdMicroPerMtok + m.markupBasisPoints + m.priority + m.enabled} m={m} onSaved={onSaved} onError={onError} />)}</div>
    </Card>
  );
}

function ModelRow({ m, onSaved, onError }: { m: Model; onSaved: () => void; onError: (e: unknown) => void }) {
  const [inp, setInp] = useState(perMtok(m.inputUsdMicroPerMtok));
  const [out, setOut] = useState(perMtok(m.outputUsdMicroPerMtok));
  const [markup, setMarkup] = useState(String(m.markupBasisPoints / 100));
  const [priority, setPriority] = useState(String(m.priority));
  const save = (extra: Partial<Model> = {}) =>
    api("/api/admin/ai/models", { method: "PUT", body: { id: m.id, inputUsdMicroPerMtok: toMicro(inp), outputUsdMicroPerMtok: toMicro(out), markupBasisPoints: Math.round(Number(markup) * 100), priority: Number(priority), ...extra } }).then(onSaved).catch(onError);
  const field = "w-24 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm tabular-nums text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20";
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 p-3">
      <div className="min-w-40 flex-1">
        <p className="text-sm font-semibold text-slate-900">{m.label} <span className="font-normal text-slate-500">({m.id})</span></p>
        <p className="text-xs text-slate-500">{m.provider} · {m.providerModel} · <Pill tone="indigo">{m.tier}</Pill></p>
      </div>
      <label className="text-xs text-slate-600">Input $/M<input value={inp} onChange={(e) => setInp(e.target.value)} className={field + " mt-1 block"} /></label>
      <label className="text-xs text-slate-600">Output $/M<input value={out} onChange={(e) => setOut(e.target.value)} className={field + " mt-1 block"} /></label>
      <label className="text-xs text-slate-600">Markup %<input value={markup} onChange={(e) => setMarkup(e.target.value)} className={field + " mt-1 block"} /></label>
      <label className="text-xs text-slate-600">Priority<input value={priority} onChange={(e) => setPriority(e.target.value)} className={field + " mt-1 block w-20"} /></label>
      <Button variant="ghost" onClick={() => void save()}>Save</Button>
      <Button variant={m.enabled ? "danger" : "primary"} onClick={() => void save({ enabled: !m.enabled })}>{m.enabled ? "Disable" : "Enable"}</Button>
    </div>
  );
}

function Orgs({ orgs, onSaved, onError }: { orgs: Org[]; onSaved: () => void; onError: (e: unknown) => void }) {
  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-semibold text-slate-900">This month: provider cost vs what customers were charged</h2>
      {orgs.length === 0 ? <p className="text-sm text-slate-500">No AI requests yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="py-2 pr-4 font-medium">Organization</th><th className="py-2 pr-4 text-right font-medium">Requests</th><th className="py-2 pr-4 text-right font-medium">You paid providers</th><th className="py-2 pr-4 text-right font-medium">Charged (at current rate)</th><th className="py-2 pr-4 text-right font-medium">Cover</th><th className="py-2 font-medium">Daily cap (credits)</th></tr></thead>
            <tbody>{orgs.map((o) => <OrgRow key={o.orgId + o.dailyCapUnits} o={o} onSaved={onSaved} onError={onError} />)}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function OrgRow({ o, onSaved, onError }: { o: Org; onSaved: () => void; onError: (e: unknown) => void }) {
  const [cap, setCap] = useState(o.dailyCapUnits === null ? "" : String(o.dailyCapUnits / 1000));
  const cost = o.providerCostMicroUsd / 1_000_000;
  const cover = cost > 0 ? o.chargedUsdAtCurrentRate / cost : null;
  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-2 pr-4 font-medium text-slate-800">{o.orgName}</td>
      <td className="py-2 pr-4 text-right tabular-nums">{o.requests}{o.failed > 0 && <span className="text-slate-400"> ({o.failed} failed)</span>}</td>
      <td className="py-2 pr-4 text-right tabular-nums">{usd(cost)}</td>
      <td className="py-2 pr-4 text-right tabular-nums">{usd(o.chargedUsdAtCurrentRate)}</td>
      <td className="py-2 pr-4 text-right tabular-nums">{cover === null ? "-" : <Pill tone={cover >= 1 ? "green" : "red"}>{cover.toFixed(2)}x</Pill>}</td>
      <td className="py-2"><div className="flex gap-2"><input value={cap} onChange={(e) => setCap(e.target.value)} placeholder="no cap" className="w-24 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm tabular-nums outline-none focus:border-indigo-500" aria-label={`Daily cap for ${o.orgName}`} /><Button variant="ghost" className="px-3 py-1.5" onClick={() => api("/api/admin/ai/limits", { method: "PUT", body: { orgId: o.orgId, dailyCapUnits: cap.trim() === "" ? null : Math.round(Number(cap) * 1000) } }).then(onSaved).catch(onError)}>Set</Button></div></td>
    </tr>
  );
}

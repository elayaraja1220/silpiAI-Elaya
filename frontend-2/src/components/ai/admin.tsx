"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Lock } from "lucide-react";

import { Customers } from "./customers";
import { MarkupRules, type Rule } from "./markups";
import { CouponsAdmin, PlansAdmin } from "./plans-admin";
import { AuditAdmin, FinanceAdmin } from "./finance-admin";
import { PricingAdmin } from "./pricing-admin";
import { SecurityAdmin } from "./security-admin";
import { TaxAdmin } from "./tax-admin";
import { PaymentsAdmin } from "./payments-admin";
import { api, ApiError, Button, Card, credits, inputClass, Notice, Pill, usd } from "./light";

type Model = { cacheReadUsdMicroPerMtok: number | null; cacheWriteUsdMicroPerMtok: number | null; priceVersion: number; id: string; provider: string; providerModel: string; label: string; tier: string; inputUsdMicroPerMtok: number; outputUsdMicroPerMtok: number; markupBasisPoints: number; maxOutputTokens: number; priority: number; enabled: boolean };
type Org = { orgId: string; orgName: string; requests: number; failed: number; providerCostMicroUsd: number; chargedUnits: number; chargedUsdAtCurrentRate: number; dailyCapUnits: number | null };
type Policy = { rounding: "up" | "nearest"; minChargeUnits: number };
type ProviderStatus = { id: string; configured: boolean; circuit: "closed" | "open" | "half-open" };
type Who = { name: string; role: "admin" | "viewer"; actor: string };
type Overview = { providers: ProviderStatus[]; unitsPerUsd: number; policy: Policy; markupRules: Rule[]; models: Model[]; organizations: Org[] };

const ADMIN_TABS = ["Finance", "Customers & plans", "Payments", "Tax & currency", "Global pricing", "AI", "Audit log", "Security & launch"] as const;

/** Administrator view: what the AI really costs, what customers are charged, and the dials. Needs the administrator token. */
export function AiAdmin() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [who, setWho] = useState<Who | null>(null);
  const [note, setNote] = useState("");
  const [tab, setTab] = useState<(typeof ADMIN_TABS)[number]>("Finance");

  const load = useCallback(() => {
    api<{ overview: Overview }>("/api/admin/ai")
      .then((r) => { setOverview(r.overview); setNeedsSignIn(false); })
      .catch((e: ApiError) => (e.status === 401 || e.status === 403 ? setNeedsSignIn(true) : setError(e.message)));
  }, []);
  useEffect(load, [load]);
  useEffect(() => { api<{ identity?: Who }>("/api/admin/session").then((r) => setWho(r.identity ?? null)).catch(() => undefined); }, [needsSignIn]);

  if (needsSignIn) return <TokenSignIn onDone={load} />;
  if (error) return <Notice tone="red">{error}</Notice>;
  if (!overview) return <Card className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Loading...</Card>;

  const flash = (m: string) => { setNote(m); setTimeout(() => setNote(""), 3000); };
  const fail = (e: unknown) => setActionError((e as Error).message);
  const signOut = () => api("/api/admin/session", { method: "DELETE" }).then(() => { setWho(null); setOverview(null); load(); }).catch(fail);

  return (
    <div className="space-y-5">
      {note && <Notice tone="green">{note}</Notice>}
      {actionError && (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          <span className="flex-1">{actionError}</span>
          <button onClick={() => setActionError("")} className="text-xs underline" aria-label="Dismiss the message">Dismiss</button>
        </div>
      )}
      {who && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          Signed in as <b className="text-slate-700">{who.name}</b> <Pill tone={who.role === "admin" ? "indigo" : "slate"}>{who.role === "admin" ? "admin" : "viewer: read-only"}</Pill>
          <button onClick={signOut} className="ml-auto underline hover:text-slate-800">Sign out</button>
        </p>
      )}
      <div role="tablist" aria-label="Administrator sections" className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1">
        {ADMIN_TABS.map((x) => <button key={x} role="tab" aria-selected={tab === x} onClick={() => setTab(x)} className={"rounded-lg px-3 py-1.5 text-sm font-medium transition " + (tab === x ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-50")}>{x}</button>)}
      </div>
      {tab === "Finance" && <FinanceAdmin onError={fail} />}
      {tab === "Customers & plans" && (
        <>
          <Customers onChanged={flash} onError={fail} />
          <PlansAdmin onNote={flash} onError={fail} />
          <CouponsAdmin onNote={flash} onError={fail} />
        </>
      )}
      {tab === "Payments" && <PaymentsAdmin onNote={flash} onError={fail} />}
      {tab === "Tax & currency" && <TaxAdmin onNote={flash} onError={fail} />}
      {tab === "Global pricing" && <PricingAdmin onNote={flash} onError={fail} />}
      {tab === "AI" && (
        <>
          <Notice tone="amber">The starting prices and the credit conversion below are proposed values, not verified. Check each price against the provider&apos;s own price page before real customers use them.</Notice>
          <Charging value={overview.unitsPerUsd} policy={overview.policy} onSaved={() => { flash("Charging settings saved."); load(); }} onError={fail} />
          <MarkupRules rules={overview.markupRules} modelIds={overview.models.map((m) => m.id)} providers={[...new Set(overview.models.map((m) => m.provider))]} onSaved={() => { flash("Markup rules saved."); load(); }} onError={fail} />
          <Providers providers={overview.providers} />
          <AddModel providers={overview.providers.map((p) => p.id)} onSaved={() => { flash("Model added, switched off. Check its prices, then turn it on."); load(); }} onError={fail} />
          <Models models={overview.models} onSaved={() => { flash("Model saved."); load(); }} onError={fail} />
          <Orgs orgs={overview.organizations} onSaved={() => { flash("Limit saved."); load(); }} onError={fail} />
        </>
      )}
      {tab === "Audit log" && <AuditAdmin onError={fail} />}
      {tab === "Security & launch" && <SecurityAdmin onNote={flash} onError={fail} />}
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"account" | "token">("account");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setError("");
    try { await api("/api/admin/session", { method: "POST", body: mode === "token" ? { token } : { email, password } }); setToken(""); setPassword(""); onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
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
  const ready = mode === "token" ? !!token : !!email && !!password;
  return (
    <Card className="mx-auto max-w-md space-y-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><Lock size={17} /> Administrator sign-in</h2>
      <p className="text-sm text-slate-600">Prices, payments and settings are for administrators only.</p>
      {mode === "account" ? (
        <>
          <input value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} placeholder="Email" aria-label="Administrator email" autoComplete="username" />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ready && void go()} className={inputClass} placeholder="Password" aria-label="Administrator password" autoComplete="current-password" />
        </>
      ) : (
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => e.key === "Enter" && token && void go()} className={inputClass} placeholder="Administrator token" aria-label="Administrator token" autoComplete="off" />
      )}
      {error && <Notice tone="red">{error}</Notice>}
      <Button onClick={() => void go()} disabled={!ready || busy}>{busy && <Loader2 size={15} className="animate-spin" />} Sign in</Button>
      <button onClick={() => { setMode(mode === "account" ? "token" : "account"); setError(""); }} className="block text-xs text-slate-500 underline hover:text-slate-800">{mode === "account" ? "Use the administrator token instead" : "Use my account instead"}</button>
    </Card>
  );
}

function Charging({ value, policy, onSaved, onError }: { value: number; policy: Policy; onSaved: () => void; onError: (e: unknown) => void }) {
  const [v, setV] = useState(String(value));
  const [min, setMin] = useState(String(policy.minChargeUnits));
  const [rounding, setRounding] = useState<Policy["rounding"]>(policy.rounding);
  const changed = Number(v) !== value || Number(min) !== policy.minChargeUnits || rounding !== policy.rounding;
  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-semibold text-slate-900">How requests are charged</h2>
      <p className="text-xs leading-5 text-slate-600">
        Charge = provider cost x markup x units per dollar, rounded, and never below the minimum. 1 credit = 1,000 units. Now: <b>$1 of charge = {credits(value)} credits</b>. All three settings are saved together.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-600">Units per US dollar<input value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, ""))} inputMode="numeric" className={inputClass + " mt-1 w-36"} aria-label="Units per US dollar" /></label>
        <label className="text-xs text-slate-600">Minimum charge (units)<input value={min} onChange={(e) => setMin(e.target.value.replace(/\D/g, ""))} inputMode="numeric" className={inputClass + " mt-1 w-36"} aria-label="Minimum charge in units" /></label>
        <label className="text-xs text-slate-600">Rounding<select value={rounding} onChange={(e) => setRounding(e.target.value as Policy["rounding"])} className={inputClass + " mt-1 w-40"} aria-label="Rounding"><option value="up">Up (never undercharge)</option><option value="nearest">To the nearest</option></select></label>
        <Button onClick={() => api("/api/admin/ai/settings", { method: "PUT", body: { unitsPerUsd: Number(v), minChargeUnits: Number(min), rounding } }).then(onSaved).catch(onError)} disabled={!v || !min || !changed}>Save</Button>
      </div>
    </Card>
  );
}

const perMtok = (micro: number) => (micro / 1_000_000).toString();
const toMicro = (s: string) => Math.round(Number(s) * 1_000_000);

const KEY_NAME: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" };

function Providers({ providers }: { providers: ProviderStatus[] }) {
  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-semibold text-slate-900">AI providers</h2>
      <p className="text-xs leading-5 text-slate-600">A provider works once its key is set on the server (in the environment file, then restart). If a provider keeps failing its circuit opens: it is skipped for 30 seconds so customers are not kept waiting, then tried again.</p>
      <ul className="divide-y divide-slate-100 text-sm">
        {providers.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
            <span className="min-w-24 font-semibold text-slate-900">{p.id}</span>
            {p.configured ? <Pill tone="green">key set</Pill> : <Pill tone="slate">no key: {KEY_NAME[p.id] ?? "key"}</Pill>}
            {p.configured && <Pill tone={p.circuit === "closed" ? "green" : p.circuit === "open" ? "red" : "amber"}>{p.circuit === "closed" ? "working" : p.circuit === "open" ? "paused after failures" : "testing"}</Pill>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AddModel({ providers, onSaved, onError }: { providers: string[]; onSaved: () => void; onError: (e: unknown) => void }) {
  const [f, setF] = useState({ id: "", provider: providers[0] ?? "openai", providerModel: "", label: "", tier: "balanced" });
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try { await api("/api/admin/ai/models", { method: "PUT", body: { ...f, id: f.id.trim(), providerModel: f.providerModel.trim(), label: f.label.trim() } }); setF({ ...f, id: "", providerModel: "", label: "" }); onSaved(); } catch (e) { onError(e); } finally { setBusy(false); }
  };
  const sel = "rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500";
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Add a model</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">Type the model name exactly as the provider documents it. A new model is always added switched off with no price: set its prices from the provider&apos;s own price page below, then turn it on. It cannot be turned on at a zero price.</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">Provider<select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} className={sel + " mt-1 block"} aria-label="Provider">{providers.map((p) => <option key={p}>{p}</option>)}</select></label>
        <label className="text-xs text-slate-600">Provider&apos;s model name<input value={f.providerModel} onChange={(e) => setF({ ...f, providerModel: e.target.value })} className={inputClass + " mt-1 w-56"} aria-label="Provider model name" /></label>
        <label className="text-xs text-slate-600">Our id (lowercase)<input value={f.id} onChange={(e) => setF({ ...f, id: e.target.value.toLowerCase() })} className={inputClass + " mt-1 w-40"} aria-label="Model id" /></label>
        <label className="text-xs text-slate-600">Name shown<input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} className={inputClass + " mt-1 w-40"} aria-label="Model label" /></label>
        <label className="text-xs text-slate-600">Tier<select value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })} className={sel + " mt-1 block"} aria-label="Tier"><option value="fast">fast</option><option value="balanced">balanced</option><option value="best">best</option></select></label>
        <Button onClick={() => void add()} disabled={busy || f.id.trim().length < 2 || !f.providerModel.trim() || !f.label.trim()}>{busy && <Loader2 size={15} className="animate-spin" />} Add (switched off)</Button>
      </div>
    </Card>
  );
}

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
  const [cacheRead, setCacheRead] = useState(m.cacheReadUsdMicroPerMtok === null ? "" : perMtok(m.cacheReadUsdMicroPerMtok));
  const [cacheWrite, setCacheWrite] = useState(m.cacheWriteUsdMicroPerMtok === null ? "" : perMtok(m.cacheWriteUsdMicroPerMtok));
  const [markup, setMarkup] = useState(String(m.markupBasisPoints / 100));
  const [priority, setPriority] = useState(String(m.priority));
  const save = (extra: Partial<Model> = {}) =>
    api("/api/admin/ai/models", { method: "PUT", body: { id: m.id, inputUsdMicroPerMtok: toMicro(inp), outputUsdMicroPerMtok: toMicro(out), cacheReadUsdMicroPerMtok: cacheRead.trim() === "" ? null : toMicro(cacheRead), cacheWriteUsdMicroPerMtok: cacheWrite.trim() === "" ? null : toMicro(cacheWrite), markupBasisPoints: Math.round(Number(markup) * 100), priority: Number(priority), ...extra } }).then(onSaved).catch(onError);
  const field = "w-24 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm tabular-nums text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20";
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 p-3">
      <div className="min-w-40 flex-1">
        <p className="text-sm font-semibold text-slate-900">{m.label} <span className="font-normal text-slate-500">({m.id})</span> <Pill tone="slate">price v{m.priceVersion}</Pill></p>
        <p className="text-xs text-slate-500">{m.provider} · {m.providerModel} · <Pill tone="indigo">{m.tier}</Pill></p>
      </div>
      <label className="text-xs text-slate-600">Input $/M<input value={inp} onChange={(e) => setInp(e.target.value)} className={field + " mt-1 block"} /></label>
      <label className="text-xs text-slate-600">Output $/M<input value={out} onChange={(e) => setOut(e.target.value)} className={field + " mt-1 block"} /></label>
      <label className="text-xs text-slate-600" title="Leave empty if the provider bills cached tokens at the normal input price">Cache read $/M<input value={cacheRead} onChange={(e) => setCacheRead(e.target.value)} placeholder="= input" className={field + " mt-1 block"} /></label>
      <label className="text-xs text-slate-600" title="Leave empty if the provider bills cache writes at the normal input price">Cache write $/M<input value={cacheWrite} onChange={(e) => setCacheWrite(e.target.value)} placeholder="= input" className={field + " mt-1 block"} /></label>
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

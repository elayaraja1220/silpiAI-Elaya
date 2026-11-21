"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Copy, ExternalLink, Eye, Globe, Loader2, Lock, MonitorPlay, Plus, Power, Server, ShieldCheck } from "lucide-react";

import { AdminGate } from "@/components/business/admin-gate";
import { Card } from "@/components/business/ui";
import { DEV_START_HEADER, DEV_START_WITHOUT_PAYMENT } from "@/lib/dev-flags"; // TEMP DEV
import type { DemoView } from "@/lib/demo/service";
import { cn, formatRelativeTime } from "@/lib/utils";

export type DemoOverview = { gateway: { running: boolean; port: number | null; error?: string }; publicBase: string; local: boolean; port: number };
type Reply = DemoOverview & { success?: boolean; error?: string; demos: DemoView[] };

/** Team-only calls. On this computer the demo switch (dev-flags.ts) lets them through; otherwise the admin sign-in applies. */
export async function demoApi(url: string, init: RequestInit = {}): Promise<Reply> {
  const dev: Record<string, string> = DEV_START_WITHOUT_PAYMENT ? { [DEV_START_HEADER]: "1" } : {};
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...dev, ...(init.headers as Record<string, string> | undefined) } });
  const data = (await res.json().catch(() => ({}))) as Reply;
  if (!res.ok || data.success === false) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const DAYS = [3, 7, 14, 30];
const date = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

const STATUS: Record<DemoView["status"], string> = {
  live: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  expired: "border-white/10 bg-white/[.05] text-slate-400",
  stopped: "border-white/10 bg-white/[.05] text-slate-400",
};

/** Demo preview of a project: make a private link, see every demo, stop one. Several can be live at once. */
export function DemoPanel({ leadId, clientName, hasProject }: { leadId: string; clientName: string; hasProject: boolean }) {
  return (
    <Card className="no-print space-y-5">
      {DEV_START_WITHOUT_PAYMENT ? (
        <Body leadId={leadId} clientName={clientName} hasProject={hasProject} />
      ) : (
        <AdminGate label="demo previews">
          <Body leadId={leadId} clientName={clientName} hasProject={hasProject} />
        </AdminGate>
      )}
    </Card>
  );
}

function Body({ leadId, clientName, hasProject }: { leadId: string; clientName: string; hasProject: boolean }) {
  const base = `/api/demo/leads/${leadId}`;
  const [data, setData] = useState<Reply | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [label, setLabel] = useState(clientName);
  const [days, setDays] = useState(7);
  const [password, setPassword] = useState("");
  const [showToClient, setShowToClient] = useState(true);
  const [publicUrl, setPublicUrl] = useState("");

  const load = useCallback(() => {
    demoApi(base).then((r) => { setData(r); setError(""); }).catch((e: Error) => setError(e.message));
  }, [base]);
  useEffect(load, [load]);
  useEffect(() => { if (data && !data.local) setPublicUrl(data.publicBase); }, [data]);

  const run = async (name: string, fn: () => Promise<Reply>) => {
    setBusy(name);
    setError("");
    try { setData(await fn()); } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  };
  const create = () => run("create", async () => {
    const r = await demoApi(base, { method: "POST", body: JSON.stringify({ label, days, password, showToClient }) });
    setPassword("");
    return r;
  });
  const stop = (id: string) => run(id, () => demoApi(`${base}?demoId=${id}`, { method: "DELETE" }));
  const savePublic = () => run("public", async () => { await demoApi("/api/demo/settings", { method: "PUT", body: JSON.stringify({ publicUrl }) }); return demoApi(base); });

  if (!data) return <p className="flex items-center gap-2 text-sm text-slate-400">{error ? <span className="text-rose-300">{error}</span> : <><Loader2 size={15} className="animate-spin" /> Loading...</>}</p>;

  const live = data.demos.filter((d) => d.status === "live");
  const past = data.demos.filter((d) => d.status !== "live");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-100"><MonitorPlay size={16} className="text-violet-300" /> Demo preview</p>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-400">
            Show the client the website before they pay the balance, through a private link that ends by itself. It is view-only, marked as a demo, and has none of your source code or keys. Several projects can have a demo open at the same time.
          </p>
        </div>
        <span className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium", data.gateway.running ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : "border-amber-400/30 bg-amber-400/10 text-amber-200")}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" /> {data.gateway.running ? `Demo server on port ${data.gateway.port}` : "Demo server stopped"}
        </span>
      </div>

      {data.gateway.error && <p className="rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">{data.gateway.error}</p>}
      {error && <p className="rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</p>}

      {/* Where the client opens it from */}
      <section className={cn("space-y-2.5 rounded-xl border p-4", data.local ? "border-amber-400/25 bg-amber-500/[.06]" : "border-emerald-400/20 bg-emerald-500/[.04]")}>
        <p className="flex items-center gap-2 text-xs font-semibold text-slate-100"><Globe size={14} className={data.local ? "text-amber-300" : "text-emerald-300"} /> {data.local ? "Only you can open demo links right now" : "Clients open demos at"}</p>
        {data.local ? (
          <p className="text-[11px] leading-5 text-slate-300">
            The link is on this computer. To let the client open it, start a free tunnel while SILPI is running: <code className="rounded bg-black/40 px-1.5 py-0.5 text-slate-100">cloudflared tunnel --url http://localhost:{data.port}</code>, then paste the https address it prints here.
          </p>
        ) : (
          <p className="text-[11px] text-slate-400">Make sure the tunnel or host is running whenever the client looks.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <input value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} placeholder="https://your-tunnel.trycloudflare.com" aria-label="Public address" className="min-w-0 flex-1 rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-violet-400/60" />
          <button type="button" disabled={busy === "public" || publicUrl.trim() === (data.local ? "" : data.publicBase)} onClick={savePublic} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-200 hover:bg-white/5 disabled:opacity-40">
            {busy === "public" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save address
          </button>
        </div>
      </section>

      {/* Make one */}
      {hasProject ? (
        <section className="space-y-3 rounded-xl border border-white/[.08] bg-white/[.02] p-4">
          <p className="text-xs font-semibold text-slate-100">Create a demo link</p>
          <div className="grid gap-3 sm:grid-cols-[1fr_140px_1fr]">
            <label className="block text-[11px] text-slate-400">Shown on the demo as
              <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} className="mt-1 w-full rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-xs text-slate-100 outline-none focus:border-violet-400/60" />
            </label>
            <label className="block text-[11px] text-slate-400">Ends after
              <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-white/[.08] bg-[#121620] px-3 py-2 text-xs text-slate-100 outline-none focus:border-violet-400/60">
                {DAYS.map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </label>
            <label className="block text-[11px] text-slate-400">Password (optional)
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={64} autoComplete="new-password" placeholder="4 or more characters" className="mt-1 w-full rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-violet-400/60" />
            </label>
          </div>
          <label className="flex items-center gap-2 text-[11px] text-slate-300"><input type="checkbox" checked={showToClient} onChange={(e) => setShowToClient(e.target.checked)} className="accent-violet-500" /> Also show the link on the client&apos;s quotation page{data.local ? " (once a public address is set)" : ""}</label>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" disabled={busy === "create" || !label.trim()} onClick={create} className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-500 to-indigo-500 px-5 py-2.5 text-xs font-semibold text-white shadow-lg shadow-violet-500/25 transition hover:brightness-110 disabled:opacity-50">
              {busy === "create" ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create demo link
            </button>
            {busy === "create" && <span className="text-[11px] text-slate-400">Copying the website, removing private values and checking every link. This can take a minute.</span>}
          </div>
        </section>
      ) : (
        <p className="rounded-xl border border-white/[.08] bg-white/[.02] p-4 text-xs text-slate-400">Generate the project first. A demo can be made once there is a website to show.</p>
      )}

      {/* This project's demos */}
      {live.length > 0 && (
        <section className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-[.15em] text-slate-500">Live demos ({live.length})</p>
          {live.map((d) => <DemoCard key={d.id} demo={d} local={data.local} busy={busy === d.id} onStop={() => stop(d.id)} />)}
        </section>
      )}
      {past.length > 0 && (
        <section className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-[.15em] text-slate-500">Ended</p>
          {past.slice(0, 4).map((d) => (
            <p key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[.06] px-3 py-2 text-[11px] text-slate-500">
              <span>{d.label} · {d.status === "stopped" ? "stopped" : "expired"} · {d.views} view{d.views === 1 ? "" : "s"}</span>
              <span>{date(d.createdAt)}</span>
            </p>
          ))}
        </section>
      )}
    </div>
  );
}

/** One demo: its link, how it is going, what was found, and the stop button. */
export function DemoCard({ demo: d, local, busy, onStop, compact = false }: { demo: DemoView; local: boolean; busy?: boolean; onStop?: () => void; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [preview, setPreview] = useState(false);
  const r = d.report;
  const copy = async () => { try { await navigator.clipboard.writeText(d.url); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* the link is shown anyway */ } };

  return (
    <div className="space-y-3 rounded-xl border border-white/[.08] bg-black/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="truncate text-sm font-semibold text-slate-100">{d.label}</p>
          <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize", STATUS[d.status])}>{d.status}</span>
          <span className="flex items-center gap-1 rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-slate-400"><Server size={10} /> {d.mode === "app" ? "Runs as an app" : "Static copy"} · {d.framework}</span>
          {d.protected && <span className="flex items-center gap-1 rounded-full border border-violet-400/30 bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-200"><Lock size={10} /> Password</span>}
        </div>
        <p className="flex items-center gap-3 text-[11px] text-slate-500">
          <span className="flex items-center gap-1"><Eye size={12} /> {d.views} view{d.views === 1 ? "" : "s"}{d.lastViewAt ? ` · last ${formatRelativeTime(d.lastViewAt)}` : ""}</span>
          <span>Ends {date(d.expiresAt)}</span>
        </p>
      </div>

      {!compact && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-white/[.07] bg-black/30 px-3 py-2 text-[11px] text-slate-300" title={d.url}>{d.url}</code>
            <button type="button" onClick={copy} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-[11px] text-slate-200 hover:bg-white/5">{copied ? <Check size={13} className="text-emerald-300" /> : <Copy size={13} />} {copied ? "Copied" : "Copy link"}</button>
            <a href={d.previewUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-[11px] text-slate-200 hover:bg-white/5"><ExternalLink size={13} /> Open</a>
            <button type="button" onClick={() => setPreview(!preview)} className="rounded-lg px-3 py-2 text-[11px] text-violet-300 hover:bg-violet-500/10">{preview ? "Hide preview" : "Preview here"}</button>
          </div>
          {local && <p className="text-[11px] text-amber-200">This link opens only on this computer until a public address is set above.</p>}
          {preview && (
            <iframe title={`Preview of ${d.label}`} src={d.previewUrl} sandbox="allow-scripts allow-same-origin allow-forms" className="h-[520px] w-full rounded-lg border border-white/10 bg-white" />
          )}

          {/* What the check found */}
          <div className="space-y-1.5 text-[11px]">
            {r.checked && r.broken.length === 0 && <p className="flex items-center gap-1.5 text-emerald-300"><CheckCircle2 size={13} /> {r.pages} page{r.pages === 1 ? "" : "s"} checked, every link works.</p>}
            {r.broken.length > 0 && (
              <div className="rounded-lg border border-rose-400/25 bg-rose-500/[.08] p-3 text-rose-200">
                <p className="flex items-center gap-1.5 font-semibold"><AlertTriangle size={13} /> {r.broken.length} link{r.broken.length === 1 ? "" : "s"} do not load. The client would see an error page:</p>
                <ul className="mt-1.5 space-y-0.5">{r.broken.slice(0, 8).map((b) => <li key={b.path + b.from}><code>{b.path}</code> <span className="text-rose-300/70">(linked from {b.from})</span></li>)}</ul>
              </div>
            )}
            {r.unverified.length > 0 && <p className="text-amber-200">{r.unverified.length} page{r.unverified.length === 1 ? " is" : "s are"} drawn in the browser, so they could not be checked ahead of time. Click through them once yourself.</p>}
            {r.truncated && <p className="text-slate-400">Only the first pages were checked.</p>}
            {r.warnings.map((w) => <p key={w} className="flex items-start gap-1.5 text-amber-200"><ShieldCheck size={13} className="mt-0.5 shrink-0" /> {w}</p>)}
          </div>

          {onStop && (
            <div className="flex flex-wrap items-center gap-2 border-t border-white/[.06] pt-3">
              {!confirm ? (
                <button type="button" onClick={() => setConfirm(true)} disabled={busy} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"><Power size={13} /> Stop this demo</button>
              ) : (
                <>
                  <span className="text-[11px] text-slate-300">The link stops working at once and the copy is deleted.</span>
                  <button type="button" onClick={onStop} disabled={busy} className="flex items-center gap-1.5 rounded-lg bg-rose-500 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-rose-400 disabled:opacity-50">{busy ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />} Yes, stop it</button>
                  <button type="button" onClick={() => setConfirm(false)} className="rounded-lg px-3 py-1.5 text-[11px] text-slate-400 hover:bg-white/5">Cancel</button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

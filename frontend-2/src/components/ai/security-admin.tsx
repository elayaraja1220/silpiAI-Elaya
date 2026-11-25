"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { api, Button, Card, inputClass, Notice, Pill } from "./light";

type Check = { id: string; label: string; level: "ok" | "warn" | "fail"; detail: string; fix?: string };
type Readiness = { production: boolean; summary: { ok: number; warn: number; fail: number }; checks: Check[] };
type Account = { id: string; email: string; name: string; role: "admin" | "viewer"; status: "active" | "disabled"; createdAt: string; createdBy: string; lastLoginAt: string | null };

const TONE = { ok: "green", warn: "amber", fail: "red" } as const;
const WORD = { ok: "ready", warn: "needs attention", fail: "fix before launch" } as const;

/** Is this ready for real customers, and who can sign in as an administrator. */
export function SecurityAdmin({ onNote, onError }: { onNote: (m: string) => void; onError: (e: unknown) => void }) {
  return (
    <div className="space-y-5">
      <Launch onError={onError} />
      <Accounts onNote={onNote} onError={onError} />
    </div>
  );
}

function Launch({ onError }: { onError: (e: unknown) => void }) {
  const [r, setR] = useState<Readiness | null>(null);
  const load = useCallback(() => { api<{ readiness: Readiness }>("/api/admin/readiness").then((x) => setR(x.readiness)).catch(onError); }, [onError]);
  useEffect(load, [load]);
  if (!r) return <Card className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Checking...</Card>;
  const order = { fail: 0, warn: 1, ok: 2 } as const;
  const checks = [...r.checks].sort((a, b) => order[a.level] - order[b.level]);
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-slate-900">Launch checklist</h2>
        <Pill tone="red">{r.summary.fail} to fix</Pill>
        <Pill tone="amber">{r.summary.warn} need attention</Pill>
        <Pill tone="green">{r.summary.ok} ready</Pill>
        <Button variant="ghost" className="ml-auto px-3 py-1.5" onClick={load}>Check again</Button>
      </div>
      <p className="text-xs leading-5 text-slate-600">This looks only at this server&apos;s own settings and data. It cannot tell whether your HTTPS certificate is valid, whether backups are copied off this machine, or whether a payment account is approved. Items marked &quot;needs attention&quot; are not all required: read each one.</p>
      <ul className="divide-y divide-slate-100">
        {checks.map((c) => (
          <li key={c.id} className="space-y-0.5 py-2.5 text-sm">
            <div className="flex flex-wrap items-center gap-2"><Pill tone={TONE[c.level]}>{WORD[c.level]}</Pill><span className="font-medium text-slate-900">{c.label}</span></div>
            <p className="text-slate-600">{c.detail}</p>
            {c.level !== "ok" && c.fix && <p className="text-xs text-slate-500">To fix: {c.fix}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Accounts({ onNote, onError }: { onNote: (m: string) => void; onError: (e: unknown) => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [f, setF] = useState({ email: "", name: "", password: "", role: "admin" });
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api<{ accounts: Account[] }>("/api/admin/admins").then((r) => setAccounts(r.accounts)).catch(onError); }, [onError]);
  useEffect(load, [load]);
  if (!accounts) return null;
  const create = async () => {
    setBusy(true);
    try { await api("/api/admin/admins", { method: "POST", body: f }); setF({ email: "", name: "", password: "", role: "admin" }); onNote("Account created."); load(); } catch (e) { onError(e); } finally { setBusy(false); }
  };
  const update = (id: string, body: object, note: string) => api("/api/admin/admins", { method: "PUT", body: { id, ...body } }).then(() => { onNote(note); load(); }).catch(onError);
  const resetPassword = (a: Account) => {
    const password = window.prompt(`New password for ${a.email} (at least 12 characters):`);
    if (password) void update(a.id, { password }, "Password changed.");
  };
  const sel = "rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500";
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Administrator accounts</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">Give each person their own account so the audit log shows who did what. <b>Admin</b> can do everything; <b>Viewer</b> can look at everything and change nothing. The administrator token keeps working as the way in before any account exists and as an emergency way back; its actions are recorded as &quot;admin&quot;. Accounts are disabled, never deleted, so old log entries still make sense. You cannot disable or demote the last active administrator.</p>
      </div>
      {accounts.length === 0 ? <p className="text-sm text-slate-500">No accounts yet.</p> : (
        <ul className="divide-y divide-slate-100 text-sm">
          {accounts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <div className="min-w-48"><p className="font-medium text-slate-900">{a.name}</p><p className="text-xs text-slate-500">{a.email}</p></div>
              <Pill tone={a.role === "admin" ? "indigo" : "slate"}>{a.role}</Pill>
              {a.status === "disabled" && <Pill tone="red">disabled</Pill>}
              <span className="text-xs text-slate-400">{a.lastLoginAt ? `last sign-in ${a.lastLoginAt.slice(0, 10)}` : "never signed in"}</span>
              <span className="ml-auto flex flex-wrap gap-2">
                <Button variant="ghost" className="px-3 py-1.5" onClick={() => update(a.id, { role: a.role === "admin" ? "viewer" : "admin" }, "Role changed.")}>Make {a.role === "admin" ? "viewer" : "admin"}</Button>
                <Button variant="ghost" className="px-3 py-1.5" onClick={() => resetPassword(a)}>New password</Button>
                <Button variant="ghost" className="px-3 py-1.5" onClick={() => update(a.id, { status: a.status === "active" ? "disabled" : "active" }, a.status === "active" ? "Account disabled." : "Account enabled.")}>{a.status === "active" ? "Disable" : "Enable"}</Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <label className="text-xs text-slate-600">Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className={inputClass + " mt-1 block !w-40"} aria-label="Account name" /></label>
        <label className="text-xs text-slate-600">Email<input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} className={inputClass + " mt-1 block !w-56"} aria-label="Account email" /></label>
        <label className="text-xs text-slate-600">Password (12+ characters)<input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" className={inputClass + " mt-1 block !w-56"} aria-label="Account password" /></label>
        <label className="text-xs text-slate-600">Role<select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} className={sel + " mt-1 block"} aria-label="Account role"><option value="admin">Admin</option><option value="viewer">Viewer</option></select></label>
        <Button onClick={() => void create()} disabled={busy || !f.name.trim() || !f.email.trim() || f.password.length < 12}>{busy && <Loader2 size={15} className="animate-spin" />} Create account</Button>
      </div>
    </Card>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Loader2, LogOut } from "lucide-react";

import { Card, Field, Input } from "@/components/business/ui";

type Me = { user: { name: string; email: string }; organization: { name: string; type: string }; role: string };

/** Sign-in for organization members. Standalone page (no admin sidebar): the agency screens are unchanged. */
export default function LoginPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => setMe(b?.success ? (b as Me) : null))
      .catch(() => setMe(null))
      .finally(() => setChecking(false));
  useEffect(() => { void load(); }, []);

  const post = async (url: string, body?: object) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const b = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string };
    if (!r.ok || !b.success) throw new Error(b.error || "Something went wrong.");
  };
  const signIn = async () => {
    setBusy(true);
    setError("");
    try {
      await post("/api/auth/login", { email, password });
      setPassword("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    await post("/api/auth/logout").catch(() => {});
    setMe(null);
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <Card className="w-full space-y-4">
        <h1 className="text-lg font-semibold text-slate-100">SILPI AI</h1>
        {checking ? (
          <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 size={15} className="animate-spin" /> Checking...</p>
        ) : me ? (
          <div className="space-y-3 text-sm text-slate-300">
            <p>Signed in as <span className="font-semibold text-slate-100">{me.user.name}</span> ({me.user.email}).</p>
            <p>Organization: <span className="text-slate-100">{me.organization.name}</span> · role: <span className="text-slate-100">{me.role}</span></p>
            <button onClick={signOut} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-300 hover:bg-white/5"><LogOut size={13} /> Sign out</button>
          </div>
        ) : (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void signIn(); }}>
            <Field label="Email"><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
            <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
            {error && <p className="text-xs text-rose-300" role="alert">{error}</p>}
            <button type="submit" disabled={busy || !email || !password} className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-violet-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-400 disabled:opacity-50">
              {busy && <Loader2 size={14} className="animate-spin" />} Sign in
            </button>
            <p className="text-[11px] text-slate-500">Accounts are created by the administrator for now.</p>
          </form>
        )}
      </Card>
    </main>
  );
}

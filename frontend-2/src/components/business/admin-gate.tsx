"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2, Lock, LogOut } from "lucide-react";

import { Card, jsonFetch } from "./ui";

const SESSION_CHANGED = "silpi:admin-session-changed";

type Session = { loading: boolean; configured: boolean; authenticated: boolean };

/**
 * Execution screens are for the administrator only. This asks the server whether the browser is signed in and, if
 * not, shows a sign-in form. The admin token is sent once to the server and exchanged for a signed session cookie
 * that the page cannot read; it is never kept in the browser.
 */
export function AdminGate({ children, label = "this section" }: { children: ReactNode; label?: string }) {
  const [session, setSession] = useState<Session>({ loading: true, configured: true, authenticated: false });
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    jsonFetch<{ configured: boolean; authenticated: boolean }>("/api/admin/session")
      .then((r) => setSession({ loading: false, configured: r.configured, authenticated: r.authenticated }))
      .catch(() => setSession({ loading: false, configured: true, authenticated: false }));
  }, []);
  useEffect(refresh, [refresh]);
  // Every gate on a page shares the one browser session: when one signs in or out, the others re-check.
  useEffect(() => {
    window.addEventListener(SESSION_CHANGED, refresh);
    return () => window.removeEventListener(SESSION_CHANGED, refresh);
  }, [refresh]);

  const signIn = async () => {
    setBusy(true);
    setError("");
    try {
      await jsonFetch("/api/admin/session", { method: "POST", body: JSON.stringify({ token }) });
      setToken("");
      window.dispatchEvent(new Event(SESSION_CHANGED));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    await jsonFetch("/api/admin/session", { method: "DELETE" }).catch(() => {});
    window.dispatchEvent(new Event(SESSION_CHANGED));
  };

  if (session.loading) return <Card className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={14} className="animate-spin" /> Checking admin sign-in...</Card>;
  if (!session.configured) {
    return (
      <Card className="space-y-2 border-amber-400/25 text-xs text-amber-100" data-gate="not-configured">
        <p className="flex items-center gap-2 font-semibold"><Lock size={14} /> Admin sign-in is not set up</p>
        <p className="text-slate-300">
          {label[0].toUpperCase() + label.slice(1)} is protected. Add <code className="rounded bg-white/10 px-1">SILPI_ADMIN_TOKEN=</code> (a long secret, 16+ characters) to <code className="rounded bg-white/10 px-1">frontend-2/.env.local</code> and restart the server. Until then it stays closed.
        </p>
      </Card>
    );
  }
  if (!session.authenticated) {
    return (
      <Card className="space-y-3 text-xs" data-gate="sign-in">
        <p className="flex items-center gap-2 font-semibold text-slate-100"><Lock size={14} className="text-violet-300" /> Admin sign-in</p>
        <p className="text-slate-400">{label[0].toUpperCase() + label.slice(1)} is for the administrator. Enter the admin token from your server settings.</p>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void signIn(); }}>
          <input type="password" autoComplete="off" aria-label="Admin token" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Admin token" className="min-w-0 flex-1 rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-xs text-slate-100 outline-none focus:border-violet-400/60" />
          <button type="submit" disabled={busy || !token} className="flex items-center gap-1.5 rounded-lg bg-violet-500 px-4 py-2 font-semibold text-white hover:bg-violet-400 disabled:opacity-50">{busy && <Loader2 size={13} className="animate-spin" />} Sign in</button>
        </form>
        {error && <p className="text-rose-300">{error}</p>}
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {children}
      <button type="button" onClick={signOut} className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-white"><LogOut size={11} /> Sign out of admin</button>
    </div>
  );
}

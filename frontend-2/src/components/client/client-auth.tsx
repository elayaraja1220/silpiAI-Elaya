"use client";

import Link from "next/link";
import { Suspense, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Command, Facebook, Loader2, Mail } from "lucide-react";

import { CLIENT_HOME } from "@/lib/client-auth";
import { isOAuthError, OAUTH_ERRORS } from "@/lib/oauth-providers";
import { cleanAddress, forgetEntry, readEntry } from "@/lib/clean-address";

type Mode = "signin" | "signup" | "forgot";
const NEXT_KEY = "silpi:sign-in-next";
type Me = { user: { name: string; email: string } };

async function post(url: string, body: object): Promise<{ message?: string }> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const b = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string; message?: string };
  if (!r.ok || !b.success) throw new Error(b.error || "Something went wrong. Please try again.");
  return b;
}

const field = "mt-1 block w-full rounded-lg border border-white/10 bg-white/[.04] px-3 py-2.5 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-violet-400 focus:ring-2 focus:ring-violet-400/30";
const primary = "inline-flex w-full items-center justify-center gap-2 rounded-lg bg-violet-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-violet-900/30 transition hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50";

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0e1118] px-4 py-10 text-[#f5f6fb]">
      <div className="w-full max-w-md">
        <Link href="/ai" className="mb-6 flex items-center justify-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#a89bff] to-[#6c5ce7] text-[#11131b] shadow-lg shadow-violet-500/20"><Command size={20} /></span>
          <span className="text-lg font-semibold tracking-[.12em]">SILPI<span className="text-violet-300"> AI</span></span>
        </Link>
        <div className="rounded-2xl border border-white/[.08] bg-[#121622] p-6 shadow-[0_8px_30px_-12px_rgba(0,0,0,.6)] sm:p-8">{children}</div>
        <p className="mt-5 text-center text-xs text-slate-500">By continuing you agree to the <Link href="/terms" className="underline hover:text-slate-300">Terms of Service</Link> and <Link href="/privacy" className="underline hover:text-slate-300">Privacy Policy</Link>.</p>
      </div>
    </main>
  );
}

function Social({ next }: { next: string }) {
  // Which methods work right now comes from the server (it knows whether the studio has set them up); a method that is not set up is shown switched off, with the reason.
  const [on, setOn] = useState<{ google: boolean; facebook: boolean } | null>(null);
  useEffect(() => { fetch("/api/auth/providers", { cache: "no-store" }).then((r) => r.json()).then((b: { google?: boolean; facebook?: boolean }) => setOn({ google: !!b.google, facebook: !!b.facebook })).catch(() => setOn({ google: false, facebook: false })); }, []);
  const look = "flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 px-4 py-2.5 text-sm transition";
  const items = [{ id: "google" as const, label: "Continue with Google", icon: <Mail size={16} /> }, { id: "facebook" as const, label: "Continue with Facebook", icon: <Facebook size={16} /> }];
  return (
    <div className="space-y-2" data-testid="social">
      {items.map((i) => on?.[i.id]
        ? <a key={i.id} href={`/api/auth/oauth/${i.id}/start?next=${encodeURIComponent(next)}`} className={look + " text-slate-100 hover:border-violet-400/60 hover:bg-white/[.05]"}>{i.icon} {i.label}</a>
        : <button key={i.id} type="button" disabled aria-disabled="true" className={look + " cursor-not-allowed text-slate-400 opacity-60"}>{i.icon} {i.label}</button>)}
      {on && !on.google && !on.facebook && <p className="text-center text-[11px] text-slate-500">Google and Facebook sign-in are not set up yet. Use your email below.</p>}
    </div>
  );
}

function Inner() {
  const params = useSearchParams();
  // Read once: where to go afterwards (only a path on this site), which tab to open and any sign-in error. Then the address bar shows a plain /sign-in.
  const [entry] = useState(() => readEntry(params, NEXT_KEY, CLIENT_HOME));
  const next = entry.next;
  useEffect(() => cleanAddress(), []);
  const [mode, setMode] = useState<Mode>(entry.mode === "signup" ? "signup" : "signin");
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  // A failed social sign-in comes back with a short code; only known codes are shown, and what is shown is our own wording.
  const code = entry.error;
  const [socialError, setSocialError] = useState(isOAuthError(code) ? OAUTH_ERRORS[code] : "");

  useEffect(() => { fetch("/api/auth/me", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((b) => setMe(b?.success ? (b as Me) : null)).catch(() => setMe(null)); }, []);
  const go = () => { forgetEntry(NEXT_KEY); window.location.assign(next); };
  const switchTo = (m: Mode) => { setMode(m); setError(""); setInfo(""); setSocialError(""); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setInfo("");
    try {
      if (mode === "signin") { await post("/api/auth/login", { email, password }); go(); }
      else if (mode === "signup") { await post("/api/auth/signup", { name, email, password, acceptTerms: accept }); go(); }
      else { const r = await post("/api/auth/forgot", { email }); setInfo(r.message ?? "Check your email."); }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (me === undefined) return <Shell><div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading...</div></Shell>;
  if (me) {
    return (
      <Shell>
        <div className="space-y-4 text-center">
          <CheckCircle2 className="mx-auto text-emerald-400" size={28} />
          <p className="text-sm text-slate-300">You are signed in as <b className="text-white">{me.user.name}</b> ({me.user.email}).</p>
          <button type="button" onClick={go} className={primary}>Continue</button>
          <button type="button" onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined); setMe(null); }} className="text-xs text-slate-400 underline hover:text-slate-200">Sign out and use another account</button>
        </div>
      </Shell>
    );
  }

  const heading = mode === "signin" ? "Sign in to SILPI AI" : mode === "signup" ? "Create your account" : "Reset your password";
  const sub = mode === "signin" ? "Welcome back. Continue to get your quotation or open the AI workspace." : mode === "signup" ? "One account for fixed-price projects and the AI workspace." : "Enter your email and we will send you a link to choose a new password.";
  return (
    <Shell>
      <h1 className="text-xl font-semibold tracking-tight">{heading}</h1>
      <p className="mt-1 text-sm text-slate-400">{sub}</p>

      {mode !== "forgot" && (
        <div role="tablist" aria-label="Sign in or create an account" className="mt-5 grid grid-cols-2 gap-1 rounded-xl border border-white/10 bg-white/[.03] p-1">
          {(["signin", "signup"] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} type="button" onClick={() => switchTo(m)} className={"rounded-lg px-3 py-2 text-sm font-medium transition " + (mode === m ? "bg-violet-500 text-white" : "text-slate-400 hover:text-slate-200")}>{m === "signin" ? "Sign in" : "Create account"}</button>
          ))}
        </div>
      )}

      {mode !== "forgot" && <div className="mt-5">{socialError && <p role="alert" className="mb-4 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{socialError}</p>}<Social next={next} /><div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-wider text-slate-600"><span className="h-px flex-1 bg-white/10" />or with email<span className="h-px flex-1 bg-white/10" /></div></div>}

      <form onSubmit={(e) => void submit(e)} className={mode === "forgot" ? "mt-5 space-y-4" : "space-y-4"} noValidate>
        {mode === "signup" && (
          <label className="block text-xs font-medium text-slate-300">Full name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} className={field} placeholder="Your name" /></label>
        )}
        <label className="block text-xs font-medium text-slate-300">Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" className={field} placeholder="you@example.com" /></label>
        {mode !== "forgot" && (
          <label className="block text-xs font-medium text-slate-300">Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"} className={field} placeholder={mode === "signup" ? "At least 10 characters" : "Your password"} /></label>
        )}
        {mode === "signup" && (
          <label className="flex items-start gap-2 text-xs text-slate-400">
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-white/20 accent-violet-500" />
            <span>I accept the <Link href="/terms" target="_blank" className="underline hover:text-slate-200">Terms of Service</Link> and the <Link href="/privacy" target="_blank" className="underline hover:text-slate-200">Privacy Policy</Link>.</span>
          </label>
        )}
        {error && <p role="alert" className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</p>}
        {info && <p role="status" className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">{info}</p>}
        <button type="submit" disabled={busy || !email || (mode !== "forgot" && !password) || (mode === "signup" && (!name || !accept))} className={primary}>
          {busy && <Loader2 size={15} className="animate-spin" />}{mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send reset link"}
        </button>
      </form>

      <div className="mt-4 text-center text-xs text-slate-500">
        {mode === "signin" && <button type="button" onClick={() => switchTo("forgot")} className="underline hover:text-slate-300">Forgot password?</button>}
        {mode === "forgot" && <button type="button" onClick={() => switchTo("signin")} className="underline hover:text-slate-300">Back to sign in</button>}
      </div>
    </Shell>
  );
}

export function ClientAuth() {
  return <Suspense fallback={null}><Inner /></Suspense>;
}

/** Choose a new password from the link in the reset e-mail. */
export function ResetPassword() {
  return <Suspense fallback={null}><ResetInner /></Suspense>;
}

function ResetInner() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== again) { setError("The two passwords are not the same."); return; }
    setBusy(true);
    setError("");
    try { await post("/api/auth/reset", { token, password }); setDone(true); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Shell>
      {done ? (
        <div className="space-y-4 text-center">
          <CheckCircle2 className="mx-auto text-emerald-400" size={28} />
          <h1 className="text-xl font-semibold">Password changed</h1>
          <p className="text-sm text-slate-400">You have been signed out everywhere. Sign in with your new password.</p>
          <Link href="/sign-in" className={primary}>Go to sign in</Link>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
          <h1 className="text-xl font-semibold tracking-tight">Choose a new password</h1>
          {!token && <p role="alert" className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">This link is missing its code. Open the link from the email again, or ask for a new one.</p>}
          <label className="block text-xs font-medium text-slate-300">New password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className={field} placeholder="At least 10 characters" /></label>
          <label className="block text-xs font-medium text-slate-300">Repeat the new password<input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" className={field} /></label>
          {error && <p role="alert" className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</p>}
          <button type="submit" disabled={busy || !token || !password || !again} className={primary}>{busy && <Loader2 size={15} className="animate-spin" />}Change password</button>
          <p className="text-center text-xs text-slate-500"><Link href="/sign-in" className="underline hover:text-slate-300">Back to sign in</Link></p>
        </form>
      )}
    </Shell>
  );
}

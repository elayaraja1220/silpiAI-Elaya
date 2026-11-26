"use client";

import Link from "next/link";
import { Suspense, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Command, FileText, Loader2, Lock, ShieldCheck, Sparkles } from "lucide-react";

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

const field = "mt-1.5 block w-full rounded-xl border border-white/10 bg-white/[.04] px-3.5 py-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 hover:border-white/20 focus:border-violet-400 focus:bg-white/[.06] focus:ring-4 focus:ring-violet-500/15";
const primary = "inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-500 to-indigo-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-violet-900/40 transition hover:from-violet-400 hover:to-indigo-400 focus:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/30 disabled:cursor-not-allowed disabled:opacity-50";

/** The official Google mark (four colours). */
function GoogleMark() {
  return (
    <svg aria-hidden width="18" height="18" viewBox="0 0 48 48">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

/** The official Facebook mark (white "f" on the brand blue circle). */
function FacebookMark() {
  return (
    <svg aria-hidden width="18" height="18" viewBox="0 0 24 24">
      <path fill="#1877F2" d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.69.24 2.69.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z" />
      <path fill="#fff" d="M16.67 15.56l.53-3.49h-3.33V9.82c0-.96.47-1.89 1.96-1.89h1.51V4.96s-1.38-.24-2.69-.24c-2.74 0-4.53 1.67-4.53 4.69v2.66H7.08v3.49h3.05V24a12.1 12.1 0 003.74 0v-8.44h2.8z" />
    </svg>
  );
}

function Logo({ className = "" }: { className?: string }) {
  return (
    <Link href="/ai" className={`flex items-center gap-3 ${className}`} aria-label="SILPI AI home">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#a89bff] to-[#6c5ce7] text-[#11131b] shadow-lg shadow-violet-500/30"><Command size={20} /></span>
      <span className="text-lg font-semibold tracking-[.12em]">SILPI<span className="text-violet-300"> AI</span></span>
    </Link>
  );
}

/** The left half on a wide screen: what SILPI AI offers, so the page explains itself while the person signs in. */
function BrandPanel() {
  return (
    <aside className="relative hidden overflow-hidden border-r border-white/[.06] bg-[#0b0d14] lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16" data-testid="brand-panel">
      <div aria-hidden className="pointer-events-none absolute -left-40 -top-40 h-[520px] w-[520px] rounded-full bg-violet-600/25 blur-[120px]" />
      <div aria-hidden className="pointer-events-none absolute -bottom-48 right-[-120px] h-[460px] w-[460px] rounded-full bg-indigo-500/20 blur-[120px]" />
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[.04] [background-image:linear-gradient(#fff_1px,transparent_1px),linear-gradient(90deg,#fff_1px,transparent_1px)] [background-size:44px_44px]" />
      <Logo className="relative" />
      <div className="relative max-w-md">
        <h2 className="text-4xl font-semibold leading-tight tracking-tight">Build your next project <span className="bg-gradient-to-r from-violet-300 to-indigo-300 bg-clip-text text-transparent">with SILPI AI</span></h2>
        <p className="mt-4 text-base leading-7 text-slate-400">One account for both ways of building.</p>
        <ul className="mt-8 space-y-4">
          <li className="flex gap-4 rounded-2xl border border-white/[.08] bg-white/[.03] p-4 backdrop-blur">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-300"><Sparkles size={18} /></span>
            <span><span className="block text-sm font-semibold text-slate-100">AI workspace</span><span className="mt-0.5 block text-sm text-slate-400">Build it yourself with AI, on a monthly or yearly plan.</span></span>
          </li>
          <li className="flex gap-4 rounded-2xl border border-white/[.08] bg-white/[.03] p-4 backdrop-blur">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300"><FileText size={18} /></span>
            <span><span className="block text-sm font-semibold text-slate-100">Fixed price project</span><span className="mt-0.5 block text-sm text-slate-400">We design and build it for you, with an agreed scope and budget.</span></span>
          </li>
        </ul>
      </div>
      <ul className="relative space-y-2.5 text-sm text-slate-400">
        <li className="flex items-center gap-2.5"><ShieldCheck size={16} className="text-violet-300" /> Nothing is charged until you approve a quotation or choose a plan</li>
        <li className="flex items-center gap-2.5"><Lock size={16} className="text-violet-300" /> Passwords are stored only as secure hashes, never as text</li>
      </ul>
    </aside>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-screen bg-[#0e1118] text-[#f5f6fb] lg:grid-cols-[1.05fr_1fr]">
      <BrandPanel />
      <section className="relative flex flex-col px-5 py-8 sm:px-10">
        <div aria-hidden className="pointer-events-none absolute right-0 top-0 h-72 w-72 rounded-full bg-violet-600/10 blur-[100px] lg:hidden" />
        <Logo className="relative lg:hidden" />
        <div className="relative mx-auto flex w-full max-w-[420px] flex-1 flex-col justify-center py-10">{children}</div>
        <p className="relative mx-auto max-w-[420px] text-center text-xs leading-5 text-slate-500">By continuing you agree to the <Link href="/terms" className="text-slate-400 underline underline-offset-2 hover:text-slate-200">Terms of Service</Link> and <Link href="/privacy" className="text-slate-400 underline underline-offset-2 hover:text-slate-200">Privacy Policy</Link>.</p>
      </section>
    </main>
  );
}

function Social({ next }: { next: string }) {
  // Which methods work right now comes from the server (it knows whether the studio has set them up); a method that is not set up is shown switched off, with the reason.
  const [on, setOn] = useState<{ google: boolean; facebook: boolean } | null>(null);
  useEffect(() => { fetch("/api/auth/providers", { cache: "no-store" }).then((r) => r.json()).then((b: { google?: boolean; facebook?: boolean }) => setOn({ google: !!b.google, facebook: !!b.facebook })).catch(() => setOn({ google: false, facebook: false })); }, []);
  const items = [
    { id: "google" as const, label: "Continue with Google", icon: <GoogleMark />, look: "border-white/15 bg-white text-slate-900 hover:bg-slate-100" },
    { id: "facebook" as const, label: "Continue with Facebook", icon: <FacebookMark />, look: "border-white/10 bg-white/[.04] text-slate-100 hover:border-white/20 hover:bg-white/[.07]" },
  ];
  const base = "flex w-full items-center justify-center gap-3 rounded-xl border px-4 py-3 text-sm font-medium transition focus:outline-none focus-visible:ring-4 focus-visible:ring-violet-500/30";
  return (
    <div className="space-y-2.5" data-testid="social">
      {items.map((i) => on?.[i.id]
        ? <a key={i.id} href={`/api/auth/oauth/${i.id}/start?next=${encodeURIComponent(next)}`} className={`${base} ${i.look}`}>{i.icon} {i.label}</a>
        : <button key={i.id} type="button" disabled aria-disabled="true" title="Not set up yet" className={`${base} ${i.look} cursor-not-allowed opacity-45`}>{i.icon} {i.label}</button>)}
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
      <h1 className="text-3xl font-semibold tracking-tight">{heading}</h1>
      <p className="mt-2 text-sm leading-6 text-slate-400">{sub}</p>

      {mode !== "forgot" && (
        <div role="tablist" aria-label="Sign in or create an account" className="mt-7 grid grid-cols-2 gap-1 rounded-xl border border-white/[.08] bg-black/20 p-1">
          {(["signin", "signup"] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} type="button" onClick={() => switchTo(m)} className={"rounded-lg px-3 py-2.5 text-sm font-medium transition " + (mode === m ? "bg-white/[.09] text-white shadow-sm ring-1 ring-white/10" : "text-slate-400 hover:text-slate-200")}>{m === "signin" ? "Sign in" : "Create account"}</button>
          ))}
        </div>
      )}

      {mode !== "forgot" && <div className="mt-6">{socialError && <p role="alert" className="mb-4 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{socialError}</p>}<Social next={next} /><div className="my-6 flex items-center gap-3 text-[11px] font-medium uppercase tracking-[.14em] text-slate-500"><span className="h-px flex-1 bg-white/10" />or with email<span className="h-px flex-1 bg-white/10" /></div></div>}

      <form onSubmit={(e) => void submit(e)} className={mode === "forgot" ? "mt-7 space-y-5" : "space-y-5"} noValidate>
        {mode === "signup" && (
          <label className="block text-[13px] font-medium text-slate-300">Full name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} className={field} placeholder="Your name" /></label>
        )}
        <label className="block text-[13px] font-medium text-slate-300">Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" className={field} placeholder="you@example.com" /></label>
        {mode === "signin" && <div className="-mb-3 flex justify-end"><button type="button" onClick={() => switchTo("forgot")} className="text-xs font-medium text-violet-300 hover:text-violet-200">Forgot password?</button></div>}
        {mode !== "forgot" && (
          <label className="block text-[13px] font-medium text-slate-300">Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"} className={field} placeholder={mode === "signup" ? "At least 10 characters" : "Your password"} /></label>
        )}
        {mode === "signup" && (
          <label className="flex items-start gap-2.5 text-[13px] leading-5 text-slate-400">
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

      <p className="mt-6 text-center text-sm text-slate-400">
        {mode === "signin" && <>New to SILPI AI? <button type="button" onClick={() => switchTo("signup")} className="font-medium text-violet-300 hover:text-violet-200">Create an account</button></>}
        {mode === "signup" && <>Already have an account? <button type="button" onClick={() => switchTo("signin")} className="font-medium text-violet-300 hover:text-violet-200">Sign in</button></>}
        {mode === "forgot" && <button type="button" onClick={() => switchTo("signin")} className="font-medium text-violet-300 hover:text-violet-200">Back to sign in</button>}
      </p>
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
          <label className="block text-[13px] font-medium text-slate-300">New password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className={field} placeholder="At least 10 characters" /></label>
          <label className="block text-[13px] font-medium text-slate-300">Repeat the new password<input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" className={field} /></label>
          {error && <p role="alert" className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</p>}
          <button type="submit" disabled={busy || !token || !password || !again} className={primary}>{busy && <Loader2 size={15} className="animate-spin" />}Change password</button>
          <p className="text-center text-xs text-slate-500"><Link href="/sign-in" className="underline hover:text-slate-300">Back to sign in</Link></p>
        </form>
      )}
    </Shell>
  );
}

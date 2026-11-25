"use client";

import { useState } from "react";
import Link from "next/link";
import { Eye, EyeOff, Loader2, ShieldCheck, Undo2, WalletCards } from "lucide-react";

import { api, Button, inputClass, Notice } from "./light";

const POINTS = [
  { icon: WalletCards, title: "Pay only for what you use", text: "You see the most a request could cost before you send it, and are charged the real cost after." },
  { icon: Undo2, title: "Failures are free", text: "If the AI fails or you cancel, the credits come straight back." },
  { icon: ShieldCheck, title: "Your work stays yours", text: "Chat prompts and answers are not stored by the gateway." },
];

/** The AI Gateway's own light sign-in. It uses the same accounts as the rest of SILPI, but never sends people to the dark workspace login. */
export function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!email.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: { email, password } });
      setPassword("");
      onDone();
    } catch (e) {
      setError((e as Error).message || "Could not sign in.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto grid max-w-4xl items-center gap-8 py-6 md:grid-cols-2 md:py-12">
      <div className="space-y-6">
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/silpi-mark-512.png" alt="SILPI AI" width={64} height={64} className="h-16 w-16" />
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-900">Welcome to SILPI AI</h1>
          <p className="mt-2 text-slate-600">Chat with AI models and build whole projects from a short description, paid with simple credits.</p>
        </div>
        <ul className="space-y-4">
          {POINTS.map((p) => (
            <li key={p.title} className="flex gap-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600"><p.icon size={16} /></span>
              <span><span className="block text-sm font-medium text-slate-900">{p.title}</span><span className="block text-sm leading-5 text-slate-600">{p.text}</span></span>
            </li>
          ))}
        </ul>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" aria-label="Sign in">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Sign in</h2>
          <p className="mt-0.5 text-sm text-slate-500">Use the account your administrator created for you.</p>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} autoComplete="email" autoFocus placeholder="you@company.com" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Password</span>
          <span className="relative block">
            <input type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass + " pr-10"} autoComplete="current-password" placeholder="Your password" />
            <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide password" : "Show password"} className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-slate-400 hover:text-slate-700">{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
          </span>
        </label>
        {error && <Notice tone="red">{error}</Notice>}
        <Button type="submit" className="w-full py-2.5" disabled={busy || !email.trim() || !password}>{busy && <Loader2 size={15} className="animate-spin" />} Sign in</Button>
        <p className="text-center text-xs text-slate-500">No account yet? Ask your administrator to create one. <Link href="/ai/admin" className="text-indigo-700 underline-offset-2 hover:underline">I am the administrator</Link></p>
      </form>
    </div>
  );
}

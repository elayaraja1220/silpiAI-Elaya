"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RotateCcw, Send, Wallet } from "lucide-react";

import { cn } from "@/lib/utils";
import { WALLET_CHANGED } from "./ai-shell";
import { api, ApiError, Button, Card, credits, inputClass, Notice, Pill } from "./light";

type Model = { id: string; label: string; tier: "fast" | "balanced" | "best" | "demo"; maxOutputTokens: number; creditsPer1kInput: number; creditsPer1kOutput: number };
type Wallet = { balanceUnits: number; reservedUnits: number; availableUnits: number };
type Turn = { role: "user" | "assistant"; content: string; meta?: { model: string; tokensIn: number; tokensOut: number; chargedUnits: number; latencyMs: number; fallback: boolean } };
type Result = { requestId: string; text: string; model: { id: string; label: string; tier: string }; fallbackUsed: boolean; usage: { inputTokens: number; outputTokens: number }; chargedUnits: number; latencyMs: number; wallet: Wallet };

const CHOICES = [
  { value: "auto", title: "Auto", blurb: "Picks the cheapest model that suits the size of your request." },
  { value: "fast", title: "Fast", blurb: "Lowest cost. Quick answers, simple tasks." },
  { value: "balanced", title: "Balanced", blurb: "Everyday coding and writing." },
  { value: "best", title: "Best quality", blurb: "Hardest problems. Costs the most." },
  { value: "silpi-demo", title: "Demo", blurb: "Free. No AI: tries the screens only." },
];
const LENGTHS = [256, 512, 1024, 2048, 4096];
const STARTERS = ["Explain what an API is in simple words", "Write a friendly product description for a bakery", "Give me 5 name ideas for a travel website", "Translate 'Welcome to our shop' into Tamil"];

/** Chat through the gateway. Shows what a request may hold BEFORE it is sent, and what it really cost AFTER. */
export function Playground() {
  const [models, setModels] = useState<Model[]>([]);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [choice, setChoice] = useState("auto");
  const [maxOut, setMaxOut] = useState(1024);
  const [system, setSystem] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [text, setText] = useState("");
  const [thread, setThread] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; tone: "red" | "amber" } | null>(null);
  const [hold, setHold] = useState<{ maxUnits: number; label: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ models: Model[]; wallet: Wallet }>("/api/workspace/ai/models").then((r) => { setModels(r.models); setWallet(r.wallet); }).catch((e: Error) => setError({ message: e.message, tone: "red" }));
  }, []);

  const messages = useMemo(() => [...thread.map(({ role, content }) => ({ role, content })), ...(text.trim() ? [{ role: "user" as const, content: text }] : [])], [thread, text]);

  // The live estimate: the most this send could hold. Same server maths as the real request; charges nothing.
  useEffect(() => {
    if (!text.trim()) { setHold(null); return; }
    const t = setTimeout(() => {
      api<{ estimate: { maxUnits: number; model: string }; wallet: Wallet }>("/api/workspace/ai/estimate", { method: "POST", body: { model: choice, messages, system: system || undefined, maxOutputTokens: maxOut } })
        .then((r) => { setHold({ maxUnits: r.estimate.maxUnits, label: r.estimate.model }); setWallet(r.wallet); })
        .catch(() => setHold(null));
    }, 350);
    return () => clearTimeout(t);
  }, [text, choice, maxOut, system, messages]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: "nearest" }); }, [thread, busy]);

  const short = hold !== null && wallet !== null && hold.maxUnits > wallet.availableUnits;
  const send = useCallback(async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    const question: Turn = { role: "user", content: text };
    try {
      const r = await api<{ result: Result }>("/api/workspace/ai/chat", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: { model: choice, messages: [...thread, question].map(({ role, content }) => ({ role, content })), system: system || undefined, maxOutputTokens: maxOut },
      });
      const x = r.result;
      setThread((t) => [...t, question, { role: "assistant", content: x.text, meta: { model: x.model.label, tokensIn: x.usage.inputTokens, tokensOut: x.usage.outputTokens, chargedUnits: x.chargedUnits, latencyMs: x.latencyMs, fallback: x.fallbackUsed } }]);
      setWallet(x.wallet);
      window.dispatchEvent(new Event(WALLET_CHANGED));
      setText("");
    } catch (e) {
      const err = e as ApiError;
      const b = err.body ?? {};
      if (err.status === 402) setError({ message: "Not enough credits for this request. Reduce the answer length, choose a cheaper model, or ask your administrator for more credits.", tone: "amber" });
      else if (b.code === "daily-cap") setError({ message: "Your organization's daily AI limit has been reached. It resets at midnight UTC.", tone: "amber" });
      else if (b.code === "provider-not-configured") setError({ message: "This model's AI provider is not connected yet. Nothing was charged. Try Demo, or ask the administrator to add the provider key.", tone: "amber" });
      else setError({ message: err.message || "Something went wrong. You were not charged.", tone: "red" });
    } finally {
      setBusy(false);
    }
  }, [text, busy, choice, thread, system, maxOut]);

  const lengthOptions = LENGTHS.filter((n) => n <= Math.max(256, ...models.map((m) => m.maxOutputTokens)));
  const priced = (v: string) => models.find((m) => (v === "auto" ? m.tier === "fast" : v === "silpi-demo" ? m.id === v : m.tier === v));

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
      <div className="space-y-4">
        <Card className="space-y-3 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Model</p>
          <div className="grid gap-2 sm:grid-cols-5" role="radiogroup" aria-label="Model">
            {CHOICES.map((c) => {
              const m = priced(c.value);
              const active = choice === c.value;
              return (
                <button key={c.value} role="radio" aria-checked={active} onClick={() => setChoice(c.value)} disabled={c.value !== "auto" && !m} className={cn("rounded-xl border p-3 text-left transition disabled:opacity-40", active ? "border-indigo-500 bg-indigo-50 ring-2 ring-indigo-500/20" : "border-slate-200 bg-white hover:border-slate-300")}>
                  <span className="block text-sm font-semibold text-slate-900">{c.title}</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">{c.blurb}</span>
                  {m && c.value !== "auto" && <span className="mt-1.5 block text-[11px] font-medium tabular-nums text-indigo-700">{m.tier === "demo" ? "Free" : `${credits(Math.round(m.creditsPer1kOutput * 1000))} cr / 1k answer tokens`}</span>}
                </button>
              );
            })}
          </div>
        </Card>

        <Card className="p-0">
          <div className="max-h-[420px] min-h-[220px] space-y-4 overflow-y-auto p-5" aria-live="polite">
            {thread.length === 0 && !busy && (
              <div className="space-y-4 pt-6 text-center">
                <p className="text-base font-medium text-slate-800">What would you like to ask?</p>
                <p className="text-sm text-slate-500">Each answer shows exactly what it cost. New here? Pick <b>Demo</b> above: it is free and uses no AI.</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {STARTERS.map((s) => <button key={s} onClick={() => setText(s)} className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 hover:border-indigo-300 hover:bg-indigo-50">{s}</button>)}
                </div>
              </div>
            )}
            {thread.map((t, i) => (
              <div key={i} className={cn("flex", t.role === "user" ? "justify-end" : "justify-start")}>
                <div className={cn("max-w-[85%] rounded-2xl px-4 py-2.5 text-sm", t.role === "user" ? "bg-indigo-600 text-white" : "border border-slate-200 bg-slate-50 text-slate-800")}>
                  <p className="whitespace-pre-wrap break-words">{t.content}</p>
                  {t.meta && (
                    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-200 pt-1.5 text-[11px] text-slate-500">
                      <Pill tone="indigo">{t.meta.model}</Pill>
                      {t.meta.fallback && <Pill tone="amber">backup model used</Pill>}
                      <span>{t.meta.tokensIn.toLocaleString()} in · {t.meta.tokensOut.toLocaleString()} out</span>
                      <span className="font-medium text-slate-700">{t.meta.chargedUnits === 0 ? "free" : `${credits(t.meta.chargedUnits)} credits`}</span>
                      <span>{(t.meta.latencyMs / 1000).toFixed(1)}s</span>
                    </p>
                  )}
                </div>
              </div>
            ))}
            {busy && <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={14} className="animate-spin" /> Thinking...</p>}
            <div ref={bottom} />
          </div>
          <div className="space-y-3 border-t border-slate-200 p-4">
            {error && <Notice tone={error.tone}>{error.message}</Notice>}
            {showSystem && <textarea value={system} onChange={(e) => setSystem(e.target.value)} rows={2} maxLength={20000} placeholder="Optional instructions for the AI (for example: answer in Tamil, be brief)" className={inputClass} aria-label="Instructions" />}
            <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); }} rows={3} maxLength={100000} placeholder="Write your request... (Ctrl+Enter to send)" className={inputClass} aria-label="Your request" />
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-slate-600">Answer length
                <select value={maxOut} onChange={(e) => setMaxOut(Number(e.target.value))} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800">
                  {lengthOptions.map((n) => <option key={n} value={n}>up to {n.toLocaleString()} tokens</option>)}
                </select>
              </label>
              <button onClick={() => setShowSystem((v) => !v)} className="text-xs text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline">{showSystem ? "Hide instructions" : "Add instructions"}</button>
              {thread.length > 0 && <button onClick={() => { setThread([]); setError(null); }} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800"><RotateCcw size={12} /> New chat</button>}
              <div className="ml-auto flex items-center gap-3">
                {hold && <span className={cn("text-xs tabular-nums", short ? "font-medium text-rose-700" : "text-slate-500")}>{hold.maxUnits === 0 ? "Free" : `Holds up to ${credits(hold.maxUnits)} cr`}</span>}
                <Button onClick={() => void send()} disabled={!text.trim() || busy || short}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Send</Button>
              </div>
            </div>
            {short && <p className="text-xs text-rose-700">This could cost more than your available credits. Lower the answer length or pick a cheaper model.</p>}
          </div>
        </Card>
      </div>

      <aside className="space-y-4">
        <Card className="space-y-3">
          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500"><Wallet size={14} /> Credits</p>
          {wallet ? (
            <>
              <p className="text-3xl font-semibold tabular-nums text-slate-900" data-testid="available-credits">{credits(wallet.availableUnits)}</p>
              <p className="text-xs text-slate-500">available{wallet.reservedUnits > 0 && <> · {credits(wallet.reservedUnits)} held for running requests</>}</p>
            </>
          ) : <p className="text-sm text-slate-400">Loading...</p>}
        </Card>
        <Card className="space-y-2 text-xs leading-5 text-slate-600">
          <p className="font-semibold text-slate-800">How you are charged</p>
          <p>Before a request runs, the most it could cost is <b>held</b>. When it finishes you pay only the <b>real</b> cost and the rest comes back. A request that fails costs nothing.</p>
          <p>Your prompts and answers are not stored by the gateway.</p>
        </Card>
      </aside>
    </div>
  );
}

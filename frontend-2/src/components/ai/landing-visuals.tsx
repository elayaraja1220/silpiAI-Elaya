import { Check, Lock } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Small drawn examples for the landing page. Every number in them is an ILLUSTRATION of how the product behaves, and each is
 * labelled "Example" so nobody reads it as a real price or a real result.
 */

const Tag = ({ dark }: { dark?: boolean }) => (
  <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide", dark ? "bg-white/10 text-white/60" : "bg-slate-100 text-slate-500")}>Example</span>
);

export function ChatMock() {
  return (
    <div className="space-y-3 text-left">
      <div className="flex items-center justify-between"><span className="text-xs font-medium text-slate-500">Chat</span><Tag /></div>
      <div className="ml-auto w-fit max-w-[88%] rounded-2xl rounded-br-md bg-indigo-600 px-3.5 py-2 text-sm text-white">Write a friendly description for my bakery</div>
      <div className="w-fit max-w-[92%] rounded-2xl rounded-bl-md border border-slate-200 bg-white px-3.5 py-2 text-sm text-slate-700 shadow-sm">
        Warm loaves, baked fresh every morning in the heart of town...
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2 text-[10px] text-slate-500">
          <span className="rounded-full bg-indigo-50 px-2 py-0.5 font-medium text-indigo-700">Fast</span><span>120 in · 85 out</span><span className="font-semibold text-slate-700">0.004 credits</span>
        </div>
      </div>
    </div>
  );
}

export function PlanMock() {
  const rows = [["index.html", "Fast"], ["styles.css", "Fast"], ["app.js", "Balanced"]];
  return (
    <div className="space-y-3 text-left">
      <div className="flex items-center justify-between"><span className="text-xs font-medium text-slate-500">Your plan</span><Tag /></div>
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white text-sm shadow-sm">
        {rows.map(([f, m]) => (
          <li key={f} className="flex items-center justify-between px-3 py-2"><span className="flex items-center gap-2 text-slate-700"><Check size={14} className="text-emerald-500" />{f}</span><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">{m}</span></li>
        ))}
      </ul>
      <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600"><span>Most it could cost</span><b className="text-slate-900">up to 1.2 credits</b></div>
      <div className="rounded-lg bg-indigo-600 py-2 text-center text-sm font-medium text-white">Approve and start</div>
    </div>
  );
}

export function MeterMock() {
  return (
    <div className="space-y-3 text-left">
      <div className="flex items-center justify-between"><span className="text-xs font-medium text-slate-500">One request</span><Tag /></div>
      {[["Held before it runs", "2.00", "w-full bg-slate-300"], ["Charged (the real cost)", "0.41", "w-[20%] bg-indigo-500"], ["Returned to you", "1.59", "w-[80%] bg-emerald-400"]].map(([label, v, bar]) => (
        <div key={label}>
          <div className="mb-1 flex justify-between text-xs text-slate-600"><span>{label}</span><b className="tabular-nums text-slate-900">{v}</b></div>
          <div className="h-2 rounded-full bg-slate-100"><div className={cn("h-full rounded-full", bar)} /></div>
        </div>
      ))}
    </div>
  );
}

export function TierMock() {
  const tiers = [["Auto", "Picks for you", 1], ["Fast", "Quick and low cost", 1], ["Balanced", "Everyday work", 2], ["Best", "Hardest problems", 3]] as const;
  return (
    <div className="space-y-3 text-left">
      <div className="flex items-center justify-between"><span className="text-xs font-medium text-white/60">Choose a model tier</span><Tag dark /></div>
      <div className="grid grid-cols-2 gap-2">
        {tiers.map(([name, note, cost], i) => (
          <div key={name} className={cn("rounded-xl border p-3", i === 0 ? "border-indigo-400/60 bg-indigo-500/20" : "border-white/10 bg-white/5")}>
            <p className="text-sm font-semibold text-white">{name}</p>
            <p className="mt-0.5 text-[11px] text-white/60">{note}</p>
            <p className="mt-2 flex gap-0.5">{[1, 2, 3].map((n) => <span key={n} className={cn("h-1.5 w-4 rounded-full", n <= cost ? "bg-cyan-300" : "bg-white/15")} />)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FlowMock() {
  const steps = [["Hold", "worst case"], ["Run", "the AI call"], ["Charge", "real cost"], ["Return", "the rest"]];
  return (
    <div className="space-y-3 text-left">
      <div className="flex items-center justify-between"><span className="text-xs font-medium text-white/60">Every request</span><Tag dark /></div>
      <ol className="grid grid-cols-4 gap-2">
        {steps.map(([a, b], i) => (
          <li key={a} className="rounded-xl border border-white/10 bg-white/5 p-2.5 text-center">
            <span className="mx-auto mb-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-cyan-300 to-indigo-400 text-[11px] font-bold text-slate-900">{i + 1}</span>
            <p className="text-xs font-semibold text-white">{a}</p><p className="text-[10px] text-white/55">{b}</p>
          </li>
        ))}
      </ol>
      <p className="rounded-lg bg-emerald-400/10 px-3 py-2 text-xs text-emerald-200">If the AI fails, the hold is released: you pay nothing.</p>
    </div>
  );
}

export function LimitMock() {
  return (
    <div className="space-y-3 text-left">
      <div className="flex items-center justify-between"><span className="text-xs font-medium text-white/60">Daily limit</span><Tag dark /></div>
      <div>
        <div className="mb-1 flex justify-between text-xs text-white/70"><span>Used today</span><b className="text-white">3.1 of 5 credits</b></div>
        <div className="h-2.5 rounded-full bg-white/10"><div className="h-full w-[62%] rounded-full bg-gradient-to-r from-cyan-300 to-indigo-400" /></div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-center text-xs">
        <div className="rounded-xl border border-white/10 bg-white/5 p-2.5"><p className="text-lg font-semibold text-white">4</p><p className="text-white/55">requests at once</p></div>
        <div className="rounded-xl border border-white/10 bg-white/5 p-2.5"><p className="text-lg font-semibold text-white">Budget</p><p className="text-white/55">on every build</p></div>
      </div>
    </div>
  );
}

export function PrivacyMock() {
  const rows = [["Chat prompts and answers", "Not stored"], ["Your builds and files", "Saved for you"], ["Other organizations", "Cannot see them"]];
  return (
    <div className="space-y-3 text-left">
      <div className="flex items-center gap-2 text-xs font-medium text-white/60"><Lock size={13} /> Your data</div>
      <ul className="divide-y divide-white/10 rounded-xl border border-white/10 bg-white/5 text-sm">
        {rows.map(([a, b]) => <li key={a} className="flex justify-between gap-3 px-3 py-2.5"><span className="text-white/75">{a}</span><span className="font-medium text-cyan-200">{b}</span></li>)}
      </ul>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Eye, Lock, MonitorPlay } from "lucide-react";

import { demoApi } from "@/components/business/demo-panel";
import type { DemoView } from "@/lib/demo/service";
import { formatRelativeTime } from "@/lib/utils";

/** Overview: every demo that is open right now, across all projects. Hidden when there are none. */
export function LiveDemosCard() {
  const [demos, setDemos] = useState<DemoView[] | null>(null);
  const [local, setLocal] = useState(true);
  const [copied, setCopied] = useState("");

  useEffect(() => {
    demoApi("/api/demo").then((r) => { setDemos(r.demos); setLocal(r.local); }).catch(() => setDemos([]));
  }, []);

  if (!demos || demos.length === 0) return null;
  const copy = async (d: DemoView) => { try { await navigator.clipboard.writeText(d.url); setCopied(d.id); setTimeout(() => setCopied(""), 1500); } catch { /* ignore */ } };

  return (
    <section className="rounded-2xl border border-white/[.08] bg-[#121622] p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300"><MonitorPlay size={18} /></span>
          <h3 className="text-sm font-semibold">Live demos</h3>
        </div>
        <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-violet-500 px-1.5 text-[11px] font-bold text-white">{demos.length}</span>
      </div>
      <ul className="mt-4 space-y-3">
        {demos.slice(0, 6).map((d) => (
          <li key={d.id} className="rounded-xl border border-white/[.06] bg-white/[.025] p-3">
            {/* One click: the demo opens in a new tab. */}
            <a href={d.previewUrl} target="_blank" rel="noreferrer" title="Open the demo in a new tab" className="group flex w-full items-center justify-between gap-2 rounded-lg text-left">
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 truncate text-xs font-semibold text-slate-100 group-hover:text-violet-200">{d.label}{d.protected && <Lock size={11} className="shrink-0 text-violet-300" />}</span>
                <span className="mt-0.5 block truncate text-[10px] text-slate-500">{d.projectName}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2 text-[10px] text-slate-400"><span className="flex items-center gap-1"><Eye size={11} /> {d.views}</span><ExternalLink size={13} className="text-violet-300 opacity-70 group-hover:opacity-100" /></span>
            </a>
            <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-slate-500">
              <span>{d.lastViewAt ? `Viewed ${formatRelativeTime(d.lastViewAt)}` : "Not opened yet"} · ends {new Date(d.expiresAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</span>
              <button type="button" onClick={() => copy(d)} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-slate-300 hover:bg-white/5">{copied === d.id ? <Check size={11} className="text-emerald-300" /> : <Copy size={11} />} {copied === d.id ? "Copied" : "Copy link"}</button>
            </div>
          </li>
        ))}
      </ul>
      {local && <p className="mt-3 text-[10px] leading-4 text-amber-200">These links open only on this computer. Set a public address in a project&apos;s Demo preview tab so clients can open them.</p>}
    </section>
  );
}

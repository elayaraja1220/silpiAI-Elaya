"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, BellRing, Coins, Hammer, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { AiUpdate } from "@/server/ai-updates";
import { api, Card, Pill } from "./light";

const ICON = { build: Hammer, credits: Coins, payment: AlertTriangle } as const;
const TONE: Record<AiUpdate["tone"], string> = { action: "bg-indigo-50 text-indigo-700", good: "bg-emerald-50 text-emerald-700", warn: "bg-amber-50 text-amber-700", info: "bg-slate-100 text-slate-600" };

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** The AI workspace's updates: its builds, its credits and a payment that did not go through. The Fixed Price projects have their own list. */
export function AiUpdatesPage() {
  const [updates, setUpdates] = useState<AiUpdate[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ updates: AiUpdate[] }>("/api/workspace/updates").then((r) => setUpdates(r.updates)).catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-[.18em] text-indigo-600">Updates</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">What has changed</h1>
      </div>
      {error ? (
        <Card className="text-sm text-rose-700">{error}</Card>
      ) : updates === null ? (
        <Card className="flex items-center justify-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Loading...</Card>
      ) : updates.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500" data-testid="empty">Nothing yet. When one of your builds changes, or credits are added, it appears here.</p>
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" data-testid="ai-updates">
          {updates.map((u) => {
            const Icon = ICON[u.kind];
            return (
              <li key={u.id}>
                <Link href={u.href} className="flex items-start gap-3 px-5 py-4 transition hover:bg-slate-50">
                  <span className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full", TONE[u.tone])}><Icon size={15} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-medium text-slate-900">{u.text}</span>{u.needsAction && <Pill tone="indigo">Needs you</Pill>}</span>
                    <span className="block text-sm text-slate-600">{u.detail}</span>
                    <span className="block text-xs text-slate-400">{when(u.at)}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <p className="flex items-center justify-center gap-1.5 text-center text-xs text-slate-400"><BellRing size={12} /> Updates on your fixed-price projects are in the Fixed Price application.</p>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { api, Card, credits, Notice, Pill, Stat } from "./light";

type Period = { requests: number; failed: number; chargedUnits: number; inputTokens: number; outputTokens: number };
type Summary = { dailyCapUnits: number | null; today: Period; month: Period; byModel: { modelId: string; requests: number; inputTokens: number; outputTokens: number; chargedUnits: number }[] };
type Row = { id: string; status: "running" | "completed" | "failed"; purpose: string; requestedModel: string; modelId: string | null; fallbackUsed: boolean; attempts: number; inputTokens: number; outputTokens: number; chargedUnits: number; errorCode: string | null; latencyMs: number | null; createdAt: string };
type Wallet = { balanceUnits: number; reservedUnits: number; availableUnits: number };

const STATUS = { completed: "green", failed: "red", running: "amber" } as const;

export function UsagePage() {
  const [data, setData] = useState<{ summary: Summary; requests: Row[]; wallet: Wallet } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ summary: Summary; requests: Row[]; wallet: Wallet }>("/api/workspace/ai/usage").then(setData).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <Notice tone="red">{error}</Notice>;
  if (!data) return <Card className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Loading...</Card>;
  const { summary: s, requests, wallet } = data;
  const capLeft = s.dailyCapUnits === null ? null : Math.max(0, s.dailyCapUnits - s.today.chargedUnits);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Credits available" value={credits(wallet.availableUnits)} hint={wallet.reservedUnits > 0 ? `${credits(wallet.reservedUnits)} held right now` : "nothing held"} />
        <Stat label="Used today" value={credits(s.today.chargedUnits)} hint={`${s.today.requests} requests${s.today.failed ? ` · ${s.today.failed} failed (not charged)` : ""}`} />
        <Stat label="Used this month" value={credits(s.month.chargedUnits)} hint={`${s.month.requests} requests`} />
        <Stat label="Tokens this month" value={(s.month.inputTokens + s.month.outputTokens).toLocaleString()} hint={`${s.month.inputTokens.toLocaleString()} in · ${s.month.outputTokens.toLocaleString()} out`} />
      </div>
      {s.dailyCapUnits !== null && <Notice tone="slate">Your organization has a daily AI limit of <b>{credits(s.dailyCapUnits)}</b> credits ({credits(capLeft ?? 0)} left today). It resets at midnight UTC.</Notice>}

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">By model this month</h2>
        {s.byModel.length === 0 ? <p className="text-sm text-slate-500">No completed requests yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="py-2 pr-4 font-medium">Model</th><th className="py-2 pr-4 text-right font-medium">Requests</th><th className="py-2 pr-4 text-right font-medium">Tokens in</th><th className="py-2 pr-4 text-right font-medium">Tokens out</th><th className="py-2 text-right font-medium">Credits</th></tr></thead>
              <tbody>{s.byModel.map((m) => (
                <tr key={m.modelId} className="border-b border-slate-100 last:border-0"><td className="py-2 pr-4 font-medium text-slate-800">{m.modelId}</td><td className="py-2 pr-4 text-right tabular-nums">{m.requests}</td><td className="py-2 pr-4 text-right tabular-nums">{m.inputTokens.toLocaleString()}</td><td className="py-2 pr-4 text-right tabular-nums">{m.outputTokens.toLocaleString()}</td><td className="py-2 text-right font-medium tabular-nums">{credits(m.chargedUnits)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Recent requests</h2>
        {requests.length === 0 ? <p className="text-sm text-slate-500">Nothing yet. Try the Playground.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="py-2 pr-4 font-medium">When</th><th className="py-2 pr-4 font-medium">Model</th><th className="py-2 pr-4 font-medium">Status</th><th className="py-2 pr-4 text-right font-medium">Tokens</th><th className="py-2 pr-4 text-right font-medium">Time</th><th className="py-2 text-right font-medium">Credits</th></tr></thead>
              <tbody>{requests.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 last:border-0">
                  <td className="whitespace-nowrap py-2 pr-4 text-slate-600">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="py-2 pr-4 text-slate-800">{r.modelId ?? r.requestedModel}{r.fallbackUsed && <span className="ml-1.5"><Pill tone="amber">backup</Pill></span>}</td>
                  <td className="py-2 pr-4"><Pill tone={STATUS[r.status]}>{r.status === "failed" ? `failed${r.errorCode ? ` · ${r.errorCode}` : ""}` : r.status}</Pill></td>
                  <td className="py-2 pr-4 text-right tabular-nums text-slate-600">{(r.inputTokens + r.outputTokens).toLocaleString()}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-slate-600">{r.latencyMs === null ? "-" : `${(r.latencyMs / 1000).toFixed(1)}s`}</td>
                  <td className="py-2 text-right font-medium tabular-nums">{r.chargedUnits === 0 ? "-" : credits(r.chargedUnits)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

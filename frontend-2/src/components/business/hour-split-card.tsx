"use client";

import { useEffect, useState } from "react";

import { SPLIT_LABELS } from "@/lib/business/hour-split";
import type { HourEstimate } from "@/server/hour-split";
import { Card, jsonFetch } from "./ui";

/**
 * How the hours of this quotation might be shared between roles. A suggestion for planning only: the hours and the price are not changed by it,
 * and the card says so. The AI's answer is always adjusted to add up to the quotation's own hours.
 */
export function HourSplitCard({ leadId }: { leadId: string }) {
  const [rows, setRows] = useState<HourEstimate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { jsonFetch<{ estimates: HourEstimate[] }>(`/api/business/leads/${leadId}/hour-split`).then((r) => setRows(r.estimates)).catch(() => setRows([])); }, [leadId]);

  const call = async (method: string, body?: object) => {
    setBusy(true);
    setError("");
    try {
      const r = await jsonFetch<{ estimates: HourEstimate[] }>(`/api/business/leads/${leadId}/hour-split`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      setRows(r.estimates);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const latest = rows?.[0];
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-300">Suggested hour split by role</p>
        <button type="button" disabled={busy} onClick={() => void call("POST")} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/5 disabled:opacity-50" data-testid="suggest-split">{busy ? "Working..." : latest ? "Suggest again" : "Suggest a split"}</button>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">For planning and staffing only. It does not change the hours or the price of the quotation.</p>
      {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
      {latest && (
        <div className="mt-3 space-y-2" data-testid="split-latest">
          <p className="text-xs text-slate-300">
            {latest.source === "ai" ? `Suggested by AI (${latest.model})` : "Default rule of thumb (not AI)"} · {latest.totalHours} hours in all
            {latest.status !== "suggested" && <span className="ml-2 text-slate-500">· {latest.status} by {latest.decidedBy}</span>}
          </p>
          <ul className="space-y-1">
            {latest.lines.map((l) => (
              <li key={l.roleId} className="flex items-center gap-2 text-xs text-slate-300">
                <span className="w-36 shrink-0">{SPLIT_LABELS[l.roleId]}</span>
                <span className="h-2 rounded-full bg-violet-400/70" style={{ width: `${Math.max(2, Math.round((l.hours / latest.totalHours) * 100))}%`, maxWidth: "50%" }} />
                <span className="tabular-nums">{l.hours} h · {Math.round((l.hours / latest.totalHours) * 100)}%</span>
              </li>
            ))}
          </ul>
          {latest.reason && <p className="text-[11px] text-slate-400">{latest.reason}</p>}
          {latest.aiNote && <p className="text-[11px] text-amber-200">{latest.aiNote}</p>}
          {latest.status === "suggested" && (
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => void call("PUT", { id: latest.id, status: "accepted" })} className="rounded-lg bg-emerald-500/90 px-3 py-1.5 text-xs text-white hover:bg-emerald-500 disabled:opacity-50">Use this for planning</button>
              <button type="button" disabled={busy} onClick={() => void call("PUT", { id: latest.id, status: "dismissed" })} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-50">Dismiss</button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

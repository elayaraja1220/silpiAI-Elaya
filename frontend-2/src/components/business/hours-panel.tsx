"use client";

import { useState } from "react";
import { Clock, Loader2, Trash2 } from "lucide-react";

import { EXTRA_WORK, accuracy, hoursReport, quotedItems } from "@/lib/business/hours";
import type { Lead, Stage } from "@/lib/business/types";
import { cn } from "@/lib/utils";

import { Card, jsonFetch } from "./ui";

type History = { fromStage: Stage | null; toStage: Stage; note: string; at: string }[];
const field = "w-full rounded-lg border border-white/[.08] bg-white/[.03] px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-400/60 [&>option]:bg-[#121620]";

/** Estimate vs the hours really spent: builds the owner's own price history. */
export function HoursPanel({ lead, onChanged }: { lead: Lead; onChanged: (r: { lead: Lead; history: History }) => void }) {
  const items = quotedItems(lead.quotation);
  const report = hoursReport(lead.quotation, lead.workLog);
  const [item, setItem] = useState(items[0]?.item ?? EXTRA_WORK);
  const [hours, setHours] = useState("");
  const [note, setNote] = useState("");
  const [loggedOn, setLoggedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const call = async (url: string, method: string, body?: object) => {
    setBusy(true);
    setError("");
    try {
      onChanged(await jsonFetch<{ lead: Lead; history: History }>(url, { method, body: body ? JSON.stringify(body) : undefined }));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    if (await call(`/api/business/leads/${lead.id}/hours`, "POST", { item, hours: Number(hours), note, loggedOn })) {
      setHours("");
      setNote("");
    }
  };

  const over = report.variancePct > 0;
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-300"><Clock size={14} className="text-violet-300" /> Hours: estimate vs actual</p>
        <p className="text-xs tabular-nums text-slate-400">
          Estimate {report.estimated} h · Actual <span className="text-slate-100">{report.actual} h</span>
          {report.actual > 0 && <span className={cn("ml-1.5 font-semibold", over ? "text-rose-300" : "text-emerald-300")}>{over ? "+" : ""}{report.variancePct}%</span>}
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-[1fr_90px_130px]">
        <select value={item} onChange={(e) => setItem(e.target.value)} className={field}>
          {items.map((i) => <option key={i.item} value={i.item}>{i.item} ({i.hours} h)</option>)}
          <option value={EXTRA_WORK}>{EXTRA_WORK}</option>
        </select>
        <input type="number" min={0} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} placeholder="Hours" className={field} />
        <input type="date" value={loggedOn} onChange={(e) => setLoggedOn(e.target.value)} className={field} />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional), e.g. client asked for changes" className={cn(field, "sm:col-span-2")} />
        <button type="button" disabled={busy || !hours} onClick={add} className="flex items-center justify-center gap-2 rounded-lg bg-violet-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-400 disabled:opacity-50">
          {busy && <Loader2 size={14} className="animate-spin" />} Log hours
        </button>
      </div>
      {error && <p className="text-xs text-rose-300">{error}</p>}

      {report.actual > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
              <th className="py-1 font-medium">Work</th>
              <th className="py-1 text-right font-medium">Estimate</th>
              <th className="py-1 text-right font-medium">Actual</th>
            </tr>
          </thead>
          <tbody>
            {report.lines.filter((l) => l.actual > 0).map((l) => (
              <tr key={l.item} className="border-t border-white/[.04] text-slate-300">
                <td className="py-1 pr-2">{l.item}</td>
                <td className="py-1 text-right tabular-nums text-slate-500">{l.estimated ? `${l.estimated} h` : "-"}</td>
                <td className={cn("py-1 text-right tabular-nums", l.estimated && l.actual > l.estimated ? "text-rose-300" : "text-slate-200")}>{l.actual} h</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {lead.workLog.length > 0 && (
        <ul className="max-h-48 space-y-1 overflow-y-auto text-xs text-slate-400">
          {lead.workLog.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{e.loggedOn} · {e.hours} h · {e.item}{e.note ? ` · ${e.note}` : ""}</span>
              <button type="button" aria-label="Remove entry" disabled={busy} onClick={() => call(`/api/business/leads/${lead.id}/hours?entry=${e.id}`, "DELETE")} className="shrink-0 text-slate-600 hover:text-rose-300"><Trash2 size={12} /></button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Across all tracked projects: are the estimates too low or too high? */
export function AccuracyCard({ leads }: { leads: Lead[] }) {
  const a = accuracy(leads);
  if (a.projects === 0) return null;
  const pct = Math.round((a.ratio - 1) * 100);
  const advice =
    pct > 10
      ? "Your projects take longer than estimated. Raise the hours or the hourly rate in Business & pricing, and bill client changes as extra work."
      : pct < -10
        ? "Your projects take less time than estimated. You may be quoting higher than needed; check against other quotes before lowering."
        : "Your estimates are close to the real effort.";
  return (
    <Card className="text-xs text-slate-300">
      <p className="font-semibold text-slate-100">Your estimate accuracy ({a.projects} tracked project{a.projects === 1 ? "" : "s"})</p>
      <p className="mt-1 tabular-nums">
        Estimated {a.estimated} h · Actually worked {a.actual} h
        <span className={cn("ml-1.5 font-semibold", pct > 5 ? "text-rose-300" : pct < -5 ? "text-emerald-300" : "text-slate-200")}>{pct > 0 ? "+" : ""}{pct}%</span>
      </p>
      <p className="mt-1 text-slate-400">{advice}{a.projects < 3 && " Log hours on a few more projects before changing any prices."}</p>
    </Card>
  );
}

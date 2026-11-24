"use client";

import { useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { diffDigests, type VersionDigest } from "@/lib/business/estimate-ledger";
import { formatINR } from "@/lib/business/pricing";

const fmt = (n: number, money: boolean) => (money ? formatINR(n) : String(n));
const sign = (n: number) => (n > 0 ? "+" : n < 0 ? "-" : "");

/**
 * Compares two versions of the estimate (the last two by default; any two can be chosen): the previous and the current figure,
 * how much it went up or down, which requirements, pages and features were added or removed, which effort assumptions changed,
 * and the exact reasons. Every difference comes from the two saved versions: nothing is estimated here.
 */
export function EstimateCompare({ digests }: { digests: VersionDigest[] }) {
  const last = digests.length - 1;
  const [fromIndex, setFromIndex] = useState(Math.max(0, last - 1));
  const [toIndex, setToIndex] = useState(last);
  const from = Math.min(fromIndex, last);
  const to = Math.min(toIndex, last);
  const diff = useMemo(() => (digests[from] && digests[to] ? diffDigests(digests[from], digests[to]) : null), [digests, from, to]);

  if (digests.length < 2) {
    return (
      <p className="text-xs text-slate-500" data-testid="compare-empty">
        Only one version of the estimate exists. When the scope, a decision or the package changes, the new version is compared with this one here.
      </p>
    );
  }
  if (!diff) return null;

  const total = diff.totals[0];
  const label = (d: VersionDigest, i: number) => `${d.number}${i === digests.length - 1 ? " (current)" : ""} · ${new Date(d.createdAt).toLocaleDateString("en-IN")}`;
  const Trend = total.delta > 0 ? ArrowUpRight : total.delta < 0 ? ArrowDownRight : Minus;
  const tone = total.delta > 0 ? "text-rose-300" : total.delta < 0 ? "text-emerald-300" : "text-slate-300";
  const lists: { title: string; items: string[]; tone: string }[] = [
    { title: "Requirements added", items: diff.addedRequirements, tone: "text-emerald-300" },
    { title: "Requirements removed", items: diff.removedRequirements, tone: "text-rose-300" },
    { title: "Pages added", items: diff.addedPages, tone: "text-emerald-300" },
    { title: "Pages removed", items: diff.removedPages, tone: "text-rose-300" },
    { title: "Features added", items: diff.addedFeatures, tone: "text-emerald-300" },
    { title: "Features removed", items: diff.removedFeatures, tone: "text-rose-300" },
  ].filter((l) => l.items.length > 0);

  return (
    <div className="space-y-3 text-xs" data-testid="estimate-compare">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-[11px] text-slate-500">Previous estimate
          <select value={from} onChange={(e) => setFromIndex(Number(e.target.value))} className="mt-0.5 w-full rounded-md border border-white/10 bg-slate-900 px-2 py-1 text-xs text-slate-200" data-testid="compare-from">
            {digests.map((d, i) => <option key={d.number} value={i} disabled={i >= to}>{label(d, i)}</option>)}
          </select>
        </label>
        <label className="block text-[11px] text-slate-500">Current estimate
          <select value={to} onChange={(e) => setToIndex(Number(e.target.value))} className="mt-0.5 w-full rounded-md border border-white/10 bg-slate-900 px-2 py-1 text-xs text-slate-200" data-testid="compare-to">
            {digests.map((d, i) => <option key={d.number} value={i} disabled={i <= from}>{label(d, i)}</option>)}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2"><p className="text-[11px] text-slate-500">Previous</p><p className="text-base font-semibold tabular-nums text-slate-200" data-testid="compare-previous">{formatINR(total.from)}</p><p className="text-[10px] text-slate-500">{diff.from.number}</p></div>
        <div className="rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2"><p className="text-[11px] text-slate-500">Current</p><p className="text-base font-semibold tabular-nums text-slate-100" data-testid="compare-current">{formatINR(total.to)}</p><p className="text-[10px] text-slate-500">{diff.to.number}</p></div>
        <div className="rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2">
          <p className="text-[11px] text-slate-500">{total.delta > 0 ? "Increased by" : total.delta < 0 ? "Decreased by" : "No change"}</p>
          <p className={`flex items-center gap-1 text-base font-semibold tabular-nums ${tone}`} data-testid="compare-delta"><Trend size={15} />{sign(total.delta)}{formatINR(Math.abs(total.delta))}</p>
          <p className="text-[10px] text-slate-500">{total.percent === null ? "" : `${sign(total.percent)}${Math.abs(total.percent)}%`}</p>
        </div>
      </div>

      <table className="w-full text-left">
        <thead className="text-[11px] text-slate-500"><tr><th className="py-1 font-medium">Figure</th><th className="py-1 text-right font-medium">Before</th><th className="py-1 text-right font-medium">After</th><th className="py-1 text-right font-medium">Change</th></tr></thead>
        <tbody className="text-slate-300">
          {diff.totals.map((t) => (
            <tr key={t.what} className="border-t border-white/5">
              <td className="py-1">{t.what}</td>
              <td className="py-1 text-right tabular-nums">{fmt(t.from, t.money)}</td>
              <td className="py-1 text-right tabular-nums">{fmt(t.to, t.money)}</td>
              <td className={`py-1 text-right tabular-nums ${t.delta === 0 ? "text-slate-500" : ""}`}>{t.delta === 0 ? "-" : `${sign(t.delta)}${fmt(Math.abs(t.delta), t.money)}`}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {lists.map((l) => (
        <div key={l.title} data-testid={`compare-${l.title.toLowerCase().replace(/\s+/g, "-")}`}>
          <p className={`font-semibold ${l.tone}`}>{l.title} ({l.items.length})</p>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-slate-400">{l.items.map((i) => <li key={i}>{i}</li>)}</ul>
        </div>
      ))}

      {diff.effortChanges.length > 0 && (
        <div data-testid="compare-effort">
          <p className="font-semibold text-slate-300">Effort that changed ({diff.effortChanges.length})</p>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-slate-400">
            {diff.effortChanges.map((c) => <li key={c.line}>{c.line}: {c.fromHours} h to {c.toHours} h ({sign(c.delta)}{Math.abs(c.delta)} h) · {c.why}</li>)}
          </ul>
        </div>
      )}
      {diff.assumptionChanges.length > 0 && (
        <div data-testid="compare-assumptions">
          <p className="font-semibold text-slate-300">Effort assumptions that changed</p>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-slate-400">{diff.assumptionChanges.map((c) => <li key={c.what}>{c.what}: {c.from} to {c.to}</li>)}</ul>
        </div>
      )}

      <div data-testid="compare-reasons" className="rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2">
        <p className="font-semibold text-slate-300">Exact reason for the difference</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-300">{diff.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        <p className={`mt-1.5 text-[11px] ${diff.hoursExplained ? "text-emerald-300" : "text-amber-300"}`} data-testid="compare-explained">
          {diff.hoursExplained
            ? "The change in hours is fully accounted for by the lines above."
            : `${Math.abs(diff.unexplainedHours)} h of the change is not accounted for by the added, removed or resized lines.`}
        </p>
      </div>
    </div>
  );
}

"use client";

import { useMemo } from "react";
import { AlertTriangle, CheckCircle2, Undo2 } from "lucide-react";

import { formatINR } from "@/lib/business/pricing";
import type { TechEntry } from "@/lib/business/tech-catalog";
import { recommendTechnology } from "@/lib/business/tech-recommend";
import { listLabels } from "@/lib/business/tech-preference";
import type { RateCard, Requirement } from "@/lib/business/types";

/**
 * Technology the client asked for (for example in their document), kept apart
 * from our recommendations. If it can be used it is shown as asked; if it cannot,
 * the reason is given and an alternative is used only after the client confirms it.
 * Shown only when the client stated a technology.
 */
export function TechnologyCheck({
  requirement,
  budget,
  rates,
  catalog,
  onConfirm,
  onUndo,
}: {
  requirement: Requirement;
  budget: number;
  rates: RateCard;
  catalog: TechEntry[] | null;
  onConfirm: (ids: string[]) => void;
  onUndo: () => void;
}) {
  const tech = requirement.clientTech;
  const result = useMemo(() => (tech && catalog ? recommendTechnology(requirement, budget, catalog, rates) : null), [tech, catalog, requirement, budget, rates]);
  if (!tech || !result) return null;
  const pref = result.clientPreference;
  const asked = tech.stated.join(", ");

  if (tech.confirmedIds?.length) {
    return (
      <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-3 text-xs text-emerald-100">
        <p className="flex items-center gap-1.5 font-semibold"><CheckCircle2 size={14} /> Client confirmed an alternative technology</p>
        <p className="mt-1 text-slate-300">They asked for {asked}, which could not be used. They agreed to: <span className="text-white">{listLabels(tech.confirmedIds, ", ")}</span>.</p>
        <button type="button" onClick={onUndo} className="mt-2 flex items-center gap-1 rounded-md border border-white/15 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/10"><Undo2 size={11} /> Go back to the client&apos;s request</button>
      </div>
    );
  }

  if (pref.status === "honoured") {
    return (
      <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-3 text-xs text-emerald-100">
        <p className="flex items-center gap-1.5 font-semibold"><CheckCircle2 size={14} /> Technology as requested by the client</p>
        <p className="mt-1 text-slate-300">{asked}. The quotation and the build brief use exactly this.</p>
      </div>
    );
  }

  const alternatives = result.options.slice(0, 3);
  return (
    <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 text-xs text-amber-100">
      <p className="flex items-center gap-1.5 font-semibold"><AlertTriangle size={14} /> The client&apos;s technology needs confirmation</p>
      <p className="mt-1 text-slate-200">The client asked for <span className="text-white">{asked}</span>. {pref.problems.join(" ")}</p>
      <p className="mt-1 text-slate-300">The quotation still shows what they asked for. Nothing is replaced until the client confirms an alternative.</p>
      {alternatives.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {alternatives.map((o) => {
            const appIds = o.ids.filter((id) => !o.stack.hosting.some((h) => h.id === id));
            return (
              <li key={o.ids.join()} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-black/20 px-2.5 py-1.5">
                <span className="min-w-0 text-slate-200">
                  {listLabels(appIds, ", ")}
                  {o.estimate && <span className="text-slate-400"> · about {formatINR(o.estimate.total)} incl. GST</span>}
                </span>
                <button type="button" onClick={() => onConfirm(appIds)} className="shrink-0 rounded-md bg-amber-400/90 px-2 py-1 text-[11px] font-semibold text-slate-900 hover:bg-amber-300">
                  Client confirmed this
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

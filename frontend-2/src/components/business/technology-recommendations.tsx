"use client";

import { useMemo } from "react";
import { AlertTriangle, CheckCircle2, Cpu, ShieldCheck, Undo2 } from "lucide-react";

import type { TechEntry } from "@/lib/business/tech-catalog";
import { INR_MONEY } from "@/lib/business/money";
import { quoteMoney, suggestStack } from "@/lib/business/pricing";
import { recommendTechnology } from "@/lib/business/tech-recommend";
import { buildTechnologyView, type StackSource, type TechOptionView } from "@/lib/business/technology-view";
import type { Client, RateCard, Requirement } from "@/lib/business/types";
import { cn } from "@/lib/utils";

import { Card } from "./ui";

const SOURCE_STYLE: Record<StackSource, string> = {
  client: "border-emerald-400/40 bg-emerald-500/10 text-emerald-200",
  "client-confirmed": "border-sky-400/40 bg-sky-500/10 text-sky-200",
  recommended: "border-violet-400/40 bg-violet-500/10 text-violet-200",
};

/**
 * Technology for the quotation. The client's own technology, a client-confirmed alternative and our
 * recommendation are always labelled apart. Only technologies enabled in the catalog are offered, and an
 * alternative is used only after the client confirms it. Nothing here changes a price.
 */
export function TechnologyRecommendations({
  requirement,
  budget,
  rates,
  catalog,
  onUse,
  onConfirm,
  onUndo,
  onClearSelection,
  onChooseTech,
  techChosen = false,
  client,
}: {
  /** The client being quoted: decides the currency the estimates are written in (and GST). */
  client?: Pick<Client, "state"> & { currency?: string };
  requirement: Requirement;
  budget: number;
  rates: RateCard;
  catalog: TechEntry[] | null;
  /** The team selects one of our recommendations. */
  onUse: (ids: string[]) => void;
  /** The client confirmed an alternative to what they asked for. */
  onConfirm: (ids: string[]) => void;
  onUndo: () => void;
  onClearSelection: () => void;
  /** Opens the chooser for frontend, backend and database; the price follows the choice. */
  onChooseTech?: () => void;
  /** A technology has been chosen with the chooser. */
  techChosen?: boolean;
}) {
  const view = useMemo(() => {
    if (!catalog) return null;
    try {
      return buildTechnologyView(requirement, recommendTechnology(requirement, budget, catalog, rates, client ? { client } : {}), catalog, rates, client ? quoteMoney(client, rates) : INR_MONEY);
    } catch {
      return null;
    }
  }, [requirement, budget, rates, catalog, client]);

  // What was picked with "Change technology": shown on its own so it is always clear what is in use.
  const chosen = useMemo(() => {
    const t = requirement.tech;
    if (!t || !Object.keys(t).length || requirement.scope === "module" || requirement.scope === "version") return null;
    const s = suggestStack(requirement, rates);
    const rows = [
      { label: "Frontend", value: s.frontend },
      { label: "Backend", value: s.backend },
      { label: "Database", value: s.database },
      { label: "Styling / UI library", value: s.styling },
    ];
    return rows;
  }, [requirement, rates]);

  if (!catalog) return <Card className="text-xs text-slate-400">Loading technology options...</Card>;
  if (!view || !view.visible) return null;

  return (
    <div data-testid="technology-panel">
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-100"><Cpu size={15} className="text-violet-300" /> {view.title}</p>
          <p className="mt-0.5 text-[11px] text-slate-500">Only technologies enabled in your catalog are used. Our recommendations do not change the price; a technology you choose does, and the estimate shows how.</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
        {onChooseTech && (
          <button type="button" onClick={onChooseTech} className="flex items-center gap-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-6 py-3.5 text-base font-semibold text-white shadow-lg shadow-emerald-500/25 transition hover:brightness-110 focus:outline-none focus-visible:ring-4 focus-visible:ring-emerald-400/30" data-testid="choose-technology">
            <Cpu size={18} /> Change technology
          </button>
        )}
        {view.inUse && !chosen && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold", SOURCE_STYLE[view.inUse.source])}>
              {view.inUse.source === "client" ? "Client's choice" : view.inUse.source === "client-confirmed" ? "Client-confirmed alternative" : "Our recommendation"}
            </span>
            <span className="text-slate-300">In use: {view.inUse.text}</span>
          </div>
        )}
        </div>
      </div>

      {chosen && (
        <div className="rounded-xl border border-emerald-400/50 bg-emerald-500/10 p-3.5 text-xs" data-testid="chosen-technology">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-emerald-100"><CheckCircle2 size={15} /> In use: the technology you chose</p>
            {onChooseTech && <button type="button" onClick={onChooseTech} className="rounded-md border border-white/15 px-2.5 py-1 text-[11px] font-semibold text-slate-100 hover:bg-white/10">Change</button>}
          </div>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {chosen.map((s) => (
              <div key={s.label} className="contents">
                <dt className="text-slate-400">{s.label}</dt>
                <dd className="text-slate-100">{s.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-[11px] text-slate-400">The estimate already includes it. Using one of the stacks below instead replaces this choice.</p>
        </div>
      )}

      {view.client && (
        <div className={cn("rounded-lg border p-3 text-xs", view.client.status === "honoured" ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100" : "border-amber-400/40 bg-amber-500/10 text-amber-100")}>
          <p className="flex items-center gap-1.5 font-semibold">
            {view.client.status === "honoured" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
            The client asked for: {view.client.stated}
          </p>
          {view.client.status === "honoured" && <p className="mt-1 text-slate-300">It is enabled and compatible. The quotation and the build brief use exactly this.</p>}
          {view.client.status === "needs-confirmation" && (
            <>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-200">{view.client.problems.map((p) => <li key={p}>{p}</li>)}</ul>
              <p className="mt-1 text-slate-300">The quotation still shows what they asked for. Nothing is replaced until the client confirms an alternative below.</p>
            </>
          )}
          {requirement.clientTech?.confirmedIds?.length ? (
            <button type="button" onClick={onUndo} className="mt-2 flex items-center gap-1 rounded-md border border-white/15 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/10"><Undo2 size={11} /> Go back to the client&apos;s request</button>
          ) : null}
        </div>
      )}

      {view.warning && <p className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{view.warning}</p>}

      {requirement.selectedStack?.ids.length ? (
        <button type="button" onClick={onClearSelection} className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-white"><Undo2 size={11} /> Clear the selected stack</button>
      ) : null}

      <ol className="space-y-3">
        {view.options.map((o) => (
          <OptionCard key={o.key} option={o} replacing={!!chosen} onUse={() => onUse(o.appIds)} onConfirm={() => onConfirm(o.appIds)} />
        ))}
      </ol>

      {view.notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-slate-500">{view.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      )}
    </Card>
    </div>
  );
}

function OptionCard({ option: o, replacing = false, onUse, onConfirm }: { option: TechOptionView; replacing?: boolean; onUse: () => void; onConfirm: () => void }) {
  const selected = o.action === "selected";
  return (
    <li className={cn("rounded-xl border p-3.5 text-xs", selected ? "border-violet-400/60 bg-violet-500/10" : "border-white/[.08] bg-white/[.02]")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold text-slate-500">#{o.rank}</span>
          <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold", SOURCE_STYLE[o.source])}>{o.sourceLabel}</span>
          {!o.meetsRequirements && <span className="rounded-full border border-rose-400/40 bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-200">Does not fully meet the needs</span>}
        </div>
        {selected ? (
          <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-300"><CheckCircle2 size={13} /> In use</span>
        ) : (
          <button
            type="button"
            onClick={o.action === "confirm" ? onConfirm : onUse}
            className={cn("rounded-md px-2.5 py-1 text-[11px] font-semibold", o.action === "confirm" ? "bg-amber-400/90 text-slate-900 hover:bg-amber-300" : "bg-violet-500 text-white hover:bg-violet-400")}
          >
            {replacing && o.action === "use" ? "Use this instead" : o.actionLabel}
          </button>
        )}
      </div>

      <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {o.stack.map((s) => (
          <div key={s.label} className="contents">
            <dt className="text-slate-500">{s.label}</dt>
            <dd className="text-slate-200">{s.value}</dd>
          </div>
        ))}
      </dl>
      {o.uiLibraries && <p className="mt-1 text-[11px] text-slate-500">UI libraries that fit: {o.uiLibraries}. Pick one with Change technology.</p>}
      {o.hostingAlternatives && <p className="mt-1 text-[11px] text-slate-500">Other suitable hosting: {o.hostingAlternatives}</p>}

      <div className="mt-2.5 flex flex-wrap gap-1.5 text-[11px] text-slate-300">
        {[`Complexity: ${o.complexity}`, `Maintenance: ${o.maintenance}`, o.scalability].map((chip) => <span key={chip} className="rounded-md bg-white/[.06] px-2 py-0.5">{chip}</span>)}
      </div>

      {o.reasons.length > 0 && (
        <div className="mt-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Why this stack</p>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-slate-300">{o.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}
      {o.tradeoffs.length > 0 && (
        <div className="mt-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Trade-offs</p>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-amber-100/80">{o.tradeoffs.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}
      {o.security.length > 0 && (
        <details className="mt-2 text-slate-400">
          <summary className="flex cursor-pointer items-center gap-1 text-[11px]"><ShieldCheck size={12} /> Security considerations ({o.security.length})</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{o.security.map((s) => <li key={s}>{s}</li>)}</ul>
        </details>
      )}

      <div className="mt-2.5 flex flex-wrap items-baseline justify-between gap-2 border-t border-white/[.06] pt-2">
        <span className="text-slate-300">
          {o.cost ? <>About <span className="font-semibold text-white">{o.hours} h</span> · <span className="font-semibold text-white">{o.cost}</span> development</> : "Development cost could not be calculated"}
        </span>
        {o.budget && <span className={cn("text-[11px]", o.budget.startsWith("Over") ? "text-rose-300" : "text-emerald-300")}>{o.budget}</span>}
      </div>
      <p className="text-[10px] text-slate-600">{o.costNote}</p>
    </li>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Circle, CircleHelp, Loader2, Lock, Receipt, TrendingUp, Wallet } from "lucide-react";

import { buildCostView, configStatus, costConfigReadiness, internalSummary, VIABILITY_LABELS, type CostRow, type CostView, type ReadinessItem, type RowStatus, type Tone } from "@/lib/business/cost-view";
import { estimateCosts } from "@/lib/business/cost-estimate";
import { calcRecurring, suggestRecurringItems } from "@/lib/business/cost-recurring";
import type { CostConfig, CostEstimate, RecurringCost } from "@/lib/business/cost-types";
import type { RecommendedOption } from "@/lib/business/tech-recommend";
import type { Lead, RateCard, Requirement, Quote } from "@/lib/business/types";
import { cn } from "@/lib/utils";

import { Card, jsonFetch } from "./ui";

const STATUS: Record<RowStatus, { text: string; cls: string } | null> = {
  actual: { text: "Actual", cls: "bg-emerald-500/15 text-emerald-300" },
  estimated: { text: "Estimated", cls: "bg-slate-500/20 text-slate-300" },
  missing: { text: "Missing", cls: "bg-rose-500/15 text-rose-300" },
  info: null,
};
const TONE: Record<Tone, string> = {
  good: "border-emerald-400/40 bg-emerald-500/10 text-emerald-100",
  warn: "border-amber-400/40 bg-amber-500/10 text-amber-100",
  bad: "border-rose-400/40 bg-rose-500/10 text-rose-100",
  neutral: "border-white/10 bg-white/[.04] text-slate-200",
};

function Rows({ rows }: { rows: CostRow[] }) {
  return (
    <dl className="space-y-1">
      {rows.map((r, i) => {
        const badge = r.status ? STATUS[r.status] : null;
        return (
          <div key={`${r.label}-${i}`} className={cn("flex items-baseline justify-between gap-3", r.strong && "border-t border-white/[.06] pt-1 font-semibold text-white")}>
            <dt className="min-w-0 text-slate-400">
              {r.label}
              {r.hint && <span className="block text-[10px] font-normal text-slate-600">{r.hint}</span>}
            </dt>
            <dd className="flex shrink-0 items-center gap-1.5 text-right tabular-nums text-slate-200">
              {r.value}
              {badge && <span className={cn("rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide", badge.cls)}>{badge.text}</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function Section({ icon, title, tag, accent, children }: { icon: React.ReactNode; title: string; tag?: string; accent: string; children: React.ReactNode }) {
  return (
    <section className={cn("rounded-xl border bg-white/[.02] p-4", accent)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-semibold text-slate-100">{icon} {title}</p>
        {tag && <span className="flex items-center gap-1 rounded-full bg-white/[.06] px-2 py-0.5 text-[10px] text-slate-400"><Lock size={10} /> {tag}</span>}
      </div>
      <div className="space-y-3 text-xs">{children}</div>
    </section>
  );
}

const CHIP: Record<"complete" | "incomplete" | "not-configured", string> = {
  complete: "border-emerald-400/40 bg-emerald-500/10 text-emerald-200",
  incomplete: "border-amber-400/40 bg-amber-500/10 text-amber-200",
  "not-configured": "border-white/10 bg-white/[.05] text-slate-300",
};

/**
 * An internal-only section that can be folded away. The header always shows the configuration status
 * (and the key figures once the setup is complete), so a closed section still tells the whole story.
 */
function Collapsible({ icon, title, accent, state, statusLabel, figures, open, testId, children }: { icon: React.ReactNode; title: string; accent: string; state: "complete" | "incomplete" | "not-configured"; statusLabel: string; figures?: { label: string; value: string }[]; open: boolean; testId: string; children: React.ReactNode }) {
  return (
    <details className={cn("group rounded-xl border bg-white/[.02]", accent)} open={open} data-testid={testId} data-state={state}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-2 p-4 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-slate-100">
          <ChevronDown size={14} className="shrink-0 text-slate-500 transition group-open:rotate-180" />
          {icon} {title}
          <span className="flex items-center gap-1 rounded-full bg-white/[.06] px-2 py-0.5 text-[10px] font-normal text-slate-400"><Lock size={10} className="shrink-0" /> Internal only, never shown to the client</span>
        </span>
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          {figures?.map((f) => (
            <span key={f.label} className="text-slate-400">{f.label} <span className="font-semibold tabular-nums text-white">{f.value}</span></span>
          ))}
          <span className={cn("rounded-full border px-2.5 py-0.5 text-[10px] font-semibold", CHIP[state])} data-testid={`${testId}-status`}>{statusLabel}</span>
        </span>
      </summary>
      <div className="space-y-3 border-t border-white/[.06] p-4 text-xs">{children}</div>
    </details>
  );
}

/** One short status block instead of a wall of "Missing" rows: what is done, what is still needed, where to enter it. */
function SetupStatus({ status, projectMissing, onConfigure }: { status: ReturnType<typeof configStatus>; projectMissing: string[]; onConfigure?: () => void }) {
  return (
    <div className="space-y-3" data-testid="setup-status">
      <div className={cn("flex items-start gap-2 rounded-lg border p-3", status.state === "incomplete" ? TONE.warn : TONE.neutral)}>
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <div className="space-y-1">
          <p className="font-semibold">{status.label}: {status.doneCount} of {status.requiredCount} required settings done</p>
          <p className="text-[11px] opacity-90">{status.detail}</p>
          {onConfigure && <button type="button" onClick={onConfigure} className="text-[11px] font-semibold text-violet-300 hover:text-white">Open Business &amp; pricing</button>}
        </div>
      </div>
      {status.needed.length > 0 && (
        <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {status.needed.map((n) => (
            <li key={n.key} className="flex items-start gap-1.5 text-slate-300"><Circle size={10} className="mt-1 shrink-0 text-amber-300" /><span>{n.label}<span className="block text-[10px] text-slate-500">{n.detail}</span></span></li>
          ))}
        </ul>
      )}
      {projectMissing.length > 0 && (
        <details className="text-slate-400" open={status.state === "incomplete"}>
          <summary className="cursor-pointer text-[11px] text-amber-200">Needed for this quotation ({projectMissing.length})</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{projectMissing.map((m) => <li key={m}>{m}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

/** Four separate sections: client development cost, internal studio cost, profitability, client running costs. */
export function CostPanel({ view, readiness, onConfigure }: { view: CostView; readiness: ReadinessItem[]; onConfigure?: () => void }) {
  const { client, internal, profit, budgets, running } = view;
  const status = configStatus(internal.state, readiness, internal.missing.length);
  const summary = internalSummary(view);
  const complete = internal.state === "complete";
  return (
    <div className="space-y-4" data-testid="cost-panel">
      {/* A. what the client pays for development: always visible */}
      <Section icon={<Receipt size={14} className="text-sky-300" />} title="A. Client development cost" tag="Shown to the client" accent="border-sky-400/20">
        <Rows rows={client.rows} />
        <p className="text-[11px] text-slate-500">{client.note}</p>
        {(budgets.client.length > 0) && <div className="border-t border-white/[.06] pt-2"><Rows rows={budgets.client} /></div>}
      </Section>

      {/* B. what delivery costs the studio: folded unless the setup is complete */}
      <Collapsible
        icon={<Wallet size={14} className="text-amber-300" />}
        title="B. Internal studio cost"
        accent="border-amber-400/20"
        state={internal.state === "complete" ? "complete" : internal.state === "incomplete" ? "incomplete" : "not-configured"}
        statusLabel={status.label}
        figures={summary ? [{ label: "Internal cost", value: summary.cost }] : undefined}
        open={complete}
        testId="internal-cost"
      >
        {complete ? (
          <>
            {internal.groups.map((g) => (
              <div key={g.title}>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{g.title}</p>
                <Rows rows={g.rows} />
              </div>
            ))}
            <Rows rows={[internal.total]} />
            {internal.split.length > 0 && <Rows rows={internal.split} />}
            {internal.assumptions.length > 0 && (
              <details className="text-slate-500">
                <summary className="cursor-pointer text-[11px]">How this is calculated</summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">{internal.assumptions.map((m) => <li key={m}>{m}</li>)}</ul>
              </details>
            )}
            {(budgets.internal.length > 0) && <div className="border-t border-white/[.06] pt-2"><Rows rows={budgets.internal} /></div>}
          </>
        ) : (
          <>
            <SetupStatus status={status} projectMissing={internal.missing} onConfigure={onConfigure} />
            {internal.state === "incomplete" && (
              <details className="text-slate-500">
                <summary className="cursor-pointer text-[11px]">Partial figures (not the final cost)</summary>
                <div className="mt-2 space-y-3">
                  {internal.groups.map((g) => (
                    <div key={g.title}>
                      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{g.title}</p>
                      <Rows rows={g.rows} />
                    </div>
                  ))}
                  <Rows rows={[internal.total]} />
                </div>
              </details>
            )}
          </>
        )}
      </Collapsible>

      {/* C. profitability: folded unless the setup is complete */}
      <Collapsible
        icon={<TrendingUp size={14} className="text-emerald-300" />}
        title="C. Profitability"
        accent="border-emerald-400/20"
        state={profit.state === "complete" ? "complete" : profit.state === "incomplete" ? "incomplete" : "not-configured"}
        statusLabel={complete ? profit.viabilityLabel : status.label}
        figures={summary ? [{ label: "Gross profit", value: summary.grossProfit }, { label: "Margin", value: summary.grossMargin }] : undefined}
        open={complete}
        testId="profitability"
      >
        {complete ? (
          <>
            <Rows rows={profit.rows} />
            <div className={cn("rounded-lg border p-2.5", TONE[profit.tone])}>
              <p className="flex items-center gap-1.5 font-semibold">
                {profit.tone === "good" ? <CheckCircle2 size={14} /> : profit.tone === "neutral" ? <CircleHelp size={14} /> : <AlertTriangle size={14} />}
                {profit.viabilityLabel}
              </p>
              {profit.reasons.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px]">{profit.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
            </div>
            {profit.warnings.length > 0 && <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-amber-200/90">{profit.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          </>
        ) : (
          <>
            <p className="text-slate-400">Gross profit and gross margin appear here once the internal cost setup is complete. See the status under B.</p>
            {onConfigure && <button type="button" onClick={onConfigure} className="text-[11px] font-semibold text-violet-300 hover:text-white">Open Business &amp; pricing</button>}
          </>
        )}
        <p className="text-[11px] text-slate-500">{profit.note}</p>
      </Collapsible>

      {/* D. what the client pays separately */}
      <Section icon={<Receipt size={14} className="text-teal-300" />} title="D. Client running costs" tag="Billed separately" accent="border-teal-400/20">
        <p className="text-[11px] text-slate-500">{running.note}</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-[11px]" data-testid="running-costs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">
                <th className="py-1 pr-2 font-medium">Service</th>
                <th className="py-1 pr-2 font-medium">Provider</th>
                <th className="py-1 pr-2 font-medium">Amount</th>
                <th className="py-1 pr-2 font-medium">Billing</th>
                <th className="py-1 pr-2 font-medium">Need</th>
                <th className="py-1 pr-2 font-medium">Paid by</th>
                <th className="py-1 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {running.rows.map((r) => (
                <tr key={r.id} className="border-t border-white/[.05] align-top text-slate-300">
                  <td className="py-1.5 pr-2">{r.service}{r.note && <span className="block text-[10px] text-slate-600">{r.note}</span>}</td>
                  <td className="py-1.5 pr-2 text-slate-400">{r.provider}</td>
                  <td className={cn("py-1.5 pr-2 tabular-nums", r.unknown && "italic text-amber-200/80")}>{r.amount}</td>
                  <td className="py-1.5 pr-2">{r.frequency}</td>
                  <td className="py-1.5 pr-2">{r.necessity}</td>
                  <td className="py-1.5 pr-2">{r.payer}</td>
                  <td className="py-1.5">{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Client pays, separate from the quotation</p>
          <Rows rows={running.totals} />
        </div>
        {running.studioPays.length > 0 && (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Paid by the studio (not part of the profit above)</p>
            <Rows rows={running.studioPays} />
          </div>
        )}
        {running.notes.length > 0 && <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-slate-500">{running.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      </Section>
    </div>
  );
}

/** The cost sections for a quote that is still being built: calculated here from the current choices. */
export function WizardCostPanel({
  quote,
  requirement,
  rates,
  config,
  recommendation,
  onConfigure,
}: {
  quote: Quote;
  requirement: Requirement;
  rates: RateCard;
  config: CostConfig | null;
  recommendation?: Pick<RecommendedOption, "ids" | "maintenance">;
  onConfigure?: () => void;
}) {
  const view = useMemo(() => {
    if (!config) return null;
    try {
      const estimate = estimateCosts({ quote, rates, config, requirement, recommendation });
      const suggested = suggestRecurringItems(estimate.technology.stackIds, requirement, config.runningCosts);
      return buildCostView(estimate, config, calcRecurring(suggested, config));
    } catch {
      return null;
    }
  }, [quote, requirement, rates, config, recommendation]);
  if (!config) return <Card className="text-xs text-slate-400">Loading cost settings...</Card>;
  if (!view) return <Card className="text-xs text-rose-300">The cost estimate could not be calculated.</Card>;
  return <CostPanel view={view} readiness={costConfigReadiness(config)} onConfigure={onConfigure} />;
}

/** The cost sections for a saved quotation: loaded from the (team-only) costs route. */
export function LeadCostPanel({ lead, onConfigure }: { lead: Lead; onConfigure?: () => void }) {
  const [data, setData] = useState<{ costs: CostEstimate; config: CostConfig; runningCosts: RecurringCost } | null>(null);
  const [error, setError] = useState("");
  const quotationId = lead.quotation?.id;
  useEffect(() => {
    if (!quotationId) return;
    jsonFetch<{ costs: CostEstimate; config: CostConfig; runningCosts: RecurringCost }>(`/api/business/leads/${lead.id}/costs`)
      .then((r) => { setData(r); setError(""); })
      .catch((e: Error) => setError(e.message));
  }, [lead.id, quotationId, lead.updatedAt]);
  const view = useMemo(() => (data ? buildCostView(data.costs, data.config, data.runningCosts) : null), [data]);
  if (!lead.quotation) return null;
  if (error) return <Card className="text-xs text-rose-300">{error}</Card>;
  if (!view) return <Card className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={14} className="animate-spin" /> Calculating costs...</Card>;
  return (
    <details className="group" open>
      <summary className="mb-3 flex cursor-pointer items-center justify-between rounded-lg border border-white/[.08] bg-white/[.03] px-4 py-2.5 text-xs font-semibold text-slate-200">
        <span>Costs and profitability</span>
        <span className="text-[10px] font-normal text-slate-500">{VIABILITY_LABELS[view.profit.viability]}</span>
      </summary>
      <CostPanel view={view} readiness={costConfigReadiness(data!.config)} onConfigure={onConfigure} />
    </details>
  );
}

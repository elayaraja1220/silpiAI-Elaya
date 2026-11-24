"use client";

import { estimateStatus, summarize, type ClarificationItem, type InsightDecision } from "@/lib/business/clarifications";
import type { RequirementInsights } from "@/lib/business/types";

import { RequirementExplorer } from "./requirement-explorer";

/**
 * The requirement dashboard: summary cards, whether the estimate is preliminary or validated, and the filterable requirement list.
 * Every number is calculated from the tracked items, never typed in. When `onDecide` is given, the team can accept, reject or ask
 * the client about each proposed requirement and assumption.
 */
export function ClarificationSummary({
  insights,
  documents = [],
  onDecide,
  busy = false,
}: {
  insights: RequirementInsights;
  /** The files the analysis was read from. */
  documents?: string[];
  onDecide?: (itemId: string, decision: InsightDecision) => void;
  busy?: boolean;
  /** Kept for older callers; the list now opens and closes by module. */
  defaultOpen?: boolean;
}) {
  const items: ClarificationItem[] = insights.tracker ?? [];
  const stats = summarize(items, insights.confirmed.length, insights.lastChange);
  const status = estimateStatus(items);

  // Records made before the tracker existed only have the three plain lists.
  if (items.length === 0 && insights.confirmed.length === 0 && insights.questions.length === 0 && insights.assumptions.length === 0) return null;
  const legacy = items.length === 0;

  const cards: { label: string; value: number; tone: string; testid: string; hint?: string }[] = [
    { label: "Confirmed requirements", value: stats.confirmedRequirements, tone: "text-emerald-300", testid: "sum-confirmed", hint: stats.functionalRequirements + stats.nonFunctionalRequirements > 0 ? `${stats.functionalRequirements} functional · ${stats.nonFunctionalRequirements} non-functional` : undefined },
    { label: "Critical unanswered", value: legacy ? insights.questions.length : stats.criticalUnanswered, tone: "text-rose-300", testid: "sum-critical", hint: legacy ? "priority not recorded" : "block a final quotation" },
    { label: "Non-critical unanswered", value: legacy ? 0 : stats.nonCriticalUnanswered, tone: "text-orange-300", testid: "sum-noncritical", hint: legacy ? undefined : `${stats.unansweredQuestions} unanswered in all` },
    { label: "Assumed requirements", value: legacy ? insights.assumptions.length : stats.assumedRequirements, tone: "text-amber-300", testid: "sum-assumed" },
    { label: "Pending client approval", value: legacy ? insights.assumptions.length : stats.pendingApproval, tone: "text-amber-300", testid: "sum-pending" },
    { label: "Newly discovered", value: stats.newlyDiscovered, tone: "text-sky-300", testid: "sum-new", hint: stats.newlyDiscovered > 0 ? `${stats.discoveredAccepted} accepted · ${stats.discoveredRejected} rejected` : undefined },
    { label: "Duplicates removed", value: stats.duplicatesRemoved, tone: "text-slate-300", testid: "sum-dupes", hint: "merged, not counted twice" },
  ];

  return (
    <div data-testid="clarification-summary" className="text-xs">
      {!legacy && (
        <div
          data-testid="estimate-status"
          className={`rounded-lg border px-3 py-2 ${status.level === "preliminary" ? "border-amber-400/30 bg-amber-500/10 text-amber-100" : "border-emerald-400/25 bg-emerald-500/10 text-emerald-100"}`}
        >
          <p><b>{status.label}.</b>{" "}
            {status.level === "preliminary"
              ? "The price can be shown to the client as a preliminary estimate only. A final quotation stays blocked until these are settled:"
              : status.deferred.length > 0
                ? "Nothing else is waiting for a decision. The items below are left out of the price and the client is told so; they get a separate quotation later."
                : "Nothing is waiting for a decision."}
          </p>
          {status.deferred.length > 0 && (
            <ul data-testid="deferred-list" className="mt-1 list-disc pl-4 text-[11px] opacity-90">
              {status.deferred.map((d) => <li key={d}>Not in the price: {d}</li>)}
            </ul>
          )}
          {status.level === "preliminary" && (
            <ul className="mt-1 list-disc pl-4 text-[11px] opacity-90">
              {status.blockers.criticalQuestions > 0 && <li>{status.blockers.criticalQuestions} critical question{status.blockers.criticalQuestions === 1 ? "" : "s"} unanswered</li>}
              {status.blockers.proposals > 0 && <li>{status.blockers.proposals} newly discovered requirement{status.blockers.proposals === 1 ? "" : "s"} waiting for a decision</li>}
              {status.blockers.assumptions > 0 && <li>{status.blockers.assumptions} assumption{status.blockers.assumptions === 1 ? "" : "s"} waiting for the client&apos;s approval</li>}
            </ul>
          )}
        </div>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4" data-testid="summary-cards">
        {cards.map((c) => (
          <div key={c.label} className="min-w-0 rounded-lg border border-white/[.08] bg-white/[.03] px-2.5 py-2">
            <dd className={`text-xl font-semibold tabular-nums ${c.tone}`} data-testid={c.testid}>{c.value}</dd>
            <dt className="text-[11px] text-slate-300">{c.label}</dt>
            {c.hint && <p className="truncate text-[10px] text-slate-500" title={c.hint}>{c.hint}</p>}
          </div>
        ))}
      </dl>

      <div className="mt-4">
        {legacy ? (
          <div className="space-y-3">
            {insights.confirmed.length > 0 && (
              <details>
                <summary className="cursor-pointer text-emerald-200">Confirmed requirements ({insights.confirmed.length})</summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-400">{insights.confirmed.map((c) => <li key={c}>{c}</li>)}</ul>
              </details>
            )}
            {insights.questions.length > 0 && (
              <details open>
                <summary className="cursor-pointer text-rose-200">Unanswered: ask the client ({insights.questions.length})</summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-400">{insights.questions.map((q) => <li key={q}>{q}</li>)}</ul>
              </details>
            )}
            {insights.assumptions.length > 0 && (
              <details>
                <summary className="cursor-pointer text-amber-200">Assumed: confirm with the client ({insights.assumptions.length})</summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-400">{insights.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
              </details>
            )}
          </div>
        ) : (
          <RequirementExplorer items={items} documents={documents} onDecide={onDecide} busy={busy} />
        )}
      </div>
    </div>
  );
}

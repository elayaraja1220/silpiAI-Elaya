"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, Loader2, XCircle } from "lucide-react";

import type { InsightDecision } from "@/lib/business/clarifications";
import type { LeadAnalysis } from "@/lib/business/estimate-ledger";
import type { Quote, RequirementInsights } from "@/lib/business/types";

import { ClarificationSummary } from "./clarification-summary";
import { EstimateBreakdown } from "./estimate-breakdown";
import { EstimateCompare } from "./estimate-compare";

const CONFIDENCE_TONE = { high: "text-emerald-300", medium: "text-amber-300", low: "text-rose-300", unknown: "text-slate-400" } as const;

function Section({ title, hint, defaultOpen = false, testid, children }: { title: string; hint?: string; defaultOpen?: boolean; testid: string; children: React.ReactNode }) {
  return (
    <details open={defaultOpen} className="group rounded-xl border border-white/[.07] bg-white/[.02]" data-testid={testid}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs font-semibold text-slate-200 [&::-webkit-details-marker]:hidden">
        <ChevronDown size={14} className="shrink-0 text-slate-500 transition group-open:rotate-180" />
        <span className="min-w-0 flex-1">{title}</span>
        {hint && <span className="shrink-0 text-[11px] font-normal text-slate-500">{hint}</span>}
      </summary>
      <div className="border-t border-white/[.05] px-3 py-3">{children}</div>
    </details>
  );
}

/**
 * Requirement analysis and the estimate explained, for one project: the requirement dashboard (cards, filters, search, list by
 * module, with the team's accept / reject / clarify decisions), the step-by-step breakdown of the price, a comparison of any two
 * versions of the estimate, how far the estimate can be trusted, and the automatic consistency checks.
 * Everything is worked out by the server from the saved data.
 */
export function AnalysisPanel({
  leadId,
  insights,
  quotation,
  documents,
  refreshKey,
  onDecide,
  busy,
}: {
  leadId: string;
  insights: RequirementInsights;
  quotation?: Quote;
  documents: string[];
  /** Changes whenever the project was saved (a decision, a new quotation), so the numbers are read again. */
  refreshKey: string;
  onDecide: (itemId: string, decision: InsightDecision) => void;
  busy: boolean;
}) {
  const [analysis, setAnalysis] = useState<LeadAnalysis | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    fetch(`/api/business/leads/${leadId}/analysis`)
      .then((r) => r.json())
      .then((r: { success?: boolean; analysis?: LeadAnalysis; error?: string }) => {
        if (!live) return;
        if (!r.success || !r.analysis) throw new Error(r.error || "Could not load the analysis.");
        setAnalysis(r.analysis);
        setError("");
      })
      .catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [leadId, refreshKey]);

  return (
    <div className="space-y-3" data-testid="analysis-panel">
      <Section title="Requirements" hint="dashboard, filters and search" defaultOpen testid="section-requirements">
        <ClarificationSummary insights={insights} documents={documents} onDecide={onDecide} busy={busy} />
      </Section>

      {error && <p className="rounded-md border border-rose-400/20 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-200">{error}</p>}
      {!analysis && !error && <p className="flex items-center gap-2 text-xs text-slate-500"><Loader2 size={13} className="animate-spin" /> Reading the estimate...</p>}

      {quotation && (
        <Section title="How the estimate is calculated" hint="hours, cost per module, GST, final quotation" testid="section-breakdown">
          <EstimateBreakdown quote={quotation} basis={analysis?.basis} team={analysis?.team} />
        </Section>
      )}

      {analysis && (
        <>
          <Section title="Estimate versions and what changed" hint={`${analysis.digests.length} version${analysis.digests.length === 1 ? "" : "s"}`} testid="section-versions">
            <EstimateCompare key={analysis.digests.map((d) => d.number).join("|")} digests={analysis.digests} />
          </Section>

          <Section
            title="Estimation confidence"
            hint={analysis.confidence.level === "unknown" ? "unknown" : `${analysis.confidence.level} (${analysis.confidence.score}/100)`}
            testid="section-confidence"
          >
            <div data-testid="confidence" className="text-xs">
              <p className="font-semibold text-slate-300">
                <span className={CONFIDENCE_TONE[analysis.confidence.level]}>{analysis.confidence.level}</span>
                {analysis.confidence.level !== "unknown" && <span className="font-normal text-slate-500"> ({analysis.confidence.score}/100)</span>}
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-400">{analysis.confidence.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              <p className="mt-2 text-slate-500" data-testid="page-views">
                Pages: {analysis.pages.listed} listed = {analysis.pages.unique} unique + {analysis.pages.roleSpecificViews} role-specific view{analysis.pages.roleSpecificViews === 1 ? "" : "s"} (public {analysis.pages.byRole.public}, customer {analysis.pages.byRole.customer}, agent {analysis.pages.byRole.agent}, admin {analysis.pages.byRole.admin}). All listed pages are priced.
              </p>
            </div>
          </Section>

          <Section title="Consistency checks" hint={analysis.consistent ? "all passed" : "some failed"} defaultOpen={!analysis.consistent} testid="section-checks">
            <div data-testid="checks" className="text-xs">
              <ul className="space-y-1">
                {analysis.checks.map((c) => (
                  <li key={c.id} className="flex items-start gap-1.5 text-slate-400">
                    {c.ok ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-400" /> : <XCircle size={13} className="mt-0.5 shrink-0 text-rose-400" />}
                    <span><span className={c.ok ? "text-slate-300" : "text-rose-200"}>{c.label}.</span> {c.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

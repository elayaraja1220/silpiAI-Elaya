import { AlertTriangle, CheckCircle2, CircleAlert, Lightbulb, MoveRight } from "lucide-react";

import { BUDGET_STATUS_LABELS } from "@/lib/business/budget";
import { formatINR } from "@/lib/business/pricing";
import type { BudgetCheck, DesignSource, ModuleId } from "@/lib/business/types";
import { cn } from "@/lib/utils";

const TONE: Record<BudgetCheck["status"], string> = {
  none: "border-white/[.08] bg-white/[.02] text-slate-300",
  within: "border-emerald-400/30 bg-emerald-500/10 text-emerald-100",
  near: "border-amber-400/30 bg-amber-500/10 text-amber-100",
  over: "border-rose-400/30 bg-rose-500/10 text-rose-100",
  "scope-adjustment": "border-rose-500/50 bg-rose-600/15 text-rose-100",
};

/**
 * Budget vs the actual price. The price is never changed to fit: this shows
 * the difference, what the cost is made of, and optional features that could
 * move to Phase 2 (only when the team / client chooses to).
 */
export function BudgetSummary({
  check,
  onMoveToPhase2,
  onApplyPlan,
  onChangeDesign,
  compact = false,
}: {
  check: BudgetCheck;
  onMoveToPhase2?: (m: ModuleId) => void;
  /** Applies the page plan: planned pages stay, the rest move to Phase 2. */
  onApplyPlan?: () => void;
  /** Switches to a cheaper design choice. */
  onChangeDesign?: (design: DesignSource) => void;
  compact?: boolean;
}) {
  if (check.status === "none") return null;
  const Icon = check.status === "within" ? CheckCircle2 : check.status === "near" ? CircleAlert : AlertTriangle;
  const over = check.difference < 0;
  const plan = check.pagePlan;
  return (
    <div className={cn("rounded-lg border p-3 text-xs", TONE[check.status])}>
      <p className="flex items-center gap-1.5 font-semibold"><Icon size={14} /> {BUDGET_STATUS_LABELS[check.status]}</p>
      <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-slate-300">
        <dt>Client budget</dt><dd className="text-right tabular-nums">{formatINR(check.budget)}</dd>
        <dt>Estimated total (incl. GST)</dt><dd className="text-right tabular-nums">{formatINR(check.total)}</dd>
        <dt className="font-semibold">{over ? "Over budget by" : "Remaining budget"}</dt>
        <dd className={cn("text-right font-semibold tabular-nums", over ? "text-rose-300" : "text-emerald-300")}>{formatINR(Math.abs(check.difference))}</dd>
      </dl>

      {over && plan && (
        <div className="mt-3 rounded-md border border-white/15 bg-black/20 p-2.5 text-slate-200">
          <p className="flex items-center gap-1.5 font-semibold text-white"><Lightbulb size={13} className="text-amber-300" /> What {formatINR(check.budget)} can build</p>
          {plan.pages.length > 0 ? (
            <>
              <p className="mt-1">
                This budget covers about{" "}
                <span className="font-semibold text-white">{plan.minPages === plan.maxPages ? plan.minPages : `${plan.minPages} to ${plan.maxPages}`} page{plan.maxPages === 1 ? "" : "s"}</span>
                {plan.contactForm ? " with a contact form" : ""}.
              </p>
              <p className="mt-1.5 text-slate-300">
                Suggested: <span className="text-white">{plan.pages.length} page{plan.pages.length === 1 ? "" : "s"}{plan.contactForm ? " + contact form" : ""}</span> for{" "}
                <span className="font-semibold tabular-nums text-emerald-300">{formatINR(plan.total)}</span>
              </p>
              {plan.sections && <p className="mt-1 text-[11px] text-slate-400">Compact pages to fit the budget: Home with 2 sections, other pages with 1.</p>}
              <ol className="mt-1 flex flex-wrap gap-1">
                {plan.pages.map((p, i) => <li key={p} className="rounded bg-white/10 px-1.5 py-0.5">{i + 1}. {p}</li>)}
                {plan.contactForm && <li className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-100">+ Contact form</li>}
              </ol>
              {plan.phase2Pages.length > 0 && (
                <p className="mt-1.5 text-[11px] text-slate-400">
                  Phase 2, later ({plan.phase2Pages.length}): {plan.phase2Pages.join(", ")}. Kept on record, added when the budget allows.
                </p>
              )}
              {onApplyPlan && (
                <button type="button" onClick={onApplyPlan} className="mt-2 w-full rounded-md bg-emerald-500/90 px-2 py-1.5 text-[11px] font-semibold text-white hover:bg-emerald-400">
                  Use this scope (client agreed)
                </button>
              )}
            </>
          ) : (
            <p className="mt-1">
              Even the set-up with one page costs {formatINR(plan.minimumTotal)}. Ask the client for a bigger budget, or lower your rates in Business & pricing.
            </p>
          )}
        </div>
      )}

      {over && !compact && (
        <>
          <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Why it costs more</p>
          <ul className="mt-1 space-y-0.5 text-slate-300">
            {check.contributors.slice(0, 5).map((c) => (
              <li key={c.label} className="flex justify-between gap-3"><span className="min-w-0 truncate">{c.label}</span><span className="shrink-0 tabular-nums text-slate-400">{formatINR(c.amount)} · {c.share}%</span></li>
            ))}
          </ul>
        </>
      )}

      {over && check.suggestions.length > 0 && (
        <>
          <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Optional features that could move to Phase 2</p>
          <ul className="mt-1 space-y-1 text-slate-300">
            {check.suggestions.map((s) => (
              <li key={s.module} className="flex items-center justify-between gap-2">
                <span className="min-w-0">{s.label} <span className="text-slate-500">saves {formatINR(s.saving)}</span></span>
                {onMoveToPhase2 && (
                  <button type="button" onClick={() => onMoveToPhase2(s.module)} className="flex shrink-0 items-center gap-1 rounded-md border border-white/15 px-1.5 py-0.5 text-[10px] text-slate-200 hover:bg-white/10">
                    Phase 2 <MoveRight size={10} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {check.totalAfterSuggestions !== undefined && (
            <p className="mt-1 text-[11px] text-slate-400">
              {check.status === "over" ? "Moving these brings the total to " : "Even moving every optional feature gives "}
              <span className="tabular-nums text-slate-200">{formatINR(check.totalAfterSuggestions)}</span>.
            </p>
          )}
        </>
      )}
      {over && !compact && check.designOptions && check.designOptions.length > 0 && (
        <>
          <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Cheaper design</p>
          <ul className="mt-1 space-y-1 text-slate-300">
            {check.designOptions.map((o) => (
              <li key={o.design} className="flex items-center justify-between gap-2">
                <span className="min-w-0">{o.label} <span className="text-slate-500">saves {formatINR(o.saving)}</span></span>
                {onChangeDesign && <button type="button" onClick={() => onChangeDesign(o.design)} className="shrink-0 rounded-md border border-white/15 px-1.5 py-0.5 text-[10px] text-slate-200 hover:bg-white/10">Use</button>}
              </li>
            ))}
          </ul>
        </>
      )}
      {over && !compact && (
        <div className="mt-3 rounded-md border border-white/10 bg-black/20 p-2.5 text-[11px] text-slate-300">
          <p className="font-semibold text-white">Talk to the client</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {check.askMore && <li>The {check.askMore.title} package ({formatINR(check.askMore.total)}) needs {formatINR(check.askMore.extra)} more budget. Explain its extra value (longer support, more revisions, speed and security check).</li>}
            <li>
              Split the payment to ease the load, for example 40% / 30% / 30%:{" "}
              <span className="tabular-nums text-slate-200">{formatINR(Math.round(check.total * 0.4))} / {formatINR(Math.round(check.total * 0.3))} / {formatINR(check.total - Math.round(check.total * 0.4) - Math.round(check.total * 0.3))}</span> (start / demo / delivery).
            </li>
            <li>Domain and hosting are separate; the client can buy them directly.</li>
            <li>The price is not reduced automatically. Any discount must be approved by you, within the limit in Business &amp; pricing.</li>
          </ul>
        </div>
      )}
      {check.status === "scope-adjustment" && (
        <p className="mt-2 text-[11px] text-slate-300">
          The confirmed pages and must-have features cost more than the budget. Agree fewer pages or a bigger budget with the client; nothing is removed without their approval.
        </p>
      )}
      {over && check.fittingTier && (
        <p className="mt-2 text-[11px] text-slate-300">The {check.fittingTier.title} package ({formatINR(check.fittingTier.total)}) fits the budget.</p>
      )}
    </div>
  );
}

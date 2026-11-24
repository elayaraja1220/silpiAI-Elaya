"use client";

import { moduleEffort, type EstimateBasis, type TeamEffort } from "@/lib/business/estimate-ledger";
import { formatINR } from "@/lib/business/pricing";
import type { Quote } from "@/lib/business/types";

/**
 * How the price is made up, step by step: hours and cost for each part of the project, what the hours are multiplied by, where
 * testing and project management are, whether a contingency is added, then GST and the final quotation.
 * It only explains the quote it is given. It never works out a price itself, and shows nothing the quote does not contain.
 */
export function EstimateBreakdown({ quote, basis, team, compact = false }: { quote: Quote; basis?: EstimateBasis | null; team?: TeamEffort | null; compact?: boolean }) {
  if (quote.hourly) return null;
  const effort = moduleEffort(quote);
  const subtotalFromLines = effort.groups.reduce((s, g) => s + g.amount, 0);
  const setup = effort.groups.find((g) => g.group.startsWith("Set-up"));
  const gst = quote.gst;
  const qa = team?.find((t) => t.role === "qa");
  const pm = team?.find((t) => t.role === "pm");

  return (
    <div className="space-y-4 text-xs" data-testid="estimate-breakdown">
      <section>
        <p className="font-semibold text-slate-300">Module-wise hours and cost</p>
        {basis && (
          <p className="mt-1 text-[11px] text-slate-500" data-testid="breakdown-basis">
            Each development line is the base hours × complexity <b className="text-slate-300">{basis.complexityLabel}</b> (×{basis.complexityMultiplier})
            {basis.technologyFactor !== 1 ? <> × technology (×{Math.round(basis.technologyFactor * 100) / 100})</> : null} at {formatINR(basis.hourlyRate)} per hour. About {basis.hoursPerWeek} hours make one week.
          </p>
        )}
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[26rem] text-left">
            <thead className="text-[11px] text-slate-500">
              <tr><th className="py-1 font-medium">Module</th><th className="py-1 text-right font-medium">Hours</th><th className="hidden py-1 pl-3 font-medium sm:table-cell">Share of effort</th><th className="py-1 text-right font-medium">Cost</th></tr>
            </thead>
            <tbody className="text-slate-300">
              {effort.groups.map((g) => {
                const share = effort.totalHours > 0 ? (g.hours / effort.totalHours) * 100 : 0;
                return (
                  <tr key={g.group} className="border-t border-white/5 align-top">
                    <td className="py-1.5 pr-2">
                      {g.lines.length > 1 ? (
                        <details>
                          <summary className="cursor-pointer">{g.group} <span className="text-slate-500">· {g.lines.length} items</span></summary>
                          <ul className="mt-1 space-y-0.5 pl-2 text-[11px] text-slate-400">
                            {g.lines.map((l) => <li key={l.description} className="flex justify-between gap-3"><span className="min-w-0 truncate">{l.description.replace(/^Page: /, "")}</span><span className="shrink-0 tabular-nums">{l.hours} h · {formatINR(l.amount)}</span></li>)}
                          </ul>
                        </details>
                      ) : g.group}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{g.hours}</td>
                    <td className="hidden py-1.5 pl-3 sm:table-cell">
                      <span className="flex items-center gap-2"><span className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10"><span className="block h-full rounded-full bg-violet-400/70" style={{ width: `${Math.max(2, Math.round(share))}%` }} /></span><span className="tabular-nums text-slate-500">{Math.round(share)}%</span></span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatINR(g.amount)}</td>
                  </tr>
                );
              })}
              <tr className="border-t border-white/10 font-semibold">
                <td className="py-1.5">Development total</td>
                <td className="py-1.5 text-right tabular-nums" data-testid="breakdown-hours">{effort.totalHours}</td>
                <td className="hidden sm:table-cell" />
                <td className="py-1.5 text-right tabular-nums">{formatINR(subtotalFromLines)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {!effort.matchesQuote && <p className="mt-1 text-rose-300">The module hours ({effort.totalHours} h) do not match the quoted hours ({quote.totalHours} h). Re-price the quotation.</p>}
      </section>

      {!compact && (
        <section data-testid="breakdown-team">
          <p className="font-semibold text-slate-300">Testing, project management and contingency</p>
          <ul className="mt-1 space-y-1 text-slate-400">
            <li>
              <b className="text-slate-300">Testing and QA:</b> included in the hours above, not billed as a separate line.{setup ? ` The set-up line (${setup.hours} h) covers testing and deployment.` : ""}
              {qa ? ` Internal split: about ${qa.hours} h of testing and QA.` : ""}
            </li>
            <li>
              <b className="text-slate-300">Project management:</b> included in the hours above, not billed as a separate line.{pm ? ` Internal split: about ${pm.hours} h of project management.` : ""}
            </li>
            <li><b className="text-slate-300">Contingency:</b> none is added. The quotation has no contingency line, so the price is the hours above plus GST.</li>
            {!team && <li className="text-slate-500">The studio has not set up its role allocation, so the hours are not split by role.</li>}
          </ul>
          {team && team.length > 0 && (
            <p className="mt-1 text-[11px] text-slate-500">Internal split of the hours by role (team only): {team.map((t) => `${t.label} ${t.hours} h`).join(" · ")}.</p>
          )}
        </section>
      )}

      <section data-testid="breakdown-money">
        <p className="font-semibold text-slate-300">From hours to the final quotation</p>
        <dl className="mt-1 space-y-1">
          <Row label={`Development (${quote.totalHours} h)`} value={formatINR(subtotalFromLines)} />
          {quote.discount > 0 && <Row label="Discount" value={`- ${formatINR(quote.discount)}`} />}
          <Row label="Taxable value (before GST)" value={formatINR(quote.taxable)} strong />
          {gst.mode === "intra" && <><Row label={`CGST (${gst.rate / 2}%)`} value={formatINR(gst.cgst)} /><Row label={`SGST (${gst.rate / 2}%)`} value={formatINR(gst.sgst)} /></>}
          {gst.mode === "inter" && <Row label={`IGST (${gst.rate}%)`} value={formatINR(gst.igst)} />}
          {gst.mode === "export" && <Row label="GST (zero-rated export of services)" value={formatINR(0)} />}
          {quote.roundOff !== 0 && <Row label="Round off" value={formatINR(quote.roundOff)} />}
          <Row label="Final quotation (incl. GST)" value={formatINR(quote.grandTotal)} strong testid="breakdown-total" />
          <Row label="Estimated duration" value={`about ${quote.estimatedWeeks} week${quote.estimatedWeeks === 1 ? "" : "s"}`} />
        </dl>
      </section>
    </div>
  );
}

function Row({ label, value, strong, testid }: { label: string; value: string; strong?: boolean; testid?: string }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? "border-t border-white/10 pt-1 font-semibold text-slate-100" : "text-slate-400"}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums" data-testid={testid}>{value}</dd>
    </div>
  );
}

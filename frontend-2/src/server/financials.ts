// The five figures of a project, kept apart (server only). Reads the latest quotation, the existing cost estimate, the accepted hour split and the verified market rates.
// It writes nothing.
import { computeLeadCosts } from "@/lib/business/lead-costs";
import { assembleFinancials, humanEquivalent, type Financials } from "@/lib/business/financials";
import { StageError } from "@/lib/business/store";
import type { Lead } from "@/lib/business/types";
import { listEstimates } from "@/server/hour-split";
import { rateFor } from "@/server/pricing-data";

export function leadFinancials(lead: Lead): Financials {
  const q = lead.quotation;
  if (!q) throw new StageError("This project has no quotation yet.");
  const { costs } = computeLeadCosts(lead);
  const req = q.requirement ?? lead.requirement;
  const country = req.fixedBasis?.country ?? req.hourly?.country ?? lead.client.country ?? (lead.client.state !== "Outside India" ? "IN" : null);
  const levelId = req.fixedBasis?.levelId ?? req.hourly?.levelId ?? "mid";
  const levelAssumed = !(req.fixedBasis?.levelId ?? req.hourly?.levelId);
  const accepted = listEstimates(lead.id).find((e) => e.status === "accepted" && e.quotationId === q.id);
  const total = q.hourly ? q.hourly.expectedHours : q.totalHours;
  const a = humanEquivalent({
    split: accepted ? accepted.lines : null,
    totalHours: total,
    rateOf: (roleId) => rateFor({ country, roleId, levelId, mode: "hourly" }),
    country,
    levelId,
    levelAssumed,
    quoteCurrency: q.currency ?? "INR",
    inrPerUnit: q.inrPerUnit ?? 1,
  });
  return assembleFinancials(q, costs, a);
}

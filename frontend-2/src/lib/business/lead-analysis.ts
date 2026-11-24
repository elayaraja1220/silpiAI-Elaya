import { buildLeadAnalysis, type LeadAnalysis, type TeamEffort } from "./estimate-ledger";
import { ROLE_LABELS } from "./cost-types";
import { computeLeadCosts } from "./lead-costs";
import { getRateCard, quotationVersions, stageHistory } from "./store";
import type { Lead } from "./types";

/**
 * Server only. The requirement analysis and the explained estimate for one project, always worked out from the saved data.
 * The role split of the hours (testing and QA, project management...) comes from the studio's own cost allocation and is left out
 * when that is not set up: nothing is estimated here that the studio has not configured.
 */
export function leadAnalysis(lead: Lead): LeadAnalysis {
  let team: TeamEffort | null = null;
  try {
    const roles = computeLeadCosts(lead).costs.internal.human.roles;
    const list = roles.filter((r) => r.hours > 0).map((r) => ({ role: r.role, label: ROLE_LABELS[r.role], hours: Math.round(r.hours * 10) / 10 }));
    team = list.length > 0 ? list : null;
  } catch {
    team = null;
  }
  return buildLeadAnalysis({
    requirement: lead.requirement,
    quotation: lead.quotation,
    versionsOldestFirst: quotationVersions(lead.id),
    stage: lead.stage,
    history: stageHistory(lead.id),
    rates: getRateCard(),
    team,
  });
}

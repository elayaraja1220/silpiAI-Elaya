// What a client may see about their own fixed-price projects (server only).
//
// Everything here is read from the client's own workspace, by organization, so one client can never reach another's project. The shapes are written out field by field
// instead of passing a lead through: a field added to a lead later (a cost, a note, a work log) cannot reach a client by accident.
import { getDb } from "@/lib/business/db";
import { formatMoney, moneyOf } from "@/lib/business/money";
import { paymentStatus } from "@/lib/business/payment-status";
import { shareToken } from "@/lib/business/store";
import { nextStepFor, progressIndex, stepLabel } from "@/lib/client-progress";
import { STAGE_LABELS, type Lead, type Stage } from "@/lib/business/types";
import { clientDemoInfo } from "@/lib/demo/service";
import { getLeadForOrg, listLeadsForOrg } from "@/server/tenancy";

export type ClientProjectSummary = {
  id: string;
  title: string;
  stage: Stage;
  stageLabel: string;
  step: number;
  quotationNumber: string | null;
  total: string | null;
  updatedAt: string;
  next: { text: string; action: "review" | "pay" | "demo" | null };
};

const summary = (lead: Lead): ClientProjectSummary => ({
  id: lead.id,
  title: lead.requirement.title,
  stage: lead.stage,
  stageLabel: stepLabel(lead.stage),
  step: progressIndex(lead.stage),
  quotationNumber: lead.quotation?.number ?? null,
  total: lead.quotation ? formatMoney(lead.quotation.grandTotal, moneyOf(lead.quotation)) : null,
  updatedAt: lead.updatedAt,
  next: nextStepFor(lead.stage),
});

/** The client's own fixed-price projects, newest first. */
export const listClientProjects = (orgId: string): ClientProjectSummary[] => listLeadsForOrg(orgId).map(summary);

export type ClientProject = ClientProjectSummary & {
  summary: string;
  pages: string[];
  /** The secret link to the quotation page (compare packages, approve, how to pay). */
  quotationLink: string | null;
  validUntil: string | null;
  payment: { advanceDue: string; advancePaid: string; advanceRemaining: string; balanceDue: string; balancePaid: string } | null;
  payments: { id: string; kind: string; amount: string; mode: string; reference: string; receivedOn: string }[];
  demo: { url: string; expiresAt: string; protected: boolean } | null;
  history: { label: string; at: string }[];
};

/** One of the client's projects, or null when it does not exist or belongs to someone else (the two are indistinguishable on purpose). */
export function getClientProject(orgId: string, id: string): ClientProject | null {
  const lead = getLeadForOrg(orgId, id);
  if (!lead) return null;
  const q = lead.quotation;
  const money = moneyOf(q);
  const fmt = (n: number) => formatMoney(n, money);
  const status = paymentStatus(q, lead.payments);
  const history = getDb().prepare("SELECT from_stage AS fromStage, to_stage AS toStage, at FROM stage_history WHERE lead_id = ? ORDER BY id").all(id) as { fromStage: Stage | null; toStage: Stage; at: string }[];
  return {
    ...summary(lead),
    summary: lead.requirement.summary,
    pages: [...lead.requirement.pages],
    quotationLink: q ? `/q/${shareToken(lead.id)}` : null,
    validUntil: q?.validUntil ?? null,
    payment: q && ["approved", "advance_paid", "in_development", "testing", "demo_ready", "final_paid", "delivered"].includes(lead.stage)
      ? { advanceDue: fmt(status.advanceDue), advancePaid: fmt(status.advancePaid), advanceRemaining: fmt(status.advanceRemaining), balanceDue: fmt(status.balanceDue), balancePaid: fmt(status.balancePaid) }
      : null,
    payments: lead.payments.map((p) => ({ id: p.id, kind: p.kind === "advance" ? "Advance" : "Balance", amount: fmt(p.amount), mode: p.mode, reference: p.reference, receivedOn: p.receivedOn })),
    demo: lead.stage === "demo_ready" || lead.stage === "final_paid" || lead.stage === "delivered" ? clientDemoInfo(lead.id) : null,
    // Only the stage reached and when: the team's notes on a change are internal and are never read here.
    history: history.filter((h) => h.toStage !== "lost" && h.fromStage !== h.toStage).map((h) => ({ label: stepLabel(h.toStage), at: h.at })),
  };
}

export type ClientUpdate = { projectId: string; project: string; label: string; at: string };

/** Recent changes across the client's projects (what moved, and when), newest first. Derived from the stage changes: nothing is stored per person. */
export function clientUpdates(orgId: string, limit = 30): ClientUpdate[] {
  const leads = listLeadsForOrg(orgId);
  if (leads.length === 0) return [];
  const titles = new Map(leads.map((l) => [l.id, l.requirement.title]));
  const marks = leads.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT lead_id AS leadId, from_stage AS fromStage, to_stage AS toStage, at FROM stage_history WHERE lead_id IN (${marks}) ORDER BY id DESC LIMIT ?`)
    .all(...leads.map((l) => l.id), limit * 3) as { leadId: string; fromStage: Stage | null; toStage: Stage; at: string }[];
  return rows
    .filter((r) => r.fromStage !== r.toStage)
    .slice(0, limit)
    .map((r) => ({ projectId: r.leadId, project: titles.get(r.leadId) ?? "Project", label: stepLabel(r.toStage), at: r.at }));
}

/** Counts for the dashboard. */
export function projectCounts(orgId: string): { total: number; waitingForYou: number; inProgress: number; delivered: number } {
  const all = listClientProjects(orgId);
  return {
    total: all.length,
    waitingForYou: all.filter((p) => p.stage === "quoted" || p.stage === "approved" || p.stage === "demo_ready").length,
    inProgress: all.filter((p) => ["advance_paid", "in_development", "testing", "final_paid"].includes(p.stage)).length,
    delivered: all.filter((p) => p.stage === "delivered").length,
  };
}


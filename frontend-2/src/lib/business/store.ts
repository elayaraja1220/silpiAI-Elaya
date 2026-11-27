import { randomBytes, randomUUID } from "node:crypto";

import { getDb, transaction } from "./db";
import { buildQuote } from "./pricing";
import { listApprovals, listVersions, recordApproval, recordVersion, termChanges, termsOf, verifyApproval, type ApprovalRow, type VersionRow } from "./approvals";
import { getLiveInrPerUnit, type LiveRates } from "./live-rates";
import { enrichFixed, enrichHourly } from "@/server/pricing-data";
import { formatMoney, moneyOf } from "./money";
import { applyClientTech, describeTech, parseTechSelection, type TechSelection } from "./client-tech";
import { buildHourlyQuote, isHourly } from "./hourly";
import { buildProposals, compareProposals, defaultTier, toSummary } from "./proposals";
import { DEFAULT_RATE_CARD } from "./rate-card";
import { checkBudget } from "./budget";
import { applyCostPatch, emptyCostConfig, parseCostConfig } from "./cost-config";
import type { CostConfig, CostConfigPatch } from "./cost-types";
import { buildCatalog, mergeTechOverrides, parseTechOverrides, type TechEntry, type TechOverrides } from "./tech-catalog";
import { estimateStatus, confirmedTexts, deferredTexts, legacyLists, type ClarificationItem, type InsightDecision } from "./clarifications";
import { parseRateCard, ValidationError } from "./validate";
import { paymentStatus } from "./payment-status";
import { MODULES, type ModuleId } from "./types";
import type { Client, ClientResponse, Lead, Payment, PaymentKind, PaymentMode, Quotation, RateCard, Requirement, Stage, Tier, WorkEntry } from "./types";

/** Server-only data access for the business workflow. */

type LeadRow = {
  id: string;
  stage: string;
  client: string;
  requirement: string;
  created_at: string;
  updated_at: string;
  share_token: string | null;
  client_response: string | null;
  project_name: string | null;
};
type QuoteRow = { data: string };

const now = () => new Date().toISOString();

export class StageError extends Error {}

// ---- Rate card -------------------------------------------------------------

export function getRateCard(): RateCard {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'rate_card'").get() as { value: string } | undefined;
  if (!row) return DEFAULT_RATE_CARD;
  try {
    // Re-merge with defaults so cards saved by older versions gain new fields.
    return parseRateCard(JSON.parse(row.value), DEFAULT_RATE_CARD);
  } catch {
    return DEFAULT_RATE_CARD;
  }
}

/**
 * Brings the rupee value of each country price that follows the market up to today's market rate. A price typed in by hand is never touched, and a rate the
 * service could only ESTIMATE (it could not be reached) is never written: the figure stays as it was. Only the books and the fixed rupee prices move;
 * the hourly price in the client's currency does not, and no quotation already made changes (each keeps the rate it was made at).
 * Returns the codes that changed. `fetchRates` can be replaced in tests.
 */
export async function refreshAutoRates(fetchRates: () => Promise<LiveRates> = getLiveInrPerUnit): Promise<{ updated: string[]; source: LiveRates["source"] | "none" }> {
  const card = getRateCard();
  const entries = Object.entries(card.countryPricing ?? {}).filter(([, p]) => p.auto !== false);
  if (entries.length === 0) return { updated: [], source: "none" };
  const live = await fetchRates();
  if (live.source !== "live") return { updated: [], source: live.source };
  const next = { ...(card.countryPricing ?? {}) };
  const updated: string[] = [];
  for (const [code, p] of entries) {
    const market = live.inrPerUnit[code];
    if (!Number.isFinite(market) || market <= 0) continue;
    const rate = Math.round(market * 1e6) / 1e6;
    if (rate !== p.inrPerUnit || p.rateAsOf !== live.asOf) {
      next[code] = { ...p, inrPerUnit: rate, auto: true, rateAsOf: live.asOf };
      if (rate !== p.inrPerUnit) updated.push(code);
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(card.countryPricing)) saveRateCard({ ...card, countryPricing: next });
  return { updated, source: "live" };
}

export function saveRateCard(card: RateCard): void {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES ('rate_card', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(card));
}

// ---- Cost configuration -------------------------------------------------------

/**
 * The studio's own cost rates (internal hourly cost, AI prices, infrastructure...). Saved apart from the
 * rate card and the quotations. Empty until filled in: there are no built-in rates, so nothing is invented.
 */
export function getCostConfig(): CostConfig {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'cost_config'").get() as { value: string } | undefined;
  if (!row) return emptyCostConfig();
  try {
    return parseCostConfig(JSON.parse(row.value));
  } catch {
    return emptyCostConfig();
  }
}

/** Merges a validated change into the saved configuration; values that are not in the change are kept. */
export function saveCostConfig(patch: CostConfigPatch): CostConfig {
  const merged = applyCostPatch(getCostConfig(), patch);
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES ('cost_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(merged));
  return merged;
}

// ---- Technology catalog -----------------------------------------------------

/** The administrator's saved changes to the catalog (separate from the defaults, which are never overwritten). */
export function getTechOverrides(): TechOverrides {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'tech_catalog'").get() as { value: string } | undefined;
  if (!row) return {};
  try {
    return parseTechOverrides(JSON.parse(row.value));
  } catch {
    return {};
  }
}

export function getTechCatalog(): TechEntry[] {
  return buildCatalog(getTechOverrides());
}

/** Merges a validated change into the saved overrides; other saved entries are kept. */
export function saveTechOverrides(patch: TechOverrides): TechOverrides {
  const merged = mergeTechOverrides(getTechOverrides(), patch);
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES ('tech_catalog', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(merged));
  return merged;
}

// ---- Leads -----------------------------------------------------------------

function latestQuotation(leadId: string): Quotation | undefined {
  const row = getDb()
    .prepare("SELECT data FROM quotations WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(leadId) as QuoteRow | undefined;
  return row ? (JSON.parse(row.data) as Quotation) : undefined;
}

function paymentsOf(leadId: string): Payment[] {
  return getDb()
    .prepare("SELECT id, kind, amount, mode, reference, received_on AS receivedOn, recorded_at AS recordedAt FROM payments WHERE lead_id = ? ORDER BY recorded_at")
    .all(leadId) as Payment[];
}

function workLogOf(leadId: string): WorkEntry[] {
  return getDb()
    .prepare("SELECT id, item, hours, note, logged_on AS loggedOn, recorded_at AS recordedAt FROM work_log WHERE lead_id = ? ORDER BY logged_on DESC, recorded_at DESC")
    .all(leadId) as WorkEntry[];
}

function toLead(row: LeadRow): Lead {
  return {
    id: row.id,
    stage: row.stage as Stage,
    client: JSON.parse(row.client) as Client,
    requirement: JSON.parse(row.requirement) as Requirement,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    quotation: latestQuotation(row.id),
    shareToken: row.share_token ?? undefined,
    clientResponse: row.client_response ? (JSON.parse(row.client_response) as ClientResponse) : undefined,
    payments: paymentsOf(row.id),
    workLog: workLogOf(row.id),
    projectName: row.project_name ?? undefined,
  };
}

export function listLeads(): Lead[] {
  const rows = getDb().prepare("SELECT * FROM leads ORDER BY updated_at DESC").all() as LeadRow[];
  return rows.map(toLead);
}

export function getLead(id: string): Lead | null {
  const row = getDb().prepare("SELECT * FROM leads WHERE id = ?").get(id) as LeadRow | undefined;
  return row ? toLead(row) : null;
}

function nextQuoteNumber(): string {
  const year = new Date().getFullYear();
  // The highest number so far + 1 (not a count): deleting a quotation must never make the next number collide with an existing one.
  const prefix = `SQ-${year}-`;
  const row = getDb()
    .prepare("SELECT COALESCE(MAX(CAST(SUBSTR(number, ?) AS INTEGER)), 0) AS n FROM quotations WHERE number LIKE ?")
    .get(prefix.length + 1, `${prefix}%`) as { n: number };
  return `${prefix}${String(Number(row.n) + 1).padStart(4, "0")}`;
}

/** Freezes the lead's current quotation as the one that was approved, with who approved it and how. */
function approveLatest(db: ReturnType<typeof getDb>, leadId: string, by: string, channel: "client-link" | "team", note: string): void {
  const row = db.prepare("SELECT data FROM quotations WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(leadId) as { data: string } | undefined;
  if (!row) throw new StageError("There is no quotation to approve.");
  recordApproval(db, JSON.parse(row.data) as Quotation, row.data, by, channel, note);
}

function recordStage(leadId: string, from: Stage | null, to: Stage, note = ""): void {
  getDb()
    .prepare("INSERT INTO stage_history (lead_id, from_stage, to_stage, note, at) VALUES (?, ?, ?, ?, ?)")
    .run(leadId, from, to, note, now());
}

/**
 * Saves a new quotation for the lead with all three proposals and the chosen
 * one priced in full, and moves the lead to "quoted".
 */
function issueQuotation(lead: Pick<Lead, "id" | "stage" | "client" | "requirement">, tier: Tier | undefined, discount: number, note: string, clampDiscount = false): Quotation {
  const rates = getRateCard();
  if (isHourly(lead.requirement)) return issueHourlyQuotation(lead, discount, note, rates);
  const proposals = buildProposals(lead.requirement, lead.client, rates);
  const chosen = proposals.find((p) => p.tier === (tier ?? defaultTier(proposals, lead.requirement.budget)))!;
  // Only a discount the team approves is applied, never one made up to fit the budget.
  const maxDiscount = Math.floor((chosen.quote.subtotal * rates.maxDiscountPercent) / 100);
  // A discount the team already gave is kept when the price moves (never above the limit); a new one that is too big is refused.
  if (clampDiscount) discount = Math.min(discount, maxDiscount);
  if (discount > maxDiscount) {
    throw new ValidationError(`The discount can be at most ${rates.maxDiscountPercent}% (${formatMoney(maxDiscount, moneyOf(chosen.quote))}). Change the limit in Business & pricing.`);
  }
  const created = new Date();
  const validUntil = new Date(created.getTime() + rates.quoteValidityDays * 86_400_000);
  const quote = discount > 0 ? buildQuote(chosen.requirement, lead.client, rates, discount) : chosen.quote;
  const quotation: Quotation = {
    ...quote,
    id: randomUUID(),
    number: nextQuoteNumber(),
    leadId: lead.id,
    createdAt: created.toISOString(),
    validUntil: validUntil.toISOString(),
    business: rates.business,
    client: lead.client,
    requirement: chosen.requirement,
    tier: chosen.tier,
    proposals: proposals.map(toSummary),
    comparison: compareProposals(proposals, rates),
    budgetCheck: checkBudget(chosen.requirement, quote, lead.client, rates, proposals),
  };
  const db = getDb();
  const data = JSON.stringify(quotation);
  db.prepare("INSERT INTO quotations (id, lead_id, number, data, created_at) VALUES (?, ?, ?, ?, ?)").run(quotation.id, lead.id, quotation.number, data, quotation.createdAt);
  recordVersion(db, quotation, data, note);
  const label = `${quotation.number} · ${chosen.title}${note ? ` (${note})` : ""}`;
  if (lead.stage !== "quoted") {
    db.prepare("UPDATE leads SET stage = 'quoted', updated_at = ? WHERE id = ?").run(now(), lead.id);
    recordStage(lead.id, lead.stage, "quoted", label);
  } else {
    db.prepare("UPDATE leads SET updated_at = ? WHERE id = ?").run(now(), lead.id);
    recordStage(lead.id, "quoted", "quoted", label);
  }
  return quotation;
}

/** Hourly engagement: one quotation (rate, estimated hours and cap), no packages to choose from, no discount. */
function issueHourlyQuotation(lead: Pick<Lead, "id" | "stage" | "client" | "requirement">, discount: number, note: string, rates: RateCard): Quotation {
  if (discount > 0) throw new ValidationError("An hourly quotation is priced by its rate. Change the rate instead of adding a discount.");
  const created = new Date();
  const quotation: Quotation = {
    ...buildHourlyQuote(lead.requirement, lead.client, rates),
    id: randomUUID(),
    number: nextQuoteNumber(),
    leadId: lead.id,
    createdAt: created.toISOString(),
    validUntil: new Date(created.getTime() + rates.quoteValidityDays * 86_400_000).toISOString(),
    business: rates.business,
    client: lead.client,
    requirement: lead.requirement,
  };
  const db = getDb();
  const data = JSON.stringify(quotation);
  db.prepare("INSERT INTO quotations (id, lead_id, number, data, created_at) VALUES (?, ?, ?, ?, ?)").run(quotation.id, lead.id, quotation.number, data, quotation.createdAt);
  recordVersion(db, quotation, data, note);
  const label = `${quotation.number} · hourly engagement${note ? ` (${note})` : ""}`;
  if (lead.stage !== "quoted") {
    db.prepare("UPDATE leads SET stage = 'quoted', updated_at = ? WHERE id = ?").run(now(), lead.id);
    recordStage(lead.id, lead.stage, "quoted", label);
  } else {
    db.prepare("UPDATE leads SET updated_at = ? WHERE id = ?").run(now(), lead.id);
    recordStage(lead.id, "quoted", "quoted", label);
  }
  return quotation;
}

/** Saves the requirement and issues its first quotation in one step. */
export function createLead(client: Client, requirementIn: Requirement, tier?: Tier, orgId?: string): Lead {
  const id = randomUUID();
  // An hourly engagement's market rate is looked up and written here, on the server (see enrichHourly).
  const requirement = enrichFixed(enrichHourly(requirementIn, client, getRateCard()), client, getRateCard());
  transaction((db) => {
    const at = now();
    // A lead made by a client belongs to that client's own organization; any other lead belongs to the agency (the database default).
    db.prepare("INSERT INTO leads (id, stage, client, requirement, created_at, updated_at, org_id) VALUES (?, 'requirement', ?, ?, ?, ?, ?)").run(
      id,
      JSON.stringify(client),
      JSON.stringify(requirement),
      at,
      at,
      orgId ?? null,
    );
    recordStage(id, null, "requirement");
    issueQuotation({ id, stage: "requirement", client, requirement }, tier, 0, "");
  });
  return getLead(id)!;
}

/** Only these stages may be set by hand; payment stages will come from payment webhooks. */
const MANUAL_TRANSITIONS: Partial<Record<Stage, Stage[]>> = {
  requirement: ["lost"],
  quoted: ["approved", "lost"],
  approved: ["quoted", "lost"],
  lost: ["requirement"],
};

/**
 * A quotation is final only when nothing that needs a decision is open: no critical question, no proposed requirement and no
 * assumption waiting for approval. Until then it is a preliminary estimate and cannot be approved.
 */
export function assertFinalAllowed(lead: Pick<Lead, "requirement">): void {
  const status = estimateStatus(lead.requirement.insights?.tracker ?? []);
  if (status.level === "preliminary") {
    const b = status.blockers;
    const parts = [
      b.criticalQuestions ? `${b.criticalQuestions} critical question${b.criticalQuestions === 1 ? "" : "s"} still unanswered` : "",
      b.proposals ? `${b.proposals} new requirement${b.proposals === 1 ? "" : "s"} waiting for a decision` : "",
      b.assumptions ? `${b.assumptions} assumption${b.assumptions === 1 ? "" : "s"} waiting for approval` : "",
    ].filter(Boolean);
    throw new StageError(`This is a preliminary estimate, not a final quotation yet: ${parts.join(", ")}. It can be approved once these are settled.`);
  }
}

export function setStage(id: string, to: Stage, note = "", by = "team"): Lead {
  transaction((db) => {
    const lead = getLead(id);
    if (!lead) throw new StageError("Project not found.");
    if (to === "approved") assertFinalAllowed(lead);
    if (!MANUAL_TRANSITIONS[lead.stage]?.includes(to)) {
      throw new StageError(`Cannot move from "${lead.stage}" to "${to}".`);
    }
    if (to === "approved") approveLatest(db, id, by, "team", note);
    db.prepare("UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?").run(to, now(), id);
    recordStage(id, lead.stage, to, note);
  });
  return getLead(id)!;
}

function assertEditable(lead: Lead | null): asserts lead is Lead {
  if (!lead) throw new StageError("Project not found.");
  if (lead.stage !== "requirement" && lead.stage !== "quoted") {
    throw new StageError("The quotation is locked once approved. Reopen it first.");
  }
}

/** Re-prices the current proposal with the current rate card, optionally with a discount. */
export function requote(id: string, discount: number): Lead {
  transaction(() => {
    const lead = getLead(id);
    assertEditable(lead);
    issueQuotation(lead, lead.quotation?.tier, discount, discount > 0 ? "discount" : "re-priced");
  });
  return getLead(id)!;
}

/**
 * The team sets the technology (frontend, backend, database) for the current quotation, with the same rules and prices as the client's
 * own choice: known options only, the price follows the technology, a discount already given is kept (never above the limit).
 */
export function setTechnology(id: string, tech: TechSelection): Lead {
  transaction((db) => {
    const lead = getLead(id);
    assertEditable(lead);
    if (isHourly(lead.requirement)) throw new ValidationError("An hourly engagement has no website technology to choose.");
    const rates = getRateCard();
    const picked = parseTechSelection(tech, lead.requirement, rates);
    const next = applyClientTech(lead.requirement, picked, rates);
    db.prepare("UPDATE leads SET requirement = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), now(), id);
    issueQuotation({ ...lead, requirement: next }, lead.quotation?.tier, lead.quotation?.discount ?? 0, `technology: ${describeTech(picked, rates)}`, true);
  });
  return getLead(id)!;
}

/**
 * The team's decision on a requirement the AI proposed from a gap in the document (or on one of its assumptions):
 * accept it into the scope, reject it, or mark it as needing the client's clarification.
 * Accepting an item that maps to a feature adds that feature, so the quotation is priced again (a new version; the old one is kept);
 * rejecting it later takes the feature out again.
 */
export function decideInsight(id: string, itemId: string, decision: InsightDecision, by = ""): Lead {
  transaction((db) => {
    const lead = getLead(id);
    assertEditable(lead);
    const insights = lead.requirement.insights;
    const item = insights?.tracker?.find((i) => i.id === itemId);
    if (!insights?.tracker || !item) throw new ValidationError("That item was not found.");
    if (item.kind === "requirement") throw new ValidationError("A requirement the client's document states needs no decision.");
    // An open question can only be set aside (priced later) or put back; the other decisions are for proposals and assumptions.
    if (item.kind === "question" && decision !== "defer" && decision !== "reset") throw new ValidationError("A question is answered by the client; you can only start without it or undo that.");

    const rates = getRateCard();
    const status: ClarificationItem["status"] =
      decision === "accept" ? "confirmed" : decision === "reject" ? "rejected" : decision === "clarify" ? "needs-clarification" : decision === "defer" ? "deferred" : item.kind === "question" ? "unanswered" : "pending-approval";
    let modules = lead.requirement.modules;
    let mustHave = lead.requirement.mustHave ?? [];
    let applied = item.appliedModule === true;
    const moduleId = item.kind === "discovered" && item.module && (MODULES as readonly string[]).includes(item.module) && rates.modules[item.module as ModuleId] ? (item.module as ModuleId) : null;
    if (moduleId && !isHourly(lead.requirement)) {
      if (status === "confirmed" && !modules.includes(moduleId)) {
        // An accepted requirement is agreed scope: it goes into every package, so it is a must-have too.
        modules = [...modules, moduleId];
        mustHave = [...new Set([...mustHave, moduleId])];
        applied = true;
      } else if (status !== "confirmed" && applied) {
        modules = modules.filter((m) => m !== moduleId);
        mustHave = mustHave.filter((m) => m !== moduleId);
        applied = false;
      }
    }
    const tracker: ClarificationItem[] = insights.tracker.map((i) => {
      if (i.id !== itemId) return i;
      const { appliedModule: _drop, ...rest } = i;
      return { ...rest, status, ...(applied ? { appliedModule: true } : {}) };
    });
    const lists = legacyLists(tracker);
    const next: Requirement = {
      ...lead.requirement,
      modules,
      mustHave,
      insights: { ...insights, tracker, confirmed: tracker.some((i) => i.kind === "requirement") ? confirmedTexts(tracker) : insights.confirmed, questions: lists.questions, assumptions: lists.assumptions },
    };
    db.prepare("UPDATE leads SET requirement = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), now(), id);
    const label = `Decision${by ? ` by ${by}` : ""}: ${{ accept: "accepted", reject: "rejected", clarify: "needs the client's clarification", defer: "left out of the price, to be quoted separately later", reset: "back to pending" }[decision]} - ${item.text.slice(0, 120)}`;
    if (modules.length !== lead.requirement.modules.length) {
      // The scope changed, so the price is worked out again from it (a new quotation version; earlier ones stay on record).
      issueQuotation({ ...lead, requirement: next }, lead.quotation?.tier, lead.quotation?.discount ?? 0, label, true);
    } else {
      recordStage(id, lead.stage, lead.stage, label);
    }
  });
  return getLead(id)!;
}

export type ClientSettle = "agree" | "include" | "leave-out" | "answer";

/**
 * The client settles one open point through their own quotation link: answers a critical question, agrees to an assumption, or includes or leaves out a suggested
 * addition. Only points that are open and only the action that fits each kind are accepted. Including an addition changes the scope, so the price is worked out
 * again (a new quotation version). Once nothing is open, the quotation can be approved.
 */
export function settleAsClient(token: string, itemId: string, action: ClientSettle, answer = ""): Lead {
  const lead = getLeadByToken(token);
  if (!lead || !lead.quotation) throw new StageError("This quotation link is not valid.");
  if (lead.stage !== "quoted") throw new StageError("This quotation is no longer open for changes.");
  if (new Date(lead.quotation.validUntil).getTime() < Date.now()) throw new StageError("This quotation has expired. Please ask us for a fresh one.");
  const item = lead.requirement.insights?.tracker?.find((i) => i.id === itemId);
  if (!item) throw new ValidationError("That point was not found.");
  if (item.kind === "assumption" && item.status === "pending-approval" && action === "agree") return decideInsight(lead.id, itemId, "accept", "the client");
  if (item.kind === "discovered" && (item.status === "pending-approval" || item.status === "needs-clarification") && (action === "include" || action === "leave-out")) {
    return decideInsight(lead.id, itemId, action === "include" ? "accept" : "reject", "the client");
  }
  if (item.kind === "question" && item.status === "unanswered" && action === "answer") {
    const text = answer.replace(/\s+/g, " ").trim();
    if (text.length < 2 || text.length > 1000) throw new ValidationError("Please type your answer (up to 1000 characters).");
    transaction((db) => {
      const insights = lead.requirement.insights!;
      const tracker = insights.tracker!.map((i) => (i.id === itemId ? { ...i, answer: text, status: "confirmed" as const } : i));
      const lists = legacyLists(tracker);
      const next: Requirement = { ...lead.requirement, insights: { ...insights, tracker, questions: lists.questions, assumptions: lists.assumptions } };
      db.prepare("UPDATE leads SET requirement = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), now(), lead.id);
      recordStage(lead.id, lead.stage, lead.stage, `The client answered: ${item.text.slice(0, 100)} - ${text.slice(0, 200)}`);
    });
    return getLead(lead.id)!;
  }
  throw new ValidationError("That point is already settled, or cannot be settled that way.");
}

/** Every version of the lead's quotation, oldest first: the history of the estimate. */
export function quotationVersions(leadId: string): Quotation[] {
  const rows = getDb().prepare("SELECT data FROM quotations WHERE lead_id = ? ORDER BY created_at ASC, rowid ASC").all(leadId) as QuoteRow[];
  return rows.map((r) => JSON.parse(r.data) as Quotation);
}

/** Makes one of the three proposals the quotation. */
export function chooseTier(id: string, tier: Tier): Lead {
  transaction(() => {
    const lead = getLead(id);
    assertEditable(lead);
    if (isHourly(lead.requirement)) throw new ValidationError("An hourly engagement has no packages to choose from.");
    issueQuotation(lead, tier, 0, "proposal changed");
  });
  return getLead(id)!;
}

export function stageHistory(id: string) {
  return getDb()
    .prepare("SELECT from_stage AS fromStage, to_stage AS toStage, note, at FROM stage_history WHERE lead_id = ? ORDER BY id")
    .all(id) as { fromStage: Stage | null; toStage: Stage; note: string; at: string }[];
}

// ---- Client approval link -------------------------------------------------

/** Returns the lead's secret link token, creating it on first use. */
export function shareToken(id: string): string {
  const lead = getLead(id);
  if (!lead) throw new StageError("Project not found.");
  if (lead.shareToken) return lead.shareToken;
  const token = randomBytes(24).toString("base64url");
  getDb().prepare("UPDATE leads SET share_token = ? WHERE id = ?").run(token, id);
  return token;
}

export function getLeadByToken(token: string): Lead | null {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const row = getDb().prepare("SELECT * FROM leads WHERE share_token = ?").get(token) as LeadRow | undefined;
  return row ? toLead(row) : null;
}

/**
 * The client's answer through the link: approve a proposal (which becomes
 * the quotation and locks it) or ask for changes (the team re-quotes).
 */
export function respondAsClient(token: string, response: Omit<ClientResponse, "at" | "acknowledgedDeferred"> & { tech?: TechSelection; acknowledgeDeferred?: boolean }): Lead {
  let leadId = "";
  transaction((db) => {
    const lead = getLeadByToken(token);
    if (!lead || !lead.quotation) throw new StageError("This quotation link is not valid.");
    if (lead.stage !== "quoted") throw new StageError("This quotation is no longer open for a response.");
    if (new Date(lead.quotation.validUntil).getTime() < Date.now()) {
      throw new StageError("This quotation has expired. Please ask us for a fresh one.");
    }
    // The client cannot approve a price that is still a preliminary estimate.
    if (response.action === "approved") assertFinalAllowed(lead);
    leadId = lead.id;
    // Items left out of the price must be acknowledged before approving; what the client was shown is recorded as it stood then.
    const deferred = deferredTexts(lead.requirement.insights?.tracker ?? []);
    if (response.action === "approved" && deferred.length > 0 && response.acknowledgeDeferred !== true) {
      throw new ValidationError("Please confirm that you understand the items listed as not included in this price.");
    }
    const { tech, acknowledgeDeferred: _ack, ...answer } = response;
    const record: ClientResponse = { ...answer, at: now(), ...(response.action === "approved" && deferred.length > 0 ? { acknowledgedDeferred: deferred } : {}) };
    db.prepare("UPDATE leads SET client_response = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(record), now(), lead.id);

    if (response.action === "approved") {
      // The client may have chosen their own technology on the page: it is applied, and the quotation is priced again with it.
      let priced: Pick<Lead, "id" | "stage" | "client" | "requirement"> = lead;
      let techNote = "";
      if (tech && !isHourly(lead.requirement)) {
        const rates = getRateCard();
        const picked = parseTechSelection(tech, lead.requirement, rates);
        const next = applyClientTech(lead.requirement, picked, rates);
        if (JSON.stringify(next.tech ?? {}) !== JSON.stringify(lead.requirement.tech ?? {})) {
          db.prepare("UPDATE leads SET requirement = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), now(), lead.id);
          priced = { ...lead, requirement: next };
          techNote = describeTech(picked, rates);
        }
      }
      if (techNote) {
        issueQuotation(priced, response.tier ?? lead.quotation.tier, lead.quotation.discount, "technology chosen by client", true);
        recordStage(lead.id, "quoted", "quoted", `Client chose the technology: ${techNote}`);
      } else if (response.tier && response.tier !== lead.quotation.tier) {
        issueQuotation(lead, response.tier, 0, "chosen by client");
      }
      db.prepare("UPDATE leads SET stage = 'approved', updated_at = ? WHERE id = ?").run(now(), lead.id);
      approveLatest(db, lead.id, `client: ${response.name}`, "client-link", response.message ?? "");
      const q = latestQuotation(lead.id)!;
      recordStage(lead.id, "quoted", "approved", `Approved online by ${response.name}: ${q.number}${response.message ? ` · "${response.message}"` : ""}`);
    } else {
      recordStage(lead.id, "quoted", "quoted", `Client asked for changes (${response.name}): "${response.message}"`);
    }
  });
  return getLead(leadId)!;
}

// ---- Sending & payments ----------------------------------------------------

/** Notes in the history that the link was sent (WhatsApp / email open on the team's device). */
export function markSent(id: string, channel: "whatsapp" | "email"): Lead {
  const lead = getLead(id);
  if (!lead) throw new StageError("Project not found.");
  recordStage(id, lead.stage, lead.stage, `Quotation link sent by ${channel === "whatsapp" ? "WhatsApp" : "email"}`);
  getDb().prepare("UPDATE leads SET updated_at = ? WHERE id = ?").run(now(), id);
  return getLead(id)!;
}

const PAYMENT_STAGES: Record<PaymentKind, { from: Stage[]; to: Stage }> = {
  // Work may start before the advance (team decision); it can still be recorded then.
  advance: { from: ["approved", "in_development", "testing", "demo_ready"], to: "advance_paid" },
  // Balance is due after the demo; the build and demo steps come later.
  balance: { from: ["demo_ready"], to: "final_paid" },
};

/**
 * Records money received outside the site (UPI, bank transfer, cash...).
 * Once the full advance (or balance) is in, the project moves on.
 */
export function recordPayment(id: string, p: { kind: PaymentKind; amount: number; mode: PaymentMode; reference: string; receivedOn: string }): Lead {
  transaction((db) => {
    const lead = getLead(id);
    if (!lead) throw new StageError("Project not found.");
    const rule = PAYMENT_STAGES[p.kind];
    if (!rule.from.includes(lead.stage)) {
      throw new StageError(p.kind === "advance" ? "Record the advance after the client has approved the quotation." : "The balance is recorded after the demo is ready.");
    }
    const status = paymentStatus(lead.quotation, lead.payments);
    const remaining = p.kind === "advance" ? status.advanceRemaining : status.balanceRemaining;
    const shown = moneyOf(lead.quotation);
    if (p.amount > remaining + 1) throw new StageError(`Only ${formatMoney(remaining, shown)} is due for the ${p.kind}.`);
    db.prepare("INSERT INTO payments (id, lead_id, kind, amount, mode, reference, received_on, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      randomUUID(), id, p.kind, p.amount, p.mode, p.reference, p.receivedOn, now(),
    );
    const done = p.amount >= remaining - 1;
    const note = `${p.kind === "advance" ? "Advance" : "Balance"} received: ${formatMoney(p.amount, shown)} by ${p.mode.toUpperCase()}${p.reference ? ` (ref ${p.reference})` : ""}${done ? (p.kind === "advance" ? " - advance complete" : "") : " - part payment"}`;
    // Only move forward: work that already started keeps its stage.
    const moves = done && (p.kind === "balance" || lead.stage === "approved");
    if (moves) {
      db.prepare("UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?").run(rule.to, now(), id);
      recordStage(id, lead.stage, rule.to, note);
    } else {
      db.prepare("UPDATE leads SET updated_at = ? WHERE id = ?").run(now(), id);
      recordStage(id, lead.stage, lead.stage, note);
    }
  });
  return getLead(id)!;
}

// ---- Hours (the owner's own price history) ------------------------------------

const HOURS_STAGES: Stage[] = ["approved", "advance_paid", "in_development", "testing", "demo_ready", "final_paid", "delivered"];

export function addWorkEntry(id: string, e: { item: string; hours: number; note: string; loggedOn: string }): Lead {
  const lead = getLead(id);
  if (!lead) throw new StageError("Project not found.");
  if (!HOURS_STAGES.includes(lead.stage)) throw new StageError("Log hours after the client approves the quotation.");
  getDb().prepare("INSERT INTO work_log (id, lead_id, item, hours, note, logged_on, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), id, e.item, e.hours, e.note, e.loggedOn, now());
  return getLead(id)!;
}

/** Permanently removes a lead and everything under it (quotations, payments, hours, jobs). Generated project folders are untouched. */
export type ApprovalRecord = {
  versions: VersionRow[];
  approvals: (ApprovalRow & { intact: boolean; problem?: string })[];
  /** The newest version is not the one that was approved: what it changes against the approved terms, and that it needs approving again. */
  pending: { number: string; versionNo: number; changes: string[]; needsApproval: boolean } | null;
};

/** The versions of the lead's quotation and every approval, each checked against what is stored now. */
export function approvalRecord(leadId: string): ApprovalRecord {
  const db = getDb();
  const versions = listVersions(db, leadId);
  const approvals = listApprovals(db, leadId).map((a) => {
    const v = verifyApproval(db, a);
    return { ...a, intact: v.ok, ...(v.ok ? {} : { problem: v.reason }) };
  });
  const latest = latestQuotation(leadId);
  const lastApproval = approvals[approvals.length - 1];
  let pending: ApprovalRecord["pending"] = null;
  if (latest && lastApproval && lastApproval.quotationId !== latest.id) {
    pending = { number: latest.number, versionNo: versions[versions.length - 1]?.versionNo ?? 0, changes: termChanges(lastApproval.terms, termsOf(latest)), needsApproval: true };
  }
  return { versions, approvals, pending };
}

/** A project that has an approved quotation is kept for the record: it can be marked lost, never deleted. */
export function assertDeletable(id: string): void {
  if (listApprovals(getDb(), id).length > 0) throw new StageError("This project has an approved quotation, so it is kept for the record. Mark it lost instead.");
}

export function deleteLead(id: string): void {
  assertDeletable(id);
  getDb().prepare("DELETE FROM leads WHERE id = ?").run(id);
}

export function deleteWorkEntry(id: string, entryId: string): Lead {
  getDb().prepare("DELETE FROM work_log WHERE id = ? AND lead_id = ?").run(entryId, id);
  return getLead(id)!;
}

/**
 * Marks a generated project ready for delivery ("Demo ready"). Only from development, and only after
 * the developer has reviewed and approved the generated project (see execution/jobs).
 */
export function markReadyForDelivery(id: string, note: string): Lead {
  transaction((db) => {
    const lead = getLead(id);
    if (!lead) throw new StageError("Project not found.");
    if (lead.stage !== "in_development" && lead.stage !== "testing" && lead.stage !== "demo_ready") {
      throw new StageError("Only a project in development can be marked ready for delivery.");
    }
    const approved = db
      .prepare("SELECT 1 AS ok FROM exec_jobs WHERE lead_id = ? AND state = 'completed' AND json_extract(review, '$.status') = 'approved' LIMIT 1")
      .get(id) as { ok: number } | undefined;
    if (!approved) throw new StageError("Review and approve the generated project first.");
    if (lead.stage === "demo_ready") return; // a rebuilt project that was already demo ready stays there
    db.prepare("UPDATE leads SET stage = 'demo_ready', updated_at = ? WHERE id = ?").run(now(), id);
    recordStage(id, lead.stage, "demo_ready", note);
  });
  return getLead(id)!;
}

// ---- Development ------------------------------------------------------------

/**
 * Moves an approved project into development and fixes its project folder
 * name. Without the advance, the team must say why (kept in the history).
 */
export function startDevelopment(id: string, opts: { withoutAdvance: boolean; reason: string; suffix: string; nameFor: (title: string, suffix: string) => string }): Lead {
  transaction((db) => {
    const lead = getLead(id);
    if (!lead) throw new StageError("Project not found.");
    if (lead.stage === "in_development") return; // retry of a failed start keeps the same folder
    if (lead.stage !== "approved" && lead.stage !== "advance_paid") {
      throw new StageError("Development starts after the client approves the quotation.");
    }
    if (lead.stage === "approved") {
      if (!opts.withoutAdvance) throw new StageError("The advance is not recorded yet. Record it, or choose to start without it.");
      if (opts.reason.trim().length < 5) throw new StageError("Say why the work starts before the advance (kept in the history).");
    }
    const name = lead.projectName ?? opts.nameFor((lead.quotation?.requirement ?? lead.requirement).title, opts.suffix);
    db.prepare("UPDATE leads SET stage = 'in_development', project_name = ?, updated_at = ? WHERE id = ?").run(name, now(), id);
    const note = lead.stage === "approved" ? `Started WITHOUT advance: ${opts.reason.trim()}` : "Started after advance";
    recordStage(id, lead.stage, "in_development", `${note} · project ${name}`);
  });
  return getLead(id)!;
}

import { randomBytes, randomUUID } from "node:crypto";

import { getDb, transaction } from "./db";
import { buildQuote } from "./pricing";
import { buildProposals, compareProposals, defaultTier, toSummary } from "./proposals";
import { DEFAULT_RATE_CARD } from "./rate-card";
import { checkBudget } from "./budget";
import { parseRateCard, ValidationError } from "./validate";
import { paymentStatus } from "./payment-status";
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

export function saveRateCard(card: RateCard): void {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES ('rate_card', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(card));
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
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM quotations WHERE number LIKE ?")
    .get(`SQ-${year}-%`) as { n: number };
  return `SQ-${year}-${String(Number(row.n) + 1).padStart(4, "0")}`;
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
function issueQuotation(lead: Pick<Lead, "id" | "stage" | "client" | "requirement">, tier: Tier | undefined, discount: number, note: string): Quotation {
  const rates = getRateCard();
  const proposals = buildProposals(lead.requirement, lead.client, rates);
  const chosen = proposals.find((p) => p.tier === (tier ?? defaultTier(proposals, lead.requirement.budget)))!;
  // Only a discount the team approves is applied, never one made up to fit the budget.
  const maxDiscount = Math.floor((chosen.quote.subtotal * rates.maxDiscountPercent) / 100);
  if (discount > maxDiscount) {
    throw new ValidationError(`The discount can be at most ${rates.maxDiscountPercent}% (₹${maxDiscount}). Change the limit in Business & pricing.`);
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
  db.prepare("INSERT INTO quotations (id, lead_id, number, data, created_at) VALUES (?, ?, ?, ?, ?)").run(
    quotation.id,
    lead.id,
    quotation.number,
    JSON.stringify(quotation),
    quotation.createdAt,
  );
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

/** Saves the requirement and issues its first quotation in one step. */
export function createLead(client: Client, requirement: Requirement, tier?: Tier): Lead {
  const id = randomUUID();
  transaction((db) => {
    const at = now();
    db.prepare("INSERT INTO leads (id, stage, client, requirement, created_at, updated_at) VALUES (?, 'requirement', ?, ?, ?, ?)").run(
      id,
      JSON.stringify(client),
      JSON.stringify(requirement),
      at,
      at,
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

export function setStage(id: string, to: Stage, note = ""): Lead {
  transaction((db) => {
    const lead = getLead(id);
    if (!lead) throw new StageError("Project not found.");
    if (!MANUAL_TRANSITIONS[lead.stage]?.includes(to)) {
      throw new StageError(`Cannot move from "${lead.stage}" to "${to}".`);
    }
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

/** Makes one of the three proposals the quotation. */
export function chooseTier(id: string, tier: Tier): Lead {
  transaction(() => {
    const lead = getLead(id);
    assertEditable(lead);
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
export function respondAsClient(token: string, response: Omit<ClientResponse, "at">): Lead {
  let leadId = "";
  transaction((db) => {
    const lead = getLeadByToken(token);
    if (!lead || !lead.quotation) throw new StageError("This quotation link is not valid.");
    if (lead.stage !== "quoted") throw new StageError("This quotation is no longer open for a response.");
    if (new Date(lead.quotation.validUntil).getTime() < Date.now()) {
      throw new StageError("This quotation has expired. Please ask us for a fresh one.");
    }
    leadId = lead.id;
    const record: ClientResponse = { ...response, at: now() };
    db.prepare("UPDATE leads SET client_response = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(record), now(), lead.id);

    if (response.action === "approved") {
      if (response.tier && response.tier !== lead.quotation.tier) {
        issueQuotation(lead, response.tier, 0, "chosen by client");
      }
      db.prepare("UPDATE leads SET stage = 'approved', updated_at = ? WHERE id = ?").run(now(), lead.id);
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
    if (p.amount > remaining + 1) throw new StageError(`Only ${remaining} is due for the ${p.kind}.`);
    db.prepare("INSERT INTO payments (id, lead_id, kind, amount, mode, reference, received_on, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      randomUUID(), id, p.kind, p.amount, p.mode, p.reference, p.receivedOn, now(),
    );
    const done = p.amount >= remaining - 1;
    const note = `${p.kind === "advance" ? "Advance" : "Balance"} received: ₹${p.amount} by ${p.mode.toUpperCase()}${p.reference ? ` (ref ${p.reference})` : ""}${done ? (p.kind === "advance" ? " - advance complete" : "") : " - part payment"}`;
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

export function deleteWorkEntry(id: string, entryId: string): Lead {
  getDb().prepare("DELETE FROM work_log WHERE id = ? AND lead_id = ?").run(entryId, id);
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

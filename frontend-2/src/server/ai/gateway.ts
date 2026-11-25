import { randomUUID } from "node:crypto";

import { getDb, transaction } from "@/lib/business/db";
import { CreditError, extendReservation, getWallet, releaseReservation, reserveCredits, settleReservation, type Wallet } from "@/server/credits";
import { getDailyCap, getModel, getUnitsPerUsd, listModels, TIERS, type AiModel, type Tier } from "./catalog";
import { estimateTokens, providerCostMicroUsd, unitsForCost, unitsForTokens } from "./pricing";
import { defaultProviders, ProviderError, type ChatMessage, type ProviderAdapter } from "./providers";

/**
 * The AI Gateway: the ONLY way customer work reaches an AI provider (server only).
 *
 *   validate -> pick model(s) -> estimate the worst case -> check the daily cap and concurrency (one locked step, with the
 *   request row) -> RESERVE credits -> call the provider (retry, then fall back within the tier) -> measure the real tokens
 *   -> SETTLE the real cost and give back the rest -> write the usage row.
 *
 * Guarantees: a request that cannot be paid for never reaches a provider; a failed request costs nothing (the reservation
 * is released); the same idempotency key never charges twice; one organization can never use another's wallet; prompts and
 * answers are not stored. Prices and the credit conversion are database rows, never constants in this file.
 */

export type GatewayErrorCode = "invalid" | "model-unavailable" | "provider-not-configured" | "daily-cap" | "too-many-requests" | "in-progress" | "provider-failed";
export class GatewayError extends Error {
  code: GatewayErrorCode;
  details: Record<string, unknown>;
  constructor(code: GatewayErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.details = details;
  }
}

export const LIMITS = {
  maxMessages: 50,
  maxPromptChars: 200_000,
  maxSystemChars: 20_000,
  defaultOutputTokens: 1024,
  maxConcurrentPerOrg: 4,
  attemptsPerModel: 2,
  attemptTimeoutMs: 60_000,
  totalDeadlineMs: 4 * 60_000,
  /** A "running" row older than this belongs to a crashed process: its reservation is given back. */
  staleAfterMs: 10 * 60_000,
} as const;

export type GatewayInput = {
  orgId: string;
  userId?: string;
  /** A model id, a tier (fast | balanced | best), or "auto". */
  model?: string;
  messages: unknown;
  system?: unknown;
  maxOutputTokens?: unknown;
  idempotencyKey: string;
  purpose?: string;
};
export type GatewayDeps = { providers?: Record<string, ProviderAdapter>; sleep?: (ms: number) => Promise<void>; now?: () => number };

export type GatewayResult = {
  requestId: string;
  replayed: boolean;
  /** Empty on a replay: the gateway does not keep answers, so repeat with a NEW key if the answer was lost. */
  text: string;
  model: { id: string; label: string; tier: Tier };
  fallbackUsed: boolean;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
  chargedUnits: number;
  uncollectedUnits: number;
  latencyMs: number;
  wallet: Wallet;
};

const bad = (message: string) => new GatewayError("invalid", message);

// ---- validation ----------------------------------------------------------------------------------------------------------
type Clean = { messages: ChatMessage[]; system: string | undefined; promptChars: number; maxOutputTokens: number | null; key: string; purpose: string };
function clean(input: GatewayInput): Clean {
  const key = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (key.length < 6 || key.length > 200) throw bad("An idempotency key of 6 to 200 characters is required.");
  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > LIMITS.maxMessages) throw bad(`messages must be a list of 1 to ${LIMITS.maxMessages} items.`);
  const messages: ChatMessage[] = input.messages.map((m, i) => {
    const o = m as { role?: unknown; content?: unknown };
    if ((o?.role !== "user" && o?.role !== "assistant") || typeof o.content !== "string" || !o.content.trim()) throw bad(`Message ${i + 1} needs a role of user or assistant and non-empty text.`);
    return { role: o.role, content: o.content };
  });
  if (messages[0]!.role !== "user" || messages[messages.length - 1]!.role !== "user") throw bad("The conversation must start and end with a user message.");
  let system: string | undefined;
  if (input.system !== undefined && input.system !== null && input.system !== "") {
    if (typeof input.system !== "string" || input.system.length > LIMITS.maxSystemChars) throw bad(`system must be text up to ${LIMITS.maxSystemChars} characters.`);
    system = input.system;
  }
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0) + (system?.length ?? 0);
  if (promptChars > LIMITS.maxPromptChars) throw bad(`The request is too long (${promptChars} characters; the limit is ${LIMITS.maxPromptChars}).`);
  let maxOutputTokens: number | null = null;
  if (input.maxOutputTokens !== undefined && input.maxOutputTokens !== null) {
    if (typeof input.maxOutputTokens !== "number" || !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1) throw bad("maxOutputTokens must be a whole number of 1 or more.");
    maxOutputTokens = input.maxOutputTokens;
  }
  return { messages, system, promptChars, maxOutputTokens, key, purpose: String(input.purpose ?? "chat").slice(0, 60) };
}

/**
 * "auto" picks by the size of the job (like Cursor's Auto): short, small-answer requests go to the cheap tier, everything else
 * to the balanced tier. "best" is never chosen for the customer: the dearest tier is always an explicit choice.
 */
export const autoTier = (promptChars: number, maxOutputTokens: number): Tier => (promptChars <= 1500 && maxOutputTokens <= 1024 ? "fast" : "balanced");

function candidatesFor(requested: string, promptChars: number, outTokens: number): AiModel[] {
  const enabled = listModels({ enabledOnly: true });
  const want = (requested || "auto").trim().toLowerCase();
  if (want === "auto" || (TIERS as readonly string[]).includes(want)) {
    const tier = want === "auto" ? autoTier(promptChars, outTokens) : (want as Tier);
    // "demo" is never part of auto/tier routing: it must be asked for by name.
    const list = enabled.filter((m) => m.tier === tier && tier !== "demo");
    if (list.length) return list; // already ordered by priority
    throw new GatewayError("model-unavailable", `No ${tier} model is available right now.`);
  }
  const one = enabled.find((m) => m.id === requested.trim());
  if (!one) throw new GatewayError("model-unavailable", `The model "${requested}" is not available.`);
  return [one]; // an explicit choice is never silently swapped for a different price
}

const outputFor = (m: AiModel, asked: number | null) => Math.min(asked ?? LIMITS.defaultOutputTokens, m.maxOutputTokens);

/** The most this request could cost on a model: every prompt token estimated high, and the full answer allowance used. */
const worstCaseUnits = (m: AiModel, promptChars: number, asked: number | null, rate: number) => unitsForTokens(m, rate, estimateTokens(promptChars), outputFor(m, asked));

export type Estimate = { model: string; maxUnits: number; maxOutputTokens: number; estimatedInputTokens: number };
/** What a request would hold, before it is sent. Same maths as the real thing. */
export function estimate(input: { model?: string; messages: unknown; system?: unknown; maxOutputTokens?: unknown }): Estimate {
  const c = clean({ ...input, orgId: "", idempotencyKey: "estimate-only" });
  const rate = getUnitsPerUsd();
  const chain = candidatesFor(input.model ?? "auto", c.promptChars, c.maxOutputTokens ?? LIMITS.defaultOutputTokens);
  const worst = chain.reduce((a, b) => (worstCaseUnits(b, c.promptChars, c.maxOutputTokens, rate) > worstCaseUnits(a, c.promptChars, c.maxOutputTokens, rate) ? b : a));
  return { model: chain.length === 1 ? chain[0]!.id : `${chain[0]!.tier} tier`, maxUnits: worstCaseUnits(worst, c.promptChars, c.maxOutputTokens, rate), maxOutputTokens: outputFor(worst, c.maxOutputTokens), estimatedInputTokens: estimateTokens(c.promptChars) };
}

// ---- request rows --------------------------------------------------------------------------------------------------------------
type ReqRow = { id: string; status: "running" | "completed" | "failed"; model_id: string | null; fallback_used: number; attempts: number; input_tokens: number; output_tokens: number; charged_units: number; uncollected_units: number; latency_ms: number | null; error_code: string | null };

/** Gives back the credits held by requests whose process died. Cheap; runs at the start of every call. */
export function sweepStaleRequests(orgId: string, now = Date.now()): number {
  const db = getDb();
  const cutoff = new Date(now - LIMITS.staleAfterMs).toISOString();
  const stale = db.prepare("SELECT id, reservation_id FROM ai_requests WHERE org_id = ? AND status = 'running' AND created_at < ?").all(orgId, cutoff) as { id: string; reservation_id: string | null }[];
  for (const s of stale) {
    if (s.reservation_id) { try { releaseReservation({ orgId, reservationId: s.reservation_id, note: "ai request abandoned" }); } catch { /* already closed */ } }
    db.prepare("UPDATE ai_requests SET status = 'failed', error_code = 'abandoned', error_message = 'The server stopped before this request finished. Nothing was charged.', finished_at = ? WHERE id = ? AND status = 'running'").run(new Date(now).toISOString(), s.id);
  }
  return stale.length;
}

const startOfUtcDay = (ms: number) => { const d = new Date(ms); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString(); };

// ---- the call --------------------------------------------------------------------------------------------------------------------
export async function complete(input: GatewayInput, deps: GatewayDeps = {}): Promise<GatewayResult> {
  const providers = deps.providers ?? defaultProviders();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = deps.now ?? Date.now;
  const c = clean(input);
  const orgId = input.orgId;
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM organizations WHERE id = ?").get(orgId)) throw new CreditError("not-found", "That organization does not exist.");
  sweepStaleRequests(orgId, clock());

  // The model chain, kept only where its provider can answer: no credits are ever held for a model that cannot run.
  const requested = String(input.model ?? "auto");
  const all = candidatesFor(requested, c.promptChars, c.maxOutputTokens ?? LIMITS.defaultOutputTokens);
  const chain = all.filter((m) => providers[m.provider]?.isConfigured());
  if (!chain.length) throw new GatewayError("provider-not-configured", "The AI provider for this model is not set up yet. Nothing was charged.");
  const rate = getUnitsPerUsd(db);
  const hold = Math.max(...chain.map((m) => worstCaseUnits(m, c.promptChars, c.maxOutputTokens, rate)));

  // ---- one locked step: repeat? daily cap? concurrency? then the request row. Two simultaneous calls cannot both slip through. ----
  const requestId = `air_${randomUUID()}`;
  const started = clock();
  const gate = transaction((tx) => {
    const prior = tx.prepare("SELECT * FROM ai_requests WHERE org_id = ? AND idempotency_key = ?").get(orgId, c.key) as ReqRow | undefined;
    if (prior) return { prior };
    const cap = getDailyCap(orgId, tx);
    if (cap !== null) {
      const used = (tx.prepare("SELECT COALESCE(SUM(CASE WHEN status = 'running' THEN reserved_units ELSE charged_units END), 0) AS n FROM ai_requests WHERE org_id = ? AND created_at >= ? AND status != 'failed'").get(orgId, startOfUtcDay(started)) as { n: number }).n;
      if (used + hold > cap) throw new GatewayError("daily-cap", "This organization's daily AI limit would be exceeded. It resets at midnight UTC.", { dailyCapUnits: cap, usedTodayUnits: used, neededUnits: hold });
    }
    const running = (tx.prepare("SELECT COUNT(*) AS n FROM ai_requests WHERE org_id = ? AND status = 'running'").get(orgId) as { n: number }).n;
    if (running >= LIMITS.maxConcurrentPerOrg) throw new GatewayError("too-many-requests", `Too many AI requests are running at once (limit ${LIMITS.maxConcurrentPerOrg}). Try again in a moment.`);
    tx.prepare(
      "INSERT INTO ai_requests (id, org_id, user_id, idempotency_key, status, purpose, requested_model, reserved_units, prompt_chars, created_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)",
    ).run(requestId, orgId, input.userId ?? "", c.key, c.purpose, requested.slice(0, 80), hold, c.promptChars, new Date(started).toISOString());
    return { prior: null };
  });

  if (gate.prior) {
    const p = gate.prior;
    if (p.status === "running") throw new GatewayError("in-progress", "A request with this idempotency key is still running.");
    if (p.status === "failed") throw new GatewayError("provider-failed", `That request already failed (${p.error_code ?? "error"}) and nothing was charged. Send it again with a new idempotency key.`);
    const model = getModel(p.model_id ?? "")!;
    return { requestId: p.id, replayed: true, text: "", model: { id: model.id, label: model.label, tier: model.tier }, fallbackUsed: p.fallback_used === 1, attempts: p.attempts, usage: { inputTokens: p.input_tokens, outputTokens: p.output_tokens }, chargedUnits: p.charged_units, uncollectedUnits: p.uncollected_units, latencyMs: p.latency_ms ?? 0, wallet: getWallet(orgId) };
  }

  const fail = (code: string, message: string, extra: { attempts?: number } = {}) =>
    db.prepare("UPDATE ai_requests SET status = 'failed', error_code = ?, error_message = ?, attempts = ?, latency_ms = ?, finished_at = ? WHERE id = ?").run(code, message.slice(0, 500), extra.attempts ?? 0, clock() - started, new Date(clock()).toISOString(), requestId);

  // ---- reserve: the call below never starts unless the credits are really held ----
  let reservationId: string | null = null;
  if (hold > 0) {
    try {
      reservationId = reserveCredits({ orgId, units: hold, idempotencyKey: `ai-reserve:${requestId}`, purpose: `ai:${c.purpose}` }).id;
      db.prepare("UPDATE ai_requests SET reservation_id = ? WHERE id = ?").run(reservationId, requestId);
    } catch (e) {
      fail(e instanceof CreditError ? e.code : "error", (e as Error).message);
      throw e;
    }
  }
  const giveBack = (note: string) => { if (reservationId) { try { releaseReservation({ orgId, reservationId, note }); } catch { /* already closed */ } } };

  // ---- call the provider: retry a temporary failure, then fall back to the next model of the same tier ----
  let attempts = 0;
  let lastError = "";
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i]!;
    const provider = providers[model.provider]!;
    for (let a = 1; a <= LIMITS.attemptsPerModel; a++) {
      if (clock() - started > LIMITS.totalDeadlineMs) { lastError = "The request ran out of time."; break; }
      attempts++;
      try {
        const out = await provider.complete({ providerModel: model.providerModel, system: c.system, messages: c.messages, maxOutputTokens: outputFor(model, c.maxOutputTokens), signal: AbortSignal.timeout(LIMITS.attemptTimeoutMs) });
        // ---- measure and settle the REAL cost ----
        const costUsd = providerCostMicroUsd(model, out.inputTokens, out.outputTokens);
        let units = unitsForCost(costUsd, model.markupBasisPoints, rate);
        let held = hold;
        if (reservationId && units > held) {
          // The prompt was bigger than estimated. Hold the difference if the wallet has it; otherwise charge only what was held.
          try { extendReservation({ orgId, reservationId, extraUnits: units - held, idempotencyKey: `ai-extend:${requestId}` }); held = units; } catch (e) { if (!(e instanceof CreditError)) throw e; }
        }
        const charged = Math.min(units, held);
        if (reservationId) settleReservation({ orgId, reservationId, actualUnits: charged, note: `ai:${model.id}` });
        const latencyMs = clock() - started;
        db.prepare(
          `UPDATE ai_requests SET status = 'completed', model_id = ?, fallback_used = ?, attempts = ?, reserved_units = ?, response_chars = ?, input_tokens = ?, output_tokens = ?, provider_cost_micro_usd = ?, charged_units = ?, uncollected_units = ?, provider_request_id = ?, latency_ms = ?, finished_at = ? WHERE id = ?`,
        ).run(model.id, i > 0 ? 1 : 0, attempts, held, out.text.length, out.inputTokens, out.outputTokens, costUsd, charged, units - charged, out.providerRequestId, latencyMs, new Date(clock()).toISOString(), requestId);
        return { requestId, replayed: false, text: out.text, model: { id: model.id, label: model.label, tier: model.tier }, fallbackUsed: i > 0, attempts, usage: { inputTokens: out.inputTokens, outputTokens: out.outputTokens }, chargedUnits: charged, uncollectedUnits: units - charged, latencyMs, wallet: getWallet(orgId) };
      } catch (e) {
        if (!(e instanceof ProviderError)) { giveBack("ai request failed"); fail("error", (e as Error).message, { attempts }); throw e; }
        lastError = e.message;
        if (!e.retryable) break; // a request the provider rejects will be rejected again: try the next model, not the same one
        if (a < LIMITS.attemptsPerModel) await sleep(400 * a);
      }
    }
  }
  giveBack("ai request failed");
  fail("provider-failed", lastError, { attempts });
  throw new GatewayError("provider-failed", "The AI provider could not complete this request. You were not charged.");
}

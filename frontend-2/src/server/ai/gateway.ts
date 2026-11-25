import { randomUUID } from "node:crypto";

import { getDb, transaction } from "@/lib/business/db";
import { CreditError, extendReservation, getWallet, releaseReservation, reserveCredits, settleReservation, type Wallet } from "@/server/credits";
import { getDailyCap, getMeteringPolicy, getModel, getUnitsPerUsd, listModels, resolveMarkup, TASK_TYPES, TIERS, type AiModel, type Tier } from "./catalog";
import { chargeUnits, estimateTokens, usageCostMicroUsd, worstInputPrice, type MeteringPolicy, type Usage } from "./pricing";
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
  /** What the request is for (chat, document_analysis, architecture_planning, code_generation, bug_fixing, code_review, other). It selects the markup rule. */
  taskType?: string;
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
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  /** True when the provider did not report usage and the charge was worked out from the gateway's own estimate. */
  usageEstimated: boolean;
  /** The version of the model's price this request was charged at (see model_prices). */
  priceVersion: number | null;
  chargedUnits: number;
  uncollectedUnits: number;
  latencyMs: number;
  wallet: Wallet;
};

const bad = (message: string) => new GatewayError("invalid", message);

// ---- validation ----------------------------------------------------------------------------------------------------------
type Clean = { messages: ChatMessage[]; system: string | undefined; promptChars: number; maxOutputTokens: number | null; key: string; purpose: string; taskType: string };
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
  const taskType = input.taskType === undefined || input.taskType === null || input.taskType === "" ? "chat" : String(input.taskType);
  if (!(TASK_TYPES as readonly string[]).includes(taskType)) throw bad(`taskType must be one of: ${TASK_TYPES.join(", ")}.`);
  return { messages, system, promptChars, maxOutputTokens, key, purpose: String(input.purpose ?? "chat").slice(0, 60), taskType };
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

/**
 * The most this request could cost on a model: every prompt token estimated high AND billed at the dearest input price the model has (a cache write
 * can cost more than plain input), and the full answer allowance used. Priced with the same markup rule the real charge will use.
 */
const worstCaseUnits = (m: AiModel, promptChars: number, asked: number | null, rate: number, policy: MeteringPolicy, taskType: string) => {
  const cost = usageCostMicroUsd({ ...m, inputUsdMicroPerMtok: worstInputPrice(m) }, { inputTokens: estimateTokens(promptChars), outputTokens: outputFor(m, asked) });
  return chargeUnits(cost, resolveMarkup(m, taskType).basisPoints, rate, policy).units;
};

export type Estimate = { model: string; maxUnits: number; maxOutputTokens: number; estimatedInputTokens: number };
/** What a request would hold, before it is sent. Same maths as the real thing. */
export function estimate(input: { model?: string; messages: unknown; system?: unknown; maxOutputTokens?: unknown; taskType?: string }): Estimate {
  const c = clean({ ...input, orgId: "", idempotencyKey: "estimate-only" });
  const rate = getUnitsPerUsd();
  const policy = getMeteringPolicy();
  const chain = candidatesFor(input.model ?? "auto", c.promptChars, c.maxOutputTokens ?? LIMITS.defaultOutputTokens);
  const quote = (m: AiModel) => worstCaseUnits(m, c.promptChars, c.maxOutputTokens, rate, policy, c.taskType);
  const worst = chain.reduce((a, b) => (quote(b) > quote(a) ? b : a));
  return { model: chain.length === 1 ? chain[0]!.id : `${chain[0]!.tier} tier`, maxUnits: quote(worst), maxOutputTokens: outputFor(worst, c.maxOutputTokens), estimatedInputTokens: estimateTokens(c.promptChars) };
}

// ---- request rows --------------------------------------------------------------------------------------------------------------
type ReqRow = { id: string; status: "running" | "completed" | "failed"; model_id: string | null; fallback_used: number; attempts: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; usage_source: "provider" | "estimated" | null; price_version: number | null; charged_units: number; uncollected_units: number; latency_ms: number | null; error_code: string | null };

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
  const policy = getMeteringPolicy(db);
  const hold = Math.max(...chain.map((m) => worstCaseUnits(m, c.promptChars, c.maxOutputTokens, rate, policy, c.taskType)));

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
      "INSERT INTO ai_requests (id, org_id, user_id, idempotency_key, status, purpose, task_type, requested_model, reserved_units, prompt_chars, created_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)",
    ).run(requestId, orgId, input.userId ?? "", c.key, c.purpose, c.taskType, requested.slice(0, 80), hold, c.promptChars, new Date(started).toISOString());
    return { prior: null };
  });

  if (gate.prior) {
    const p = gate.prior;
    if (p.status === "running") throw new GatewayError("in-progress", "A request with this idempotency key is still running.");
    if (p.status === "failed") throw new GatewayError("provider-failed", `That request already failed (${p.error_code ?? "error"}) and nothing was charged. Send it again with a new idempotency key.`);
    const model = getModel(p.model_id ?? "")!;
    return { requestId: p.id, replayed: true, text: "", model: { id: model.id, label: model.label, tier: model.tier }, fallbackUsed: p.fallback_used === 1, attempts: p.attempts, usage: { inputTokens: p.input_tokens, outputTokens: p.output_tokens, cacheReadTokens: p.cache_read_tokens, cacheWriteTokens: p.cache_write_tokens }, usageEstimated: p.usage_source === "estimated", priceVersion: p.price_version, chargedUnits: p.charged_units, uncollectedUnits: p.uncollected_units, latencyMs: p.latency_ms ?? 0, wallet: getWallet(orgId) };
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
  /** Every try at a provider is recorded, successful or not, so retries and fallbacks are visible and their cost can be questioned. */
  const logAttempt = (no: number, modelId: string, outcome: "success" | "retryable-error" | "error", detail: { error?: string; latencyMs: number; input?: number; output?: number }) =>
    db.prepare("INSERT OR IGNORE INTO ai_request_attempts (request_id, attempt_no, model_id, outcome, error_message, latency_ms, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(requestId, no, modelId, outcome, detail.error ? detail.error.slice(0, 300) : null, detail.latencyMs, detail.input ?? 0, detail.output ?? 0, new Date(clock()).toISOString());
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
        const tryStarted = clock();
        const out = await provider.complete({ providerModel: model.providerModel, system: c.system, messages: c.messages, maxOutputTokens: outputFor(model, c.maxOutputTokens), signal: AbortSignal.timeout(LIMITS.attemptTimeoutMs) });
        // ---- measure and settle the REAL cost ----
        // What the provider says it used. If it said nothing readable the work was still done (and billed to us), so the charge is worked out from
        // the gateway's own estimate (about 4 characters a token, the ordinary figure rather than the cautious one used for the hold) and flagged.
        let usage: Usage = { inputTokens: out.inputTokens, outputTokens: out.outputTokens, cacheReadTokens: out.cacheReadTokens ?? 0, cacheWriteTokens: out.cacheWriteTokens ?? 0, otherChargesMicroUsd: out.otherChargesMicroUsd ?? 0 };
        let estimated = out.usageMissing === true;
        let costUsd = 0;
        if (!estimated) { try { costUsd = usageCostMicroUsd(model, usage); } catch { estimated = true; } } // negative or fractional counts from a provider are not trusted
        if (estimated) {
          usage = { inputTokens: Math.ceil(c.promptChars / 4), outputTokens: Math.ceil(out.text.length / 4), cacheReadTokens: 0, cacheWriteTokens: 0, otherChargesMicroUsd: 0 };
          costUsd = usageCostMicroUsd(model, usage);
        }
        const markup = resolveMarkup(model, c.taskType, db);
        const priced = chargeUnits(costUsd, markup.basisPoints, rate, policy);
        const units = priced.units;
        logAttempt(attempts, model.id, "success", { latencyMs: clock() - tryStarted, input: usage.inputTokens, output: usage.outputTokens });
        let held = hold;
        if (reservationId && units > held) {
          // The prompt was bigger than estimated. Hold the difference if the wallet has it; otherwise charge only what was held.
          try { extendReservation({ orgId, reservationId, extraUnits: units - held, idempotencyKey: `ai-extend:${requestId}` }); held = units; } catch (e) { if (!(e instanceof CreditError)) throw e; }
        }
        const charged = Math.min(units, held);
        if (reservationId) settleReservation({ orgId, reservationId, actualUnits: charged, note: `ai:${model.id}` });
        const latencyMs = clock() - started;
        db.prepare(
          `UPDATE ai_requests SET status = 'completed', model_id = ?, fallback_used = ?, attempts = ?, reserved_units = ?, response_chars = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, other_charge_micro_usd = ?,
             provider_cost_micro_usd = ?, price_version = ?, markup_basis_points = ?, markup_source = ?, usage_source = ?, usage_raw = ?, min_charge_applied = ?,
             charged_units = ?, uncollected_units = ?, provider_request_id = ?, latency_ms = ?, finished_at = ? WHERE id = ?`,
        ).run(model.id, i > 0 ? 1 : 0, attempts, held, out.text.length, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0, usage.otherChargesMicroUsd ?? 0,
          costUsd, model.priceVersion, markup.basisPoints, markup.source, estimated ? "estimated" : "provider", out.raw ? JSON.stringify(out.raw) : null, priced.minApplied ? 1 : 0,
          charged, units - charged, out.providerRequestId, latencyMs, new Date(clock()).toISOString(), requestId);
        return { requestId, replayed: false, text: out.text, model: { id: model.id, label: model.label, tier: model.tier }, fallbackUsed: i > 0, attempts, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens ?? 0, cacheWriteTokens: usage.cacheWriteTokens ?? 0 }, usageEstimated: estimated, priceVersion: model.priceVersion, chargedUnits: charged, uncollectedUnits: units - charged, latencyMs, wallet: getWallet(orgId) };
      } catch (e) {
        if (!(e instanceof ProviderError)) { logAttempt(attempts, model.id, "error", { error: (e as Error).message, latencyMs: clock() - started }); giveBack("ai request failed"); fail("error", (e as Error).message, { attempts }); throw e; }
        logAttempt(attempts, model.id, e.retryable ? "retryable-error" : "error", { error: e.message, latencyMs: clock() - started });
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

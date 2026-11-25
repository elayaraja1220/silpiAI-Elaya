import type { DatabaseSync } from "node:sqlite";

import { getDb, transaction } from "@/lib/business/db";
import { ValidationError } from "@/lib/business/validate";
import { creditsPerThousandTokens, DEFAULT_POLICY, type MeteringPolicy, type ModelPrice } from "./pricing";

/** Models, the one conversion setting, per-organization limits and usage reports. Server only. */

export const TIERS = ["fast", "balanced", "best", "demo"] as const;
export type Tier = (typeof TIERS)[number];

/** What a request is for. It selects the markup rule and (later) the routing rule. */
export const TASK_TYPES = ["chat", "document_analysis", "architecture_planning", "code_generation", "bug_fixing", "code_review", "other"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export type AiModel = ModelPrice & { id: string; provider: string; providerModel: string; label: string; tier: Tier; maxOutputTokens: number; priority: number; enabled: boolean; cacheReadUsdMicroPerMtok: number | null; cacheWriteUsdMicroPerMtok: number | null; priceVersion: number };
type ModelRow = { id: string; provider: string; provider_model: string; label: string; tier: Tier; input_usd_micro_per_mtok: number; output_usd_micro_per_mtok: number; cache_read_usd_micro_per_mtok: number | null; cache_write_usd_micro_per_mtok: number | null; price_version: number; markup_basis_points: number; max_output_tokens: number; priority: number; enabled: number };

const toModel = (r: ModelRow): AiModel => ({ id: r.id, provider: r.provider, providerModel: r.provider_model, label: r.label, tier: r.tier, inputUsdMicroPerMtok: r.input_usd_micro_per_mtok, outputUsdMicroPerMtok: r.output_usd_micro_per_mtok, cacheReadUsdMicroPerMtok: r.cache_read_usd_micro_per_mtok, cacheWriteUsdMicroPerMtok: r.cache_write_usd_micro_per_mtok, priceVersion: r.price_version, markupBasisPoints: r.markup_basis_points, maxOutputTokens: r.max_output_tokens, priority: r.priority, enabled: r.enabled === 1 });
const bad = (m: string) => new ValidationError(m);
const whole = (v: unknown, what: string, min: number, max: number): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw bad(`${what} must be a whole number from ${min} to ${max}.`);
  return v;
};

// ---- models ------------------------------------------------------------------------------------------------------------
export function listModels(opts: { enabledOnly?: boolean } = {}, db: DatabaseSync = getDb()): AiModel[] {
  const rows = db.prepare(`SELECT * FROM ai_models ${opts.enabledOnly ? "WHERE enabled = 1" : ""} ORDER BY CASE tier WHEN 'fast' THEN 1 WHEN 'balanced' THEN 2 WHEN 'best' THEN 3 ELSE 4 END, priority, id`).all() as ModelRow[];
  return rows.map(toModel);
}
export const getModel = (id: string, db: DatabaseSync = getDb()): AiModel | null => {
  const row = db.prepare("SELECT * FROM ai_models WHERE id = ?").get(id) as ModelRow | undefined;
  return row ? toModel(row) : null;
};

export type ModelInput = Partial<Omit<AiModel, "id" | "priceVersion">> & { id: string; /** Why the price changed, kept with the new version. */ note?: string; changedBy?: string };
const optionalPrice = (v: unknown, what: string): number | null => (v === null || v === undefined ? null : whole(v, what, 0, 1_000_000_000));

/**
 * Creates or updates a model (admin). Only the fields given change. Prices are whole micro-USD per million tokens.
 * Every change to a price or to the model's markup writes a NEW price version (append-only history), so what any past request was
 * charged can always be re-derived. Other changes (label, priority, enabled) do not.
 */
export function saveModel(input: ModelInput): AiModel {
  const id = String(input.id ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,60}$/.test(id)) throw bad("id must be 2 to 61 lowercase letters, digits, dots, dashes or underscores.");
  return transaction((db) => {
    const existing = getModel(id, db);
    const m = { ...(existing ?? { provider: "", providerModel: "", label: "", tier: "balanced" as Tier, inputUsdMicroPerMtok: 0, outputUsdMicroPerMtok: 0, cacheReadUsdMicroPerMtok: null, cacheWriteUsdMicroPerMtok: null, markupBasisPoints: 10_000, maxOutputTokens: 4096, priority: 100, enabled: false, priceVersion: 0 }), ...input, id };
    if (!existing && (!input.provider || !input.providerModel || !input.label)) throw bad("A new model needs provider, providerModel and label.");
    if (!m.provider.trim() || !m.providerModel.trim() || !m.label.trim() || m.label.length > 60) throw bad("provider, providerModel and label are required (label up to 60 characters).");
    if (!(TIERS as readonly string[]).includes(m.tier)) throw bad(`tier must be one of: ${TIERS.join(", ")}.`);
    whole(m.inputUsdMicroPerMtok, "inputUsdMicroPerMtok", 0, 1_000_000_000);
    whole(m.outputUsdMicroPerMtok, "outputUsdMicroPerMtok", 0, 1_000_000_000);
    const cacheRead = optionalPrice(m.cacheReadUsdMicroPerMtok, "cacheReadUsdMicroPerMtok");
    const cacheWrite = optionalPrice(m.cacheWriteUsdMicroPerMtok, "cacheWriteUsdMicroPerMtok");
    whole(m.markupBasisPoints, "markupBasisPoints", 0, 100_000);
    whole(m.maxOutputTokens, "maxOutputTokens", 1, 200_000);
    whole(m.priority, "priority", 0, 10_000);
    if (m.provider !== "echo" && m.enabled && (m.inputUsdMicroPerMtok === 0 || m.outputUsdMicroPerMtok === 0)) throw bad("A real provider model cannot be enabled with a zero price: it would give the AI away free.");

    const changedPrice = !existing || existing.inputUsdMicroPerMtok !== m.inputUsdMicroPerMtok || existing.outputUsdMicroPerMtok !== m.outputUsdMicroPerMtok || existing.cacheReadUsdMicroPerMtok !== cacheRead || existing.cacheWriteUsdMicroPerMtok !== cacheWrite || existing.markupBasisPoints !== m.markupBasisPoints;
    const version = changedPrice ? (existing?.priceVersion ?? 0) + 1 : existing!.priceVersion;
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO ai_models (id, provider, provider_model, label, tier, input_usd_micro_per_mtok, output_usd_micro_per_mtok, cache_read_usd_micro_per_mtok, cache_write_usd_micro_per_mtok, price_version, markup_basis_points, max_output_tokens, priority, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, provider_model = excluded.provider_model, label = excluded.label, tier = excluded.tier,
         input_usd_micro_per_mtok = excluded.input_usd_micro_per_mtok, output_usd_micro_per_mtok = excluded.output_usd_micro_per_mtok,
         cache_read_usd_micro_per_mtok = excluded.cache_read_usd_micro_per_mtok, cache_write_usd_micro_per_mtok = excluded.cache_write_usd_micro_per_mtok, price_version = excluded.price_version,
         markup_basis_points = excluded.markup_basis_points, max_output_tokens = excluded.max_output_tokens, priority = excluded.priority, enabled = excluded.enabled, updated_at = excluded.updated_at`,
    ).run(id, m.provider.trim(), m.providerModel.trim(), m.label.trim(), m.tier, m.inputUsdMicroPerMtok, m.outputUsdMicroPerMtok, cacheRead, cacheWrite, version, m.markupBasisPoints, m.maxOutputTokens, m.priority, m.enabled ? 1 : 0, at, at);
    if (changedPrice) {
      db.prepare(
        `INSERT INTO model_prices (model_id, version, input_usd_micro_per_mtok, output_usd_micro_per_mtok, cache_read_usd_micro_per_mtok, cache_write_usd_micro_per_mtok, markup_basis_points, note, changed_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, version, m.inputUsdMicroPerMtok, m.outputUsdMicroPerMtok, cacheRead, cacheWrite, m.markupBasisPoints, String(input.note ?? "").slice(0, 300), String(input.changedBy ?? "").slice(0, 80), at);
    }
    return getModel(id, db)!;
  });
}

export type PriceVersion = { modelId: string; version: number; inputUsdMicroPerMtok: number; outputUsdMicroPerMtok: number; cacheReadUsdMicroPerMtok: number | null; cacheWriteUsdMicroPerMtok: number | null; markupBasisPoints: number; note: string; changedBy: string; createdAt: string };
type PriceRow = { model_id: string; version: number; input_usd_micro_per_mtok: number; output_usd_micro_per_mtok: number; cache_read_usd_micro_per_mtok: number | null; cache_write_usd_micro_per_mtok: number | null; markup_basis_points: number; note: string; changed_by: string; created_at: string };
const toVersion = (r: PriceRow): PriceVersion => ({ modelId: r.model_id, version: r.version, inputUsdMicroPerMtok: r.input_usd_micro_per_mtok, outputUsdMicroPerMtok: r.output_usd_micro_per_mtok, cacheReadUsdMicroPerMtok: r.cache_read_usd_micro_per_mtok, cacheWriteUsdMicroPerMtok: r.cache_write_usd_micro_per_mtok, markupBasisPoints: r.markup_basis_points, note: r.note, changedBy: r.changed_by, createdAt: r.created_at });
/** Every price a model has had, newest first. */
export const listPriceHistory = (modelId: string, db: DatabaseSync = getDb()): PriceVersion[] =>
  (db.prepare("SELECT * FROM model_prices WHERE model_id = ? ORDER BY version DESC").all(modelId) as PriceRow[]).map(toVersion);
/** The exact price a request was charged at. */
export const getPriceVersion = (modelId: string, version: number, db: DatabaseSync = getDb()): PriceVersion | null => {
  const row = db.prepare("SELECT * FROM model_prices WHERE model_id = ? AND version = ?").get(modelId, version) as PriceRow | undefined;
  return row ? toVersion(row) : null;
};

// ---- markup rules --------------------------------------------------------------------------------------------------------------
export type MarkupRule = { id: number; provider: string | null; modelId: string | null; taskType: TaskType | null; markupBasisPoints: number; enabled: boolean; note: string };
type RuleRow = { id: number; provider: string | null; model_id: string | null; task_type: TaskType | null; markup_basis_points: number; enabled: number; note: string };
const toRule = (r: RuleRow): MarkupRule => ({ id: r.id, provider: r.provider, modelId: r.model_id, taskType: r.task_type, markupBasisPoints: r.markup_basis_points, enabled: r.enabled === 1, note: r.note });
export const listMarkupRules = (db: DatabaseSync = getDb()): MarkupRule[] => (db.prepare("SELECT * FROM markup_rules ORDER BY id").all() as RuleRow[]).map(toRule);

/** Creates a markup rule, or changes the one named by id. At least one of provider, modelId and taskType must be set. */
export function saveMarkupRule(input: { id?: number; provider?: string | null; modelId?: string | null; taskType?: string | null; markupBasisPoints: number; enabled?: boolean; note?: string }): MarkupRule {
  const db = getDb();
  const provider = input.provider ? String(input.provider).trim() : null;
  const modelId = input.modelId ? String(input.modelId).trim() : null;
  const taskType = input.taskType ? String(input.taskType).trim() : null;
  if (!provider && !modelId && !taskType) throw bad("A markup rule needs a provider, a model, a task type, or a mix.");
  if (modelId && !getModel(modelId, db)) throw bad("That model does not exist.");
  if (taskType && !(TASK_TYPES as readonly string[]).includes(taskType)) throw bad(`taskType must be one of: ${TASK_TYPES.join(", ")}.`);
  whole(input.markupBasisPoints, "markupBasisPoints", 0, 1_000_000);
  const at = new Date().toISOString();
  const note = String(input.note ?? "").slice(0, 300);
  if (input.id !== undefined) {
    if (!db.prepare("SELECT 1 FROM markup_rules WHERE id = ?").get(input.id)) throw bad("That markup rule does not exist.");
    db.prepare("UPDATE markup_rules SET provider = ?, model_id = ?, task_type = ?, markup_basis_points = ?, enabled = ?, note = ?, updated_at = ? WHERE id = ?").run(provider, modelId, taskType, input.markupBasisPoints, input.enabled === false ? 0 : 1, note, at, input.id);
    return toRule(db.prepare("SELECT * FROM markup_rules WHERE id = ?").get(input.id) as RuleRow);
  }
  const info = db.prepare("INSERT INTO markup_rules (provider, model_id, task_type, markup_basis_points, enabled, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(provider, modelId, taskType, input.markupBasisPoints, input.enabled === false ? 0 : 1, note, at, at);
  return toRule(db.prepare("SELECT * FROM markup_rules WHERE id = ?").get(Number(info.lastInsertRowid)) as RuleRow);
}
export function deleteMarkupRule(id: number): void {
  if (getDb().prepare("DELETE FROM markup_rules WHERE id = ?").run(id).changes !== 1) throw bad("That markup rule does not exist.");
}

/**
 * The markup a request is charged at. Every enabled rule whose set fields all match the request is a candidate; the most specific wins:
 * a model counts most (8), then a task type (4), then a provider (2). A tie goes to the newest rule. With no matching rule the model's own markup applies.
 */
export function resolveMarkup(model: { id: string; provider: string; markupBasisPoints: number }, taskType: string, db: DatabaseSync = getDb()): { basisPoints: number; source: string } {
  const rows = db
    .prepare("SELECT * FROM markup_rules WHERE enabled = 1 AND (provider IS NULL OR provider = ?) AND (model_id IS NULL OR model_id = ?) AND (task_type IS NULL OR task_type = ?)")
    .all(model.provider, model.id, taskType) as RuleRow[];
  let best: { rule: RuleRow; score: number } | null = null;
  for (const r of rows) {
    const score = (r.model_id ? 8 : 0) + (r.task_type ? 4 : 0) + (r.provider ? 2 : 0);
    if (!best || score > best.score || (score === best.score && r.id > best.rule.id)) best = { rule: r, score };
  }
  return best ? { basisPoints: best.rule.markup_basis_points, source: `rule:${best.rule.id}` } : { basisPoints: model.markupBasisPoints, source: "price" };
}

// ---- metering policy -----------------------------------------------------------------------------------------------------------
/** How a charge is rounded and the smallest charge for a request that cost anything. Settings: ai_rounding (up | nearest), ai_min_charge_units. */
export function getMeteringPolicy(db: DatabaseSync = getDb()): MeteringPolicy {
  const read = (k: string) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined)?.value;
  const min = Number(read("ai_min_charge_units") ?? DEFAULT_POLICY.minChargeUnits);
  return { rounding: read("ai_rounding") === "nearest" ? "nearest" : "up", minChargeUnits: Number.isSafeInteger(min) && min >= 0 ? min : DEFAULT_POLICY.minChargeUnits };
}
export function setMeteringPolicy(patch: { rounding?: unknown; minChargeUnits?: unknown }): MeteringPolicy {
  const db = getDb();
  if (patch.rounding !== undefined) {
    if (patch.rounding !== "up" && patch.rounding !== "nearest") throw bad('rounding must be "up" or "nearest".');
    db.prepare("INSERT INTO settings (key, value) VALUES ('ai_rounding', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(patch.rounding);
  }
  if (patch.minChargeUnits !== undefined) {
    whole(patch.minChargeUnits, "minChargeUnits", 0, 1_000_000);
    db.prepare("INSERT INTO settings (key, value) VALUES ('ai_min_charge_units', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(patch.minChargeUnits));
  }
  return getMeteringPolicy(db);
}

// ---- settings and limits ---------------------------------------------------------------------------------------------------
export const DEFAULT_UNITS_PER_USD = 45_000;
export function getUnitsPerUsd(db: DatabaseSync = getDb()): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'ai_units_per_usd'").get() as { value: string } | undefined;
  const n = row ? Number(row.value) : DEFAULT_UNITS_PER_USD;
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_UNITS_PER_USD;
}
export function setUnitsPerUsd(value: number): number {
  whole(value, "unitsPerUsd", 1, 10_000_000);
  getDb().prepare("INSERT INTO settings (key, value) VALUES ('ai_units_per_usd', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(value));
  return value;
}

export const getDailyCap = (orgId: string, db: DatabaseSync = getDb()): number | null =>
  (db.prepare("SELECT daily_cap_units AS cap FROM ai_org_limits WHERE org_id = ?").get(orgId) as { cap: number | null } | undefined)?.cap ?? null;
/** null removes the cap. 0 blocks AI use for the organization. */
export function setDailyCap(orgId: string, cap: number | null): number | null {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM organizations WHERE id = ?").get(orgId)) throw bad("That organization does not exist.");
  if (cap !== null) whole(cap, "dailyCapUnits", 0, 1_000_000_000_000);
  db.prepare("INSERT INTO ai_org_limits (org_id, daily_cap_units, updated_at) VALUES (?, ?, ?) ON CONFLICT(org_id) DO UPDATE SET daily_cap_units = excluded.daily_cap_units, updated_at = excluded.updated_at").run(orgId, cap, new Date().toISOString());
  return cap;
}

// ---- the customer-facing price list ----------------------------------------------------------------------------------------
export type PublicModel = { id: string; label: string; tier: Tier; maxOutputTokens: number; creditsPer1kInput: number; creditsPer1kOutput: number };
/** What a customer may see: names and credit prices only. Never the provider, the provider's price or the markup. */
export function publicModels(db: DatabaseSync = getDb()): PublicModel[] {
  const rate = getUnitsPerUsd(db);
  return listModels({ enabledOnly: true }, db).map((m) => ({ id: m.id, label: m.label, tier: m.tier, maxOutputTokens: m.maxOutputTokens, creditsPer1kInput: creditsPerThousandTokens(m, rate, "input"), creditsPer1kOutput: creditsPerThousandTokens(m, rate, "output") }));
}

// ---- usage -------------------------------------------------------------------------------------------------------------------
const startOfUtcDay = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
const startOfUtcMonth = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();

export type RequestRow = { id: string; status: "running" | "completed" | "failed"; purpose: string; requestedModel: string; modelId: string | null; fallbackUsed: boolean; attempts: number; inputTokens: number; outputTokens: number; chargedUnits: number; uncollectedUnits: number; errorCode: string | null; latencyMs: number | null; createdAt: string };
export function listRequests(orgId: string, limit = 25): RequestRow[] {
  const rows = getDb()
    .prepare("SELECT id, status, purpose, requested_model, model_id, fallback_used, attempts, input_tokens, output_tokens, charged_units, uncollected_units, error_code, latency_ms, created_at FROM ai_requests WHERE org_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(orgId, Math.min(Math.max(1, Math.floor(limit)), 200)) as Record<string, string | number | null>[];
  return rows.map((r) => ({ id: r.id as string, status: r.status as RequestRow["status"], purpose: r.purpose as string, requestedModel: r.requested_model as string, modelId: r.model_id as string | null, fallbackUsed: r.fallback_used === 1, attempts: r.attempts as number, inputTokens: r.input_tokens as number, outputTokens: r.output_tokens as number, chargedUnits: r.charged_units as number, uncollectedUnits: r.uncollected_units as number, errorCode: r.error_code as string | null, latencyMs: r.latency_ms as number | null, createdAt: r.created_at as string }));
}

export type UsageSummary = { dailyCapUnits: number | null; today: Period; month: Period; byModel: { modelId: string; requests: number; inputTokens: number; outputTokens: number; chargedUnits: number }[] };
type Period = { requests: number; failed: number; chargedUnits: number; inputTokens: number; outputTokens: number };
export function usageSummary(orgId: string): UsageSummary {
  const db = getDb();
  const period = (since: string): Period =>
    db.prepare(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(status = 'failed'), 0) AS failed, COALESCE(SUM(charged_units), 0) AS chargedUnits, COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens
         FROM ai_requests WHERE org_id = ? AND created_at >= ?`,
    ).get(orgId, since) as Period;
  const byModel = db
    .prepare(
      `SELECT model_id AS modelId, COUNT(*) AS requests, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens, SUM(charged_units) AS chargedUnits
         FROM ai_requests WHERE org_id = ? AND status = 'completed' AND created_at >= ? GROUP BY model_id ORDER BY chargedUnits DESC`,
    )
    .all(orgId, startOfUtcMonth()) as UsageSummary["byModel"];
  return { dailyCapUnits: getDailyCap(orgId, db), today: period(startOfUtcDay()), month: period(startOfUtcMonth()), byModel };
}

/** The administrator's view: what the providers cost versus what customers were charged, per organization, this month. */
export function adminOverview(): { unitsPerUsd: number; policy: MeteringPolicy; markupRules: MarkupRule[]; models: AiModel[]; organizations: { orgId: string; orgName: string; requests: number; failed: number; providerCostMicroUsd: number; chargedUnits: number; chargedUsdAtCurrentRate: number; dailyCapUnits: number | null }[] } {
  const db = getDb();
  const rate = getUnitsPerUsd(db);
  const rows = db
    .prepare(
      `SELECT r.org_id AS orgId, o.name AS orgName, COUNT(*) AS requests, COALESCE(SUM(r.status = 'failed'), 0) AS failed, COALESCE(SUM(r.provider_cost_micro_usd), 0) AS providerCostMicroUsd, COALESCE(SUM(r.charged_units), 0) AS chargedUnits
         FROM ai_requests r JOIN organizations o ON o.id = r.org_id WHERE r.created_at >= ? GROUP BY r.org_id ORDER BY chargedUnits DESC`,
    )
    .all(startOfUtcMonth()) as { orgId: string; orgName: string; requests: number; failed: number; providerCostMicroUsd: number; chargedUnits: number }[];
  return { unitsPerUsd: rate, policy: getMeteringPolicy(db), markupRules: listMarkupRules(db), models: listModels({}, db), organizations: rows.map((r) => ({ ...r, chargedUsdAtCurrentRate: r.chargedUnits / rate, dailyCapUnits: getDailyCap(r.orgId, db) })) };
}

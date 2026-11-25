import type { DatabaseSync } from "node:sqlite";

import { getDb } from "@/lib/business/db";
import { ValidationError } from "@/lib/business/validate";
import { creditsPerThousandTokens, type ModelPrice } from "./pricing";

/** Models, the one conversion setting, per-organization limits and usage reports. Server only. */

export const TIERS = ["fast", "balanced", "best", "demo"] as const;
export type Tier = (typeof TIERS)[number];

export type AiModel = ModelPrice & { id: string; provider: string; providerModel: string; label: string; tier: Tier; maxOutputTokens: number; priority: number; enabled: boolean };
type ModelRow = { id: string; provider: string; provider_model: string; label: string; tier: Tier; input_usd_micro_per_mtok: number; output_usd_micro_per_mtok: number; markup_basis_points: number; max_output_tokens: number; priority: number; enabled: number };

const toModel = (r: ModelRow): AiModel => ({ id: r.id, provider: r.provider, providerModel: r.provider_model, label: r.label, tier: r.tier, inputUsdMicroPerMtok: r.input_usd_micro_per_mtok, outputUsdMicroPerMtok: r.output_usd_micro_per_mtok, markupBasisPoints: r.markup_basis_points, maxOutputTokens: r.max_output_tokens, priority: r.priority, enabled: r.enabled === 1 });
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

export type ModelInput = Partial<Omit<AiModel, "id">> & { id: string };
/** Creates or updates a model (admin). Only the fields given change. Prices are whole micro-USD per million tokens. */
export function saveModel(input: ModelInput): AiModel {
  const db = getDb();
  const id = String(input.id ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,60}$/.test(id)) throw bad("id must be 2 to 61 lowercase letters, digits, dots, dashes or underscores.");
  const existing = getModel(id, db);
  const m = { ...(existing ?? { provider: "", providerModel: "", label: "", tier: "balanced" as Tier, inputUsdMicroPerMtok: 0, outputUsdMicroPerMtok: 0, markupBasisPoints: 10_000, maxOutputTokens: 4096, priority: 100, enabled: false }), ...input, id };
  if (!existing && (!input.provider || !input.providerModel || !input.label)) throw bad("A new model needs provider, providerModel and label.");
  if (!m.provider.trim() || !m.providerModel.trim() || !m.label.trim() || m.label.length > 60) throw bad("provider, providerModel and label are required (label up to 60 characters).");
  if (!(TIERS as readonly string[]).includes(m.tier)) throw bad(`tier must be one of: ${TIERS.join(", ")}.`);
  whole(m.inputUsdMicroPerMtok, "inputUsdMicroPerMtok", 0, 1_000_000_000);
  whole(m.outputUsdMicroPerMtok, "outputUsdMicroPerMtok", 0, 1_000_000_000);
  whole(m.markupBasisPoints, "markupBasisPoints", 0, 100_000);
  whole(m.maxOutputTokens, "maxOutputTokens", 1, 200_000);
  whole(m.priority, "priority", 0, 10_000);
  if (m.provider !== "echo" && m.enabled && (m.inputUsdMicroPerMtok === 0 || m.outputUsdMicroPerMtok === 0)) throw bad("A real provider model cannot be enabled with a zero price: it would give the AI away free.");
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO ai_models (id, provider, provider_model, label, tier, input_usd_micro_per_mtok, output_usd_micro_per_mtok, markup_basis_points, max_output_tokens, priority, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, provider_model = excluded.provider_model, label = excluded.label, tier = excluded.tier,
       input_usd_micro_per_mtok = excluded.input_usd_micro_per_mtok, output_usd_micro_per_mtok = excluded.output_usd_micro_per_mtok, markup_basis_points = excluded.markup_basis_points,
       max_output_tokens = excluded.max_output_tokens, priority = excluded.priority, enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).run(id, m.provider.trim(), m.providerModel.trim(), m.label.trim(), m.tier, m.inputUsdMicroPerMtok, m.outputUsdMicroPerMtok, m.markupBasisPoints, m.maxOutputTokens, m.priority, m.enabled ? 1 : 0, at, at);
  return getModel(id, db)!;
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
export function adminOverview(): { unitsPerUsd: number; models: AiModel[]; organizations: { orgId: string; orgName: string; requests: number; failed: number; providerCostMicroUsd: number; chargedUnits: number; chargedUsdAtCurrentRate: number; dailyCapUnits: number | null }[] } {
  const db = getDb();
  const rate = getUnitsPerUsd(db);
  const rows = db
    .prepare(
      `SELECT r.org_id AS orgId, o.name AS orgName, COUNT(*) AS requests, COALESCE(SUM(r.status = 'failed'), 0) AS failed, COALESCE(SUM(r.provider_cost_micro_usd), 0) AS providerCostMicroUsd, COALESCE(SUM(r.charged_units), 0) AS chargedUnits
         FROM ai_requests r JOIN organizations o ON o.id = r.org_id WHERE r.created_at >= ? GROUP BY r.org_id ORDER BY chargedUnits DESC`,
    )
    .all(startOfUtcMonth()) as { orgId: string; orgName: string; requests: number; failed: number; providerCostMicroUsd: number; chargedUnits: number }[];
  return { unitsPerUsd: rate, models: listModels({}, db), organizations: rows.map((r) => ({ ...r, chargedUsdAtCurrentRate: r.chargedUnits / rate, dailyCapUnits: getDailyCap(r.orgId, db) })) };
}

import {
  FREQUENCIES,
  INFRA_BASES,
  LINE_KINDS,
  RECURRING_CATEGORIES,
  ROLES,
  SECURITY_LEVELS,
  type Allocation,
  type AiModelPrice,
  type CostConfig,
  type CostConfigPatch,
  type InfraRate,
  type LineKind,
  type Role,
  type RunningCostDefault,
} from "./cost-types";
import { DEFAULT_TECH_CATALOG, SCALES } from "./tech-catalog";

/**
 * Cost configuration: validation, merging and the empty starting point.
 *
 * There are no built-in rates. Every internal rate, allocation, AI price and
 * exchange rate starts unset and is reported as missing until the studio
 * enters it. The same checks read saved data (leniently: bad values are
 * dropped) and accept changes (strictly: bad values are reported, nothing saved).
 */

export function emptyCostConfig(): CostConfig {
  return {
    roleRates: { frontend: null, backend: null, uiux: null, qa: null, pm: null, deployment: null },
    allocation: { setup: null, page: null, "feature-frontend": null, "feature-backend": null, design: null, "premium-care": null, other: null },
    techFactors: {},
    uplifts: { scale: {}, security: {} },
    usdToInr: null,
    fxRates: {},
    aiPricing: {},
    infra: null,
    minMarginPercent: null,
    runningCosts: {},
  };
}

// ---- Small validators ---------------------------------------------------------------

type Check<T> = (v: unknown) => { ok: true; value: T } | { ok: false };
const ok = <T,>(value: T) => ({ ok: true as const, value });
const bad = { ok: false as const };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const numberIn = (min: number, max: number, digits = 2): Check<number> => (v) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? ok(Math.round(v * 10 ** digits) / 10 ** digits) : bad;
const orNull = <T,>(check: Check<T>): Check<T | null> => (v) => (v === null ? ok(null) : check(v));

const RATE = numberIn(0, 1_000_000);
const PERCENT = numberIn(0, 300);
const FACTOR = numberIn(0.1, 5);
const MAX_AI_MODELS = 30;
const MAX_INFRA = 20;

const ALLOCATION: Check<Allocation | null> = (v) => {
  if (v === null) return ok(null);
  if (!isObj(v)) return bad;
  const out: Allocation = {};
  for (const [role, value] of Object.entries(v)) {
    const n = PERCENT(value);
    if (!(ROLES as readonly string[]).includes(role) || !n.ok) return bad;
    out[role as Role] = n.value;
  }
  return Object.keys(out).length ? ok(out) : bad;
};

const AI_PRICE: Check<AiModelPrice | null> = (v) => {
  if (v === null) return ok(null);
  if (!isObj(v)) return bad;
  const money = numberIn(0, 100_000, 4);
  const input = money(v.inputPerMTok);
  const output = money(v.outputPerMTok);
  if (!input.ok || !output.ok) return bad;
  const price: AiModelPrice = { inputPerMTok: input.value, outputPerMTok: output.value };
  for (const key of ["cacheReadPerMTok", "cacheWritePerMTok"] as const) {
    if (v[key] === undefined) continue;
    const n = money(v[key]);
    if (!n.ok) return bad;
    price[key] = n.value;
  }
  return ok(price);
};

const INFRA: Check<InfraRate[] | null> = (v) => {
  if (v === null) return ok(null);
  if (!Array.isArray(v) || v.length > MAX_INFRA) return bad;
  const out: InfraRate[] = [];
  for (const raw of v) {
    if (!isObj(raw) || typeof raw.key !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(raw.key)) return bad;
    if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 80) return bad;
    if (!(INFRA_BASES as readonly string[]).includes(raw.basis as string)) return bad;
    const amount = orNull(numberIn(0, 100_000_000))(raw.amount === undefined ? null : raw.amount);
    if (!amount.ok || out.some((i) => i.key === raw.key)) return bad;
    out.push({ key: raw.key, name: raw.name.trim(), basis: raw.basis as InfraRate["basis"], amount: amount.value });
  }
  return ok(out);
};

const RUNNING_DEFAULT: Check<RunningCostDefault | null> = (v) => {
  if (v === null) return ok(null);
  if (!isObj(v)) return bad;
  const kind = v.kind;
  const necessity = v.necessity;
  const payer = v.payer;
  const status = v.status;
  if (kind !== "one-time" && kind !== "recurring") return bad;
  if (necessity !== "mandatory" && necessity !== "optional") return bad;
  if (payer !== "client" && payer !== "studio") return bad;
  if (status !== "actual" && status !== "estimated") return bad;
  const amount = orNull(numberIn(0, 100_000_000))(v.amount === undefined ? null : v.amount);
  if (!amount.ok) return bad;
  if (v.amountType !== undefined && v.amountType !== "fixed" && v.amountType !== "percent-of-transaction") return bad;
  if (v.frequency !== undefined && !(FREQUENCIES as readonly string[]).includes(v.frequency as string)) return bad;
  if (v.provider !== undefined && (typeof v.provider !== "string" || v.provider.length > 80)) return bad;
  if (v.note !== undefined && (typeof v.note !== "string" || v.note.length > 200)) return bad;
  // A known recurring amount needs to say how often it is charged (a percentage of sales does not).
  if (kind === "recurring" && amount.value !== null && v.amountType !== "percent-of-transaction" && v.frequency === undefined) return bad;
  const out: RunningCostDefault = { kind, amount: amount.value, necessity, payer, status };
  if (typeof v.provider === "string" && v.provider.trim()) out.provider = v.provider.trim();
  if (v.amountType !== undefined) out.amountType = v.amountType as RunningCostDefault["amountType"];
  if (v.frequency !== undefined) out.frequency = v.frequency as RunningCostDefault["frequency"];
  if (typeof v.note === "string" && v.note.trim()) out.note = v.note.trim();
  return ok(out);
};

const KNOWN_TECH = new Set(DEFAULT_TECH_CATALOG.map((t) => t.id));
const TOP_LEVEL = ["roleRates", "allocation", "techFactors", "uplifts", "usdToInr", "fxRates", "aiPricing", "infra", "minMarginPercent", "runningCosts"];

/** Reads a (partial) configuration. Valid entries go into `patch`; everything else is listed in `problems`. */
export function readCostPatch(input: unknown): { patch: CostConfigPatch; problems: string[] } {
  const patch: CostConfigPatch = {};
  const problems: string[] = [];
  if (!isObj(input)) return { patch, problems: ["The cost settings must be an object."] };
  for (const key of Object.keys(input)) if (!TOP_LEVEL.includes(key)) problems.push(`"${key.slice(0, 40)}" is not a cost setting.`);

  /** Reads a map of known keys, each checked on its own. */
  const section = <T,>(name: string, raw: unknown, allowed: (k: string) => boolean, check: Check<T>, hint: string): Record<string, T> | undefined => {
    if (!isObj(raw)) {
      problems.push(`${name} must be an object.`);
      return undefined;
    }
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(raw)) {
      const r = allowed(k) ? check(v) : bad;
      if (r.ok) out[k] = r.value;
      else problems.push(allowed(k) ? `${name}.${k} ${hint}` : `${name}.${k.slice(0, 40)} is not allowed.`);
    }
    return out;
  };

  if ("roleRates" in input) patch.roleRates = section("roleRates", input.roleRates, (k) => (ROLES as readonly string[]).includes(k), orNull(RATE), "must be a rate from 0 to 1,000,000, or null.") as CostConfigPatch["roleRates"];
  if ("allocation" in input) patch.allocation = section("allocation", input.allocation, (k) => (LINE_KINDS as readonly string[]).includes(k), ALLOCATION, "must be null or role percentages from 0 to 300.") as CostConfigPatch["allocation"];
  if ("techFactors" in input) patch.techFactors = section("techFactors", input.techFactors, (k) => KNOWN_TECH.has(k), orNull(FACTOR), "must be a factor from 0.1 to 5, or null.");
  if ("fxRates" in input) patch.fxRates = section("fxRates", input.fxRates, (k) => /^[A-Z]{3}$/.test(k) && k !== "INR", orNull(numberIn(0.0001, 1_000_000, 4)), "must be a positive rate, or null.");
  if ("runningCosts" in input) {
    patch.runningCosts = section("runningCosts", input.runningCosts, (k) => (RECURRING_CATEGORIES as readonly string[]).includes(k), RUNNING_DEFAULT, "needs a kind, necessity, payer, status and a valid amount (a known recurring amount also needs a frequency), or null.") as CostConfigPatch["runningCosts"];
  }
  if ("aiPricing" in input) {
    const count = isObj(input.aiPricing) ? Object.keys(input.aiPricing).length : 0;
    if (count > MAX_AI_MODELS) problems.push(`aiPricing can hold at most ${MAX_AI_MODELS} models.`);
    else patch.aiPricing = section("aiPricing", input.aiPricing, (k) => /^[\w.:-]{1,80}$/.test(k), AI_PRICE, "needs inputPerMTok and outputPerMTok (USD per million tokens), or null.");
  }
  if ("uplifts" in input) {
    const raw = input.uplifts;
    if (!isObj(raw)) problems.push("uplifts must be an object.");
    else {
      const uplifts: NonNullable<CostConfigPatch["uplifts"]> = {};
      for (const key of Object.keys(raw)) if (key !== "scale" && key !== "security") problems.push(`uplifts.${key.slice(0, 40)} is not allowed.`);
      if ("scale" in raw) uplifts.scale = section("uplifts.scale", raw.scale, (k) => (SCALES as readonly string[]).includes(k), orNull(PERCENT), "must be a percent from 0 to 300, or null.") as typeof uplifts.scale;
      if ("security" in raw) uplifts.security = section("uplifts.security", raw.security, (k) => (SECURITY_LEVELS as readonly string[]).includes(k), orNull(PERCENT), "must be a percent from 0 to 300, or null.") as typeof uplifts.security;
      patch.uplifts = uplifts;
    }
  }
  const scalar = <K extends "usdToInr" | "minMarginPercent">(key: K, check: Check<number | null>, hint: string) => {
    if (!(key in input)) return;
    const r = check(input[key]);
    if (r.ok) patch[key] = r.value as never;
    else problems.push(`${key} ${hint}`);
  };
  scalar("usdToInr", orNull(numberIn(0.01, 10_000, 4)), "must be a positive exchange rate, or null.");
  scalar("minMarginPercent", orNull(numberIn(0, 100)), "must be a percent from 0 to 100, or null.");
  if ("infra" in input) {
    const r = INFRA(input.infra);
    if (r.ok) patch.infra = r.value;
    else problems.push(`infra must be null or a list of up to ${MAX_INFRA} items with a unique key, a name, a basis (per-project, per-dev-hour or per-week) and an amount or null.`);
  }
  return { patch, problems };
}

/** Problems with a submitted change; empty when it is valid. */
export const costConfigPatchProblems = (input: unknown): string[] => readCostPatch(input).problems;

/** Applies a change on top of a configuration. null removes a value; other saved values are kept. */
export function applyCostPatch(config: CostConfig, patch: CostConfigPatch): CostConfig {
  const next: CostConfig = {
    ...config,
    roleRates: { ...config.roleRates },
    allocation: { ...config.allocation },
    techFactors: { ...config.techFactors },
    uplifts: { scale: { ...config.uplifts.scale }, security: { ...config.uplifts.security } },
    fxRates: { ...config.fxRates },
    aiPricing: { ...config.aiPricing },
    runningCosts: { ...config.runningCosts },
  };
  for (const [role, v] of Object.entries(patch.roleRates ?? {})) next.roleRates[role as Role] = v ?? null;
  for (const [kind, v] of Object.entries(patch.allocation ?? {})) next.allocation[kind as LineKind] = v ?? null;
  const merge = <T,>(target: Record<string, T>, source: Record<string, T | null> | undefined) => {
    for (const [k, v] of Object.entries(source ?? {})) {
      if (v === null) delete target[k];
      else target[k] = v;
    }
  };
  merge(next.runningCosts as Record<string, RunningCostDefault>, patch.runningCosts as Record<string, RunningCostDefault | null> | undefined);
  merge(next.techFactors, patch.techFactors);
  merge(next.fxRates, patch.fxRates);
  merge(next.aiPricing, patch.aiPricing);
  merge(next.uplifts.scale as Record<string, number>, patch.uplifts?.scale as Record<string, number | null> | undefined);
  merge(next.uplifts.security as Record<string, number>, patch.uplifts?.security as Record<string, number | null> | undefined);
  if ("usdToInr" in patch) next.usdToInr = patch.usdToInr ?? null;
  if ("minMarginPercent" in patch) next.minMarginPercent = patch.minMarginPercent ?? null;
  if ("infra" in patch) next.infra = patch.infra ?? null;
  return next;
}

/** Reads a saved configuration. Unknown or invalid values are dropped, so old or damaged data never breaks anything. */
export function parseCostConfig(stored: unknown): CostConfig {
  return applyCostPatch(emptyCostConfig(), readCostPatch(stored).patch);
}

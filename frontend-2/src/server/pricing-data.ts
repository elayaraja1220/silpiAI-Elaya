import { getDb, transaction } from "@/lib/business/db";
import { minorDigits } from "@/lib/business/countries";
import { ANY_ROLE, BENCHMARK_KINDS, DEFAULT_PRICING_CONFIG, rateProblems, resolveRate, type BenchmarkKind, type Billing, type MarketRate, type PricingConfig, type Resolved } from "@/lib/business/market-rates";
import { quoteMoney } from "@/lib/business/pricing";
import type { Client, MarketSnapshot, RateCard, Requirement } from "@/lib/business/types";
import { ValidationError } from "@/lib/business/validate";
import { recordAuditIn } from "@/server/audit";

/**
 * Global pricing data: the reference lists, the market rates (every figure with its source) and the pricing settings. Server only.
 * Readers (the quotation screens) get a rate for a country, role and level; only an administrator can add one. A rate is never edited: a new row with a
 * later start date replaces it and the old row stays as history. Every change is written to the audit log in the same transaction.
 */
const bad = (m: string) => new ValidationError(m);
const today = () => new Date().toISOString().slice(0, 10);

// ---- reference lists -----------------------------------------------------------------------------------------------------------------
export type Reference = {
  countries: { code: string; name: string; currency: string; active: boolean }[];
  currencies: { code: string; name: string; symbol: string; minorDigits: number; active: boolean }[];
  roles: { id: string; label: string; active: boolean }[];
  levels: { id: string; label: string; active: boolean }[];
};
export function listReference(opts: { includeInactive?: boolean } = {}): Reference {
  const db = getDb();
  const where = opts.includeInactive ? "" : "WHERE active = 1";
  const rows = <T,>(sql: string) => db.prepare(sql).all() as T[];
  return {
    countries: rows<{ code: string; name: string; currency: string; active: number }>(`SELECT code, name, currency, active FROM pricing_countries ${where} ORDER BY sort_order, name`).map((r) => ({ ...r, active: r.active === 1 })),
    currencies: rows<{ code: string; name: string; symbol: string; minor_digits: number; active: number }>(`SELECT * FROM pricing_currencies ${where} ORDER BY code`).map((r) => ({ code: r.code, name: r.name, symbol: r.symbol, minorDigits: r.minor_digits, active: r.active === 1 })),
    roles: rows<{ id: string; label: string; active: number }>(`SELECT id, label, active FROM pricing_roles ${where} ORDER BY sort_order, label`).map((r) => ({ ...r, active: r.active === 1 })),
    levels: rows<{ id: string; label: string; active: number }>(`SELECT id, label, active FROM pricing_levels ${where} ORDER BY sort_order`).map((r) => ({ ...r, active: r.active === 1 })),
  };
}

const TABLES = { country: "pricing_countries", currency: "pricing_currencies", role: "pricing_roles", level: "pricing_levels" } as const;
const KEY = { country: "code", currency: "code", role: "id", level: "id" } as const;
/** Switches a country, currency, role or level on or off for new quotations. Nothing is deleted: rates already entered stay. */
export function setActive(kind: keyof typeof TABLES, id: string, active: boolean, by: string): void {
  if (kind === "role" && id === ANY_ROLE) throw bad('The "any role" entry is needed for fallbacks and cannot be switched off.');
  transaction((db) => {
    const r = db.prepare(`UPDATE ${TABLES[kind]} SET active = ? WHERE ${KEY[kind]} = ?`).run(active ? 1 : 0, id);
    if (r.changes === 0) throw bad(`That ${kind} does not exist.`);
    recordAuditIn(db, { actor: by, action: "pricing.reference_switched", entityType: kind, entityId: id, detail: { active } });
  });
}
export function addRole(input: { id: unknown; label: unknown }, by: string): void {
  const id = typeof input.id === "string" ? input.id.trim().toLowerCase() : "";
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) throw bad("The role id must be 2 to 41 lowercase letters, digits or dashes.");
  if (label.length < 2 || label.length > 60) throw bad("The role name must be 2 to 60 characters.");
  transaction((db) => {
    try { db.prepare("INSERT INTO pricing_roles (id, label, sort_order) VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM pricing_roles))").run(id, label); } catch (e) { if (/UNIQUE|PRIMARY/i.test((e as Error).message)) throw bad("There is already a role with that id."); throw e; }
    recordAuditIn(db, { actor: by, action: "pricing.role_added", entityType: "role", entityId: id, detail: { label } });
  });
}

// ---- settings ----------------------------------------------------------------------------------------------------------------------------
const bp = (v: unknown, what: string, max: number) => { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > max) throw bad(`${what} must be a whole number of basis points from 0 to ${max.toLocaleString("en-US")} (100 = 1%).`); return v; };
export function getPricingConfig(): PricingConfig {
  const row = getDb().prepare("SELECT value FROM pricing_configurations WHERE key = 'global'").get() as { value: string } | undefined;
  if (!row) return DEFAULT_PRICING_CONFIG;
  try { return normalise(JSON.parse(row.value) as Partial<PricingConfig>); } catch { return DEFAULT_PRICING_CONFIG; }
}
/** Merges a saved or typed config over the neutral defaults and checks every value; anything out of range is refused, never clamped. */
export function normalise(input: Partial<PricingConfig>): PricingConfig {
  const d = DEFAULT_PRICING_CONFIG;
  const kind = (v: unknown, what: string): BenchmarkKind => { if (!(BENCHMARK_KINDS as readonly unknown[]).includes(v)) throw bad(`${what} must be one of: ${BENCHMARK_KINDS.join(", ")}.`); return v as BenchmarkKind; };
  const billing = {} as Record<BenchmarkKind, Billing>;
  for (const k of BENCHMARK_KINDS) {
    const b = (input.billing?.[k] ?? d.billing[k]) as Billing;
    const multiplierBp = bp(b.multiplierBp, `The ${k} multiplier`, 100_000);
    if (multiplierBp < 1000) throw bad(`The ${k} multiplier cannot be below 0.10.`);
    billing[k] = { multiplierBp, overheadBp: bp(b.overheadBp, `The ${k} overhead`, 100_000), marginBp: bp(b.marginBp, `The ${k} margin`, 100_000) };
  }
  const days = input.staleAfterDays ?? d.staleAfterDays;
  const hours = input.hoursPerYear ?? d.hoursPerYear;
  if (!Number.isSafeInteger(days) || days < 30 || days > 3650) throw bad("The age at which a rate is out of date must be 30 to 3,650 days.");
  if (!Number.isSafeInteger(hours) || hours < 1000 || hours > 3000) throw bad("Paid hours in a year must be 1,000 to 3,000.");
  return { benchmark: { hourly: kind(input.benchmark?.hourly ?? d.benchmark.hourly, "The hourly benchmark"), fixed: kind(input.benchmark?.fixed ?? d.benchmark.fixed, "The fixed-price benchmark") }, billing, riskAllowanceBp: bp(input.riskAllowanceBp ?? d.riskAllowanceBp, "The risk allowance", 5000), staleAfterDays: days, hoursPerYear: hours };
}
export function savePricingConfig(input: Partial<PricingConfig>, by: string): PricingConfig {
  const next = normalise({ ...getPricingConfig(), ...input, benchmark: { ...getPricingConfig().benchmark, ...(input.benchmark ?? {}) }, billing: { ...getPricingConfig().billing, ...(input.billing ?? {}) } });
  transaction((db) => {
    const before = getPricingConfig();
    db.prepare("INSERT INTO pricing_configurations (key, value, updated_at, updated_by) VALUES ('global', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by").run(JSON.stringify(next), new Date().toISOString(), by);
    recordAuditIn(db, { actor: by, action: "pricing.config_changed", entityType: "pricing_configuration", entityId: "global", detail: { before, after: next } });
  });
  return next;
}

// ---- market rates -----------------------------------------------------------------------------------------------------------------------
type RateRow = { id: number; country: string; role_id: string; level_id: string; kind: BenchmarkKind; currency: string; min_minor: number; median_minor: number; max_minor: number; source: string; source_url: string; effective_date: string; entered_by: string; entered_at: string; enabled: number; illustrative: number; note: string };
const toRate = (r: RateRow): MarketRate => ({ id: r.id, country: r.country, roleId: r.role_id, levelId: r.level_id, kind: r.kind, currency: r.currency, minMinor: r.min_minor, medianMinor: r.median_minor, maxMinor: r.max_minor, source: r.source, sourceUrl: r.source_url, effectiveDate: r.effective_date, enteredBy: r.entered_by, enteredAt: r.entered_at, enabled: r.enabled === 1, illustrative: r.illustrative === 1, note: r.note });

/** Every row ever entered (newest first), optionally for one country: the history behind today's figure. */
export function listRates(opts: { country?: string; limit?: number } = {}): MarketRate[] {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
  const rows = opts.country
    ? (getDb().prepare("SELECT * FROM country_market_rates WHERE country = ? ORDER BY id DESC LIMIT ?").all(opts.country.toUpperCase(), limit) as RateRow[])
    : (getDb().prepare("SELECT * FROM country_market_rates ORDER BY id DESC LIMIT ?").all(limit) as RateRow[]);
  return rows.map(toRate);
}

export type RateInput = { country: unknown; roleId: unknown; levelId: unknown; kind: unknown; min: unknown; median: unknown; max: unknown; source: unknown; sourceUrl?: unknown; effectiveDate: unknown; note?: unknown };

/** Adds one figure. Amounts are whole numbers of the currency's smallest unit (for pounds, pence). The currency is the country's own. */
export function addRate(input: RateInput, by: string): MarketRate {
  return transaction((db) => insertRate(db, input, by));
}
function insertRate(db: ReturnType<typeof getDb>, input: RateInput, by: string): MarketRate {
  const country = typeof input.country === "string" ? input.country.trim().toUpperCase() : "";
  const roleId = typeof input.roleId === "string" ? input.roleId.trim() : "";
  const levelId = typeof input.levelId === "string" ? input.levelId.trim() : "";
  const c = db.prepare("SELECT currency, active FROM pricing_countries WHERE code = ?").get(country) as { currency: string; active: number } | undefined;
  if (!c) throw bad("That country is not in the list.");
  if (!db.prepare("SELECT 1 FROM pricing_roles WHERE id = ?").get(roleId)) throw bad("That role is not in the list.");
  if (!db.prepare("SELECT 1 FROM pricing_levels WHERE id = ?").get(levelId)) throw bad("That level is not in the list.");
  if (!(BENCHMARK_KINDS as readonly unknown[]).includes(input.kind)) throw bad(`The kind of benchmark must be one of: ${BENCHMARK_KINDS.join(", ")}.`);
  const problems = rateProblems({ min: input.min, median: input.median, max: input.max, source: input.source, effectiveDate: input.effectiveDate }, today());
  if (problems.length) throw bad(problems.join(" "));
  const at = new Date().toISOString();
  const info = db.prepare(
    "INSERT INTO country_market_rates (country, role_id, level_id, kind, currency, min_minor, median_minor, max_minor, source, source_url, effective_date, entered_by, entered_at, enabled, illustrative, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)",
  ).run(country, roleId, levelId, input.kind as string, c.currency, input.min as number, input.median as number, input.max as number, String(input.source).trim(), typeof input.sourceUrl === "string" ? input.sourceUrl.trim().slice(0, 300) : "", input.effectiveDate as string, by.slice(0, 80), at, typeof input.note === "string" ? input.note.trim().slice(0, 300) : "");
  const row = toRate(db.prepare("SELECT * FROM country_market_rates WHERE id = ?").get(Number(info.lastInsertRowid)) as RateRow);
  recordAuditIn(db, { actor: by, action: "pricing.rate_added", entityType: "market_rate", entityId: row.id, detail: { country, roleId, levelId, kind: row.kind, currency: row.currency, median: row.medianMinor, source: row.source, effectiveDate: row.effectiveDate } });
  return row;
}

/** Switches one benchmark row on or off (an off row is ignored when pricing). Its figures cannot be changed. */
export function setRateEnabled(id: number, enabled: boolean, by: string): void {
  transaction((db) => {
    const r = db.prepare("UPDATE country_market_rates SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    if (r.changes === 0) throw bad("That rate does not exist.");
    recordAuditIn(db, { actor: by, action: "pricing.rate_switched", entityType: "market_rate", entityId: id, detail: { enabled } });
  });
}

/** "45.5" in pounds is 4550 pence: exact, from the text, in the currency's own number of decimals. */
export function toMinor(text: string, digits: number): number | null {
  const m = new RegExp(`^(\\d{1,9})(?:\\.(\\d{1,${Math.max(digits, 1)}}))?$`).exec(text.trim());
  if (!m || (digits === 0 && m[2] !== undefined)) return null;
  return Number(m[1]) * 10 ** digits + Number((m[2] ?? "").padEnd(digits, "0") || 0);
}

/**
 * Loads many rows from CSV, all or none. Header: country,role,level,kind,min,median,max,source,source_url,effective_date. Amounts are in the main unit of the
 * country's currency (45.50 pounds), not pence. Returns every problem with its line number instead of stopping at the first.
 */
export function importRates(csv: string, by: string): { added: number } {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw bad("The CSV needs a header line and at least one row.");
  const head = splitCsv(lines[0]!).map((h) => h.toLowerCase());
  const need = ["country", "role", "level", "kind", "min", "median", "max", "source", "effective_date"];
  const missing = need.filter((n) => !head.includes(n));
  if (missing.length) throw bad(`The header is missing: ${missing.join(", ")}.`);
  const col = (cells: string[], n: string) => cells[head.indexOf(n)] ?? "";
  const problems: string[] = [];
  const inputs: RateInput[] = [];
  const db = getDb();
  lines.slice(1).forEach((line, i) => {
    const n = i + 2;
    const cells = splitCsv(line);
    const country = col(cells, "country").toUpperCase();
    const c = db.prepare("SELECT currency FROM pricing_countries WHERE code = ?").get(country) as { currency: string } | undefined;
    if (!c) { problems.push(`Line ${n}: unknown country "${country}".`); return; }
    const digits = minorDigits(c.currency);
    const [min, median, max] = ["min", "median", "max"].map((k) => toMinor(col(cells, k), digits));
    if (min === null || median === null || max === null) { problems.push(`Line ${n}: the amounts must be plain numbers with at most ${digits} decimals.`); return; }
    inputs.push({ country, roleId: col(cells, "role"), levelId: col(cells, "level"), kind: col(cells, "kind").toLowerCase(), min, median, max, source: col(cells, "source"), sourceUrl: col(cells, "source_url"), effectiveDate: col(cells, "effective_date") });
  });
  if (inputs.length > 2000) throw bad("Load at most 2,000 rows at a time.");
  if (problems.length) throw bad(problems.slice(0, 20).join(" "));
  return transaction((tx) => {
    inputs.forEach((input, i) => {
      try { insertRate(tx, input, by); } catch (e) { throw bad(`Line ${i + 2}: ${(e as Error).message}`); }
    });
    recordAuditIn(tx, { actor: by, action: "pricing.rates_imported", entityType: "market_rate", entityId: "csv", detail: { rows: inputs.length } });
    return { added: inputs.length };
  });
}
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** The rate for one quotation: the benchmark the administrator chose for the mode, with the settings applied. */
export function rateFor(query: { country: string | null | undefined; roleId: string; levelId: string; mode: "hourly" | "fixed" }, now = today()): Resolved {
  const config = getPricingConfig();
  const all = (getDb().prepare("SELECT * FROM country_market_rates WHERE enabled = 1").all() as RateRow[]).map(toRate);
  return resolveRate(all, { country: query.country, roleId: query.roleId, levelId: query.levelId, kind: config.benchmark[query.mode] }, config, now);
}

/**
 * Writes the official market figure into an hourly engagement. The browser only says WHICH country, role and level; the figure, its source and its date are
 * looked up here, so nobody can type a different "market rate" into a quotation. If the team typed a price that differs from the benchmark on purpose, that is
 * kept and recorded as an override; if they left the benchmark price, it is set exactly. With no verified rate for the country, role and level the engagement is
 * left as typed (a price entered by hand). A rate in a currency the quotation cannot be written in is refused rather than converted by guesswork.
 */
export function enrichHourly(req: Requirement, client: Pick<Client, "state" | "currency" | "country">, rates: RateCard): Requirement {
  const h = req.hourly;
  if (!h || !h.roleId || !h.levelId) return req;
  const country = h.country ?? client.country;
  if (!country) return req;
  const r = rateFor({ country, roleId: h.roleId, levelId: h.levelId, mode: "hourly" });
  if (!r.ok) return { ...req, hourly: { ...h, country, market: undefined, override: undefined } };
  const money = quoteMoney(client, rates, "hourly");
  if (money.code !== r.currency) {
    throw bad(`The market rate for ${country} is in ${r.currency}, but this quotation would be written in ${money.code}. ${r.currency === "INR" ? "Choose India as the client's country." : `Add ${r.currency} under "Prices for clients abroad" in Business & pricing (an hourly engagement only needs the rupee value of one ${r.currency}), and choose it for this client.`}`);
  }
  const digits = minorDigits(r.currency);
  const billed = r.billedMinor / 10 ** digits;
  const typed = money.code === "INR" ? h.rate : h.rateNative ?? 0;
  const override = money.code === "INR" ? Math.abs(typed - billed) >= 0.5 : Math.abs(typed - billed) >= 0.005;
  const snapshot: MarketSnapshot = { rateId: r.rateId, kind: r.kind, currency: r.currency, minMinor: r.minMinor, medianMinor: r.medianMinor, maxMinor: r.maxMinor, billedMinor: r.billedMinor, source: r.source, effectiveDate: r.effectiveDate, illustrative: r.illustrative, stale: r.stale, billsAtCost: r.billsAtCost };
  const priced = override ? {} : money.code === "INR" ? { rate: billed } : { rateNative: billed, rate: Math.max(1, Math.round(billed * money.unit)) };
  return { ...req, hourly: { ...h, ...priced, country, market: snapshot, override: override || undefined } };
}

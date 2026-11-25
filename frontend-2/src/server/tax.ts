import type { DatabaseSync } from "node:sqlite";

import { getDb } from "@/lib/business/db";
import { ValidationError } from "@/lib/business/validate";
import { isCurrency } from "@/lib/currencies";

/**
 * Tax on what customers buy (plans and credit packs), and who the invoice is made out to.
 *
 * Which tax applies, in order: (1) the customer's billing country has an ACTIVE rule that matches the invoice currency (or any currency) -> that rule;
 * (2) otherwise a rupee invoice to an Indian or unknown billing country -> GST at the rate in settings (as before); (3) otherwise no tax.
 * No tax rate is built in apart from that existing GST: every other rate is a row the administrator adds after checking it with an accountant.
 * Not handled: reverse charge, tax-exempt customers, tax by state or region, and checking a tax number with any tax authority. A tax number is
 * recorded and printed on the invoice, never verified. The rate in force when an invoice is raised is written on it and never changes afterwards.
 */
const bad = (m: string) => new ValidationError(m);

// ---- GST (moved here from subscriptions so every tax decision lives in one place) -------------------------------------------
/** The GST rate on SaaS invoices, in basis points (1800 = 18%). Its own setting: the agency's quotation rate is separate books. */
export function gstBasisPoints(db: DatabaseSync = getDb()): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'saas_gst_basis_points'").get() as { value: string } | undefined;
  const n = row ? Number(row.value) : 1800;
  return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : 1800;
}

// ---- rules -------------------------------------------------------------------------------------------------------------------
export type TaxRule = { id: number; country: string; currency: string | null; label: string; rateBasisPoints: number; active: boolean; note: string; updatedAt: string };
type RuleRow = { id: number; country: string; currency: string | null; label: string; rate_basis_points: number; active: number; note: string; updated_at: string };
const toRule = (r: RuleRow): TaxRule => ({ id: r.id, country: r.country, currency: r.currency, label: r.label, rateBasisPoints: r.rate_basis_points, active: r.active === 1, note: r.note, updatedAt: r.updated_at });
export const listTaxRules = (db: DatabaseSync = getDb()): TaxRule[] => (db.prepare("SELECT * FROM tax_rules ORDER BY country, COALESCE(currency, '')").all() as RuleRow[]).map(toRule);

export function saveTaxRule(input: { country: unknown; currency?: unknown; label: unknown; rateBasisPoints: unknown; active?: unknown; note?: unknown }): TaxRule {
  const country = typeof input.country === "string" ? input.country.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(country)) throw bad("country must be a two-letter country code, for example GB.");
  const currency = input.currency === undefined || input.currency === null || input.currency === "" ? null : String(input.currency);
  if (currency !== null && !isCurrency(currency)) throw bad("currency must be a supported currency, or left empty for every currency.");
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (label.length < 2 || label.length > 30) throw bad("The tax name (VAT, GST, Sales tax...) must be 2 to 30 characters.");
  const bp = input.rateBasisPoints;
  if (typeof bp !== "number" || !Number.isSafeInteger(bp) || bp < 0 || bp > 10_000) throw bad("The rate must be a whole number of basis points from 0 to 10000 (2000 = 20%).");
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 300) : "";
  const at = new Date().toISOString();
  const db = getDb();
  db.prepare(
    `INSERT INTO tax_rules (country, currency, label, rate_basis_points, active, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(country, COALESCE(currency, '')) DO UPDATE SET label = excluded.label, rate_basis_points = excluded.rate_basis_points, active = excluded.active, note = excluded.note, updated_at = excluded.updated_at`,
  ).run(country, currency, label, bp, input.active === false ? 0 : 1, note, at, at);
  return toRule(db.prepare("SELECT * FROM tax_rules WHERE country = ? AND COALESCE(currency, '') = COALESCE(?, '')").get(country, currency) as RuleRow);
}

// ---- billing profile -----------------------------------------------------------------------------------------------------------
export type BillingProfile = { orgId: string; legalName: string; country: string; addressLine1: string; addressLine2: string; city: string; region: string; postalCode: string; taxId: string; taxIdType: string; updatedAt: string };
type ProfileRow = { org_id: string; legal_name: string; country: string; address_line1: string; address_line2: string; city: string; region: string; postal_code: string; tax_id: string; tax_id_type: string; updated_at: string };
const toProfile = (r: ProfileRow): BillingProfile => ({ orgId: r.org_id, legalName: r.legal_name, country: r.country, addressLine1: r.address_line1, addressLine2: r.address_line2, city: r.city, region: r.region, postalCode: r.postal_code, taxId: r.tax_id, taxIdType: r.tax_id_type, updatedAt: r.updated_at });
export const getBillingProfile = (orgId: string, db: DatabaseSync = getDb()): BillingProfile | null => {
  const r = db.prepare("SELECT * FROM billing_profiles WHERE org_id = ?").get(orgId) as ProfileRow | undefined;
  return r ? toProfile(r) : null;
};

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const text = (v: unknown, what: string, min: number, max: number): string => {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length < min || s.length > max) throw bad(`${what} must be ${min === 0 ? `up to ${max}` : `${min} to ${max}`} characters.`);
  return s;
};
/** Saves who invoices are made out to. Only the format of a tax number is checked (a GSTIN has a fixed shape), never whether it exists. */
export function saveBillingProfile(orgId: string, input: Record<string, unknown>, by = ""): BillingProfile {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM organizations WHERE id = ?").get(orgId)) throw bad("That organization does not exist.");
  const country = typeof input.country === "string" ? input.country.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(country)) throw bad("Choose the country as a two-letter code, for example IN or GB.");
  let taxId = typeof input.taxId === "string" ? input.taxId.trim().toUpperCase() : "";
  let taxIdType = typeof input.taxIdType === "string" ? input.taxIdType.trim().toUpperCase().slice(0, 20) : "";
  if (taxId) {
    if (!/^[A-Z0-9][A-Z0-9 .\-/]{2,29}$/.test(taxId)) throw bad("The tax number may use letters, digits, spaces, dots, dashes and slashes (3 to 30 characters).");
    if (country === "IN" && (taxIdType === "" || taxIdType === "GSTIN") && !GSTIN.test(taxId)) throw bad("An Indian GSTIN has 15 characters, like 22AAAAA0000A1Z5. Check it, or leave it empty.");
    if (country === "IN" && taxIdType === "") taxIdType = "GSTIN";
  } else { taxId = ""; taxIdType = ""; }
  const p = {
    legal_name: text(input.legalName, "The legal name", 2, 120), address_line1: text(input.addressLine1, "The address", 2, 120), address_line2: text(input.addressLine2 ?? "", "The second address line", 0, 120),
    city: text(input.city, "The city", 1, 80), region: text(input.region ?? "", "The state or region", 0, 80), postal_code: text(input.postalCode ?? "", "The postal code", 0, 20),
  };
  db.prepare(
    `INSERT INTO billing_profiles (org_id, legal_name, country, address_line1, address_line2, city, region, postal_code, tax_id, tax_id_type, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id) DO UPDATE SET legal_name = excluded.legal_name, country = excluded.country, address_line1 = excluded.address_line1, address_line2 = excluded.address_line2, city = excluded.city, region = excluded.region,
       postal_code = excluded.postal_code, tax_id = excluded.tax_id, tax_id_type = excluded.tax_id_type, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(orgId, p.legal_name, country, p.address_line1, p.address_line2, p.city, p.region, p.postal_code, taxId, taxIdType, new Date().toISOString(), by.slice(0, 80));
  return getBillingProfile(orgId)!;
}

// ---- the decision ----------------------------------------------------------------------------------------------------------------
export type TaxDecision = { basisPoints: number; label: string; taxMinor: number };
/** What tax to add to `taxableMinor`, and what to call it. Tax is rounded to the nearest smallest unit. */
export function taxFor(db: DatabaseSync, orgId: string, currency: string, taxableMinor: number): TaxDecision {
  const country = getBillingProfile(orgId, db)?.country ?? null;
  let basisPoints = 0;
  let label = "";
  const rule = country ? (db.prepare("SELECT label, rate_basis_points FROM tax_rules WHERE country = ? AND active = 1 AND (currency = ? OR currency IS NULL) ORDER BY currency IS NULL LIMIT 1").get(country, currency) as { label: string; rate_basis_points: number } | undefined) : undefined;
  if (rule) { basisPoints = rule.rate_basis_points; label = rule.label; }
  else if (currency === "INR" && (country === null || country === "IN")) { basisPoints = gstBasisPoints(db); label = basisPoints > 0 ? "GST" : ""; }
  return { basisPoints, label: basisPoints > 0 ? label : "", taxMinor: Math.round((taxableMinor * basisPoints) / 10_000) };
}

/** Who the invoice is made out to, written on the invoice when it is raised so later edits to the profile never rewrite an old invoice. Null if there is no profile. */
export function billToSnapshot(db: DatabaseSync, orgId: string): string | null {
  const p = getBillingProfile(orgId, db);
  if (!p) return null;
  const { orgId: _o, updatedAt: _u, ...rest } = p;
  void _o; void _u;
  return JSON.stringify(rest);
}

// ---- the seller (us) -------------------------------------------------------------------------------------------------------------
export type Seller = { legalName: string; address: string; country: string; taxId: string; taxIdType: string; email: string };
const SELLER_KEYS = { legalName: "seller_legal_name", address: "seller_address", country: "seller_country", taxId: "seller_tax_id", taxIdType: "seller_tax_id_type", email: "seller_email" } as const;
export function getSeller(db: DatabaseSync = getDb()): Seller {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'seller_%'").all() as { key: string; value: string }[];
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const g = (k: keyof typeof SELLER_KEYS) => m.get(SELLER_KEYS[k]) ?? "";
  return { legalName: g("legalName"), address: g("address"), country: g("country"), taxId: g("taxId"), taxIdType: g("taxIdType"), email: g("email") };
}
export function saveSeller(input: Partial<Seller>): Seller {
  const db = getDb();
  const next = { ...getSeller(db), ...input };
  const clean: Seller = {
    legalName: text(next.legalName, "The legal name", 0, 120), address: text(next.address, "The address", 0, 300), country: text(next.country, "The country", 0, 2).toUpperCase(),
    taxId: text(next.taxId, "The tax number", 0, 30).toUpperCase(), taxIdType: text(next.taxIdType, "The tax number type", 0, 20).toUpperCase(), email: text(next.email, "The email", 0, 120),
  };
  if (clean.country && !/^[A-Z]{2}$/.test(clean.country)) throw bad("The country must be a two-letter code.");
  if (clean.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) throw bad("That email address does not look right.");
  for (const k of Object.keys(SELLER_KEYS) as (keyof typeof SELLER_KEYS)[]) db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SELLER_KEYS[k], clean[k]);
  return clean;
}

// ---- the printable document ----------------------------------------------------------------------------------------------------
export type TaxDocument = {
  kind: "invoice" | "topup";
  number: string; status: string; currency: string; issuedAt: string; paidAt: string | null;
  seller: Seller; billTo: Omit<BillingProfile, "orgId" | "updatedAt"> | null;
  lines: { description: string; amountMinor: number }[];
  discountMinor: number; couponCode: string | null; subtotalMinor: number; taxLabel: string; taxBasisPoints: number; taxMinor: number; totalMinor: number;
};
const parseBillTo = (s: string | null) => (s ? (JSON.parse(s) as TaxDocument["billTo"]) : null);

/** The invoice or top-up order as a document. Only for the organization that owns it (the caller passes the organization from the session). Null when it is not theirs. */
export function taxDocument(orgId: string, kind: "invoice" | "topup", id: string, db: DatabaseSync = getDb()): TaxDocument | null {
  if (kind === "invoice") {
    const i = db.prepare("SELECT i.*, p.name AS plan_name FROM subscription_invoices i JOIN plans p ON p.id = i.plan_id WHERE i.id = ? AND i.org_id = ?").get(id, orgId) as
      | { number: string; status: string; currency: string; issued_at: string; paid_at: string | null; plan_name: string; period_start: string; period_end: string; subtotal_paise: number; discount_minor: number; coupon_code: string | null; gst_basis_points: number; gst_paise: number; total_paise: number; tax_label: string; bill_to: string | null }
      | undefined;
    if (!i) return null;
    return { kind, number: i.number, status: i.status, currency: i.currency, issuedAt: i.issued_at, paidAt: i.paid_at, seller: getSeller(db), billTo: parseBillTo(i.bill_to),
      lines: [{ description: `${i.plan_name} plan, ${i.period_start.slice(0, 10)} to ${i.period_end.slice(0, 10)}`, amountMinor: i.subtotal_paise + i.discount_minor }],
      discountMinor: i.discount_minor, couponCode: i.coupon_code, subtotalMinor: i.subtotal_paise, taxLabel: i.tax_label, taxBasisPoints: i.gst_basis_points, taxMinor: i.gst_paise, totalMinor: i.total_paise };
  }
  const t = db.prepare("SELECT t.*, c.name AS pack_name FROM topups t JOIN credit_packages c ON c.id = t.package_id WHERE t.id = ? AND t.org_id = ?").get(id, orgId) as
    | { number: string; status: string; currency: string; created_at: string; paid_at: string | null; pack_name: string; subtotal_minor: number; gst_basis_points: number; gst_minor: number; total_minor: number; tax_label: string; bill_to: string | null }
    | undefined;
  if (!t) return null;
  return { kind, number: t.number, status: t.status, currency: t.currency, issuedAt: t.created_at, paidAt: t.paid_at, seller: getSeller(db), billTo: parseBillTo(t.bill_to),
    lines: [{ description: `Credit pack: ${t.pack_name}`, amountMinor: t.subtotal_minor }], discountMinor: 0, couponCode: null, subtotalMinor: t.subtotal_minor, taxLabel: t.tax_label, taxBasisPoints: t.gst_basis_points, taxMinor: t.gst_minor, totalMinor: t.total_minor };
}

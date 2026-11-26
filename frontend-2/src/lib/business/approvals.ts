// Quotation versions and approval records. Server side only (it hashes with node:crypto).
//
// Every quotation ever issued for a lead is a numbered VERSION, kept with a fingerprint (SHA-256) of exactly what was written. When a quotation is APPROVED, by the client on the
// link or by the team, the terms that were agreed (rate, hours, cap, tax, scope, price, where the rate came from) are frozen in an approval record together with that
// fingerprint. Both tables are append-only, and the database refuses to change or delete a quotation that has been approved. A changed price after approval therefore has to be a
// NEW version, which must be approved again. Nothing here changes a price: it only records and checks what was agreed.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Quotation } from "./types";

export type ApprovalChannel = "client-link" | "team" | "before-records";

/** What was agreed, copied as it stood. Amounts are in rupees, as everywhere; `currency`/`inrPerUnit` say how the client saw them. */
export type FrozenTerms = {
  mode: "fixed" | "hourly";
  currency: string;
  inrPerUnit: number;
  grandTotal: number;
  subtotal: number;
  discount: number;
  tax: { mode: string; rate: number; total: number };
  totalHours: number;
  /** The hourly price used (fixed price: the price of one development hour; hourly: the agreed rate). */
  hourlyRate: number | null;
  hourly?: { role: string; rate: number; minHours: number; expectedHours: number; capHours: number; minTotal: number; expectedTotal: number; capTotal: number; cycle: string };
  scope: { tier: string | null; pages: string[]; modules: string[]; deferredModules: string[] };
  market: { source: string; effectiveDate: string; kind: string; currency: string; riskBp: number; illustrative: boolean } | null;
  validUntil: string;
};

export type VersionRow = { id: number; leadId: string; quotationId: string; number: string; versionNo: number; reason: string; digest: string; mode: "fixed" | "hourly"; currency: string; grandTotal: number; createdAt: string };
export type ApprovalRow = { id: number; leadId: string; quotationId: string; number: string; versionNo: number; approvedBy: string; channel: ApprovalChannel; note: string; terms: FrozenTerms; digest: string; approvedAt: string };

/** The fingerprint of a quotation: the exact JSON that is stored. */
export const digestOf = (data: string): string => createHash("sha256").update(data).digest("hex");

export function termsOf(q: Quotation): FrozenTerms {
  const dev = q.items.find((i) => i.unit === "hour");
  const basis = q.marketBasis ?? q.requirement?.hourly?.market;
  return {
    mode: q.hourly ? "hourly" : "fixed",
    currency: q.currency ?? "INR",
    inrPerUnit: q.inrPerUnit ?? 1,
    grandTotal: q.grandTotal,
    subtotal: q.subtotal,
    discount: q.discount,
    tax: { mode: q.gst.mode, rate: q.gst.rate, total: q.gst.total },
    totalHours: q.totalHours,
    hourlyRate: q.hourly ? q.hourly.rate : dev ? dev.rate : null,
    ...(q.hourly ? { hourly: { role: q.hourly.role, rate: q.hourly.rate, minHours: q.hourly.minHours, expectedHours: q.hourly.expectedHours, capHours: q.hourly.capHours, minTotal: q.hourly.minTotal, expectedTotal: q.hourly.expectedTotal, capTotal: q.hourly.capTotal, cycle: q.hourly.cycle } } : {}),
    scope: { tier: q.tier ?? null, pages: [...(q.requirement?.pages ?? [])], modules: [...(q.requirement?.modules ?? [])], deferredModules: [...(q.deferred?.modules ?? [])] },
    market: q.marketBasis
      ? { source: q.marketBasis.source, effectiveDate: q.marketBasis.effectiveDate, kind: q.marketBasis.kind, currency: q.marketBasis.currency, riskBp: q.marketBasis.riskBp, illustrative: q.marketBasis.illustrative }
      : q.requirement?.hourly?.market
        ? { source: q.requirement?.hourly.market.source, effectiveDate: q.requirement?.hourly.market.effectiveDate, kind: q.requirement?.hourly.market.kind, currency: q.requirement?.hourly.market.currency, riskBp: 0, illustrative: q.requirement?.hourly.market.illustrative }
        : null,
    validUntil: q.validUntil,
  };
}

/** Writes the next version for the lead. `data` is the exact JSON being stored as the quotation. */
export function recordVersion(db: DatabaseSync, q: Quotation, data: string, reason: string): number {
  const n = (db.prepare("SELECT COUNT(*) AS n FROM quotation_versions WHERE lead_id = ?").get(q.leadId) as { n: number }).n + 1;
  db.prepare(
    "INSERT INTO quotation_versions (lead_id, quotation_id, number, version_no, reason, digest, mode, currency, grand_total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(q.leadId, q.id, q.number, n, reason || (n === 1 ? "first quotation" : "re-issued"), digestOf(data), q.hourly ? "hourly" : "fixed", q.currency ?? "INR", q.grandTotal, q.createdAt);
  return n;
}

/** Freezes what was agreed. `data` is the stored JSON of the quotation being approved. */
export function recordApproval(db: DatabaseSync, q: Quotation, data: string, by: string, channel: ApprovalChannel, note = "", at = new Date().toISOString()): ApprovalRow {
  const v = db.prepare("SELECT version_no AS n FROM quotation_versions WHERE quotation_id = ?").get(q.id) as { n: number } | undefined;
  const terms = termsOf(q);
  const digest = digestOf(data);
  const info = db
    .prepare("INSERT INTO quotation_approvals (lead_id, quotation_id, number, version_no, approved_by, channel, note, terms, digest, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(q.leadId, q.id, q.number, v?.n ?? 0, by.slice(0, 200), channel, note.slice(0, 500), JSON.stringify(terms), digest, at);
  return { id: Number(info.lastInsertRowid), leadId: q.leadId, quotationId: q.id, number: q.number, versionNo: v?.n ?? 0, approvedBy: by, channel, note, terms, digest, approvedAt: at };
}

type Raw = { id: number; lead_id: string; quotation_id: string; number: string; version_no: number; approved_by: string; channel: ApprovalChannel; note: string; terms: string; digest: string; approved_at: string };
const approval = (r: Raw): ApprovalRow => ({ id: r.id, leadId: r.lead_id, quotationId: r.quotation_id, number: r.number, versionNo: r.version_no, approvedBy: r.approved_by, channel: r.channel, note: r.note, terms: JSON.parse(r.terms) as FrozenTerms, digest: r.digest, approvedAt: r.approved_at });

export function listApprovals(db: DatabaseSync, leadId: string): ApprovalRow[] {
  return (db.prepare("SELECT * FROM quotation_approvals WHERE lead_id = ? ORDER BY id").all(leadId) as Raw[]).map(approval);
}

export function listVersions(db: DatabaseSync, leadId: string): VersionRow[] {
  type V = { id: number; lead_id: string; quotation_id: string; number: string; version_no: number; reason: string; digest: string; mode: "fixed" | "hourly"; currency: string; grand_total: number; created_at: string };
  return (db.prepare("SELECT * FROM quotation_versions WHERE lead_id = ? ORDER BY version_no").all(leadId) as V[]).map((v) => ({ id: v.id, leadId: v.lead_id, quotationId: v.quotation_id, number: v.number, versionNo: v.version_no, reason: v.reason, digest: v.digest, mode: v.mode, currency: v.currency, grandTotal: v.grand_total, createdAt: v.created_at }));
}

/** True when the stored quotation is still exactly what was approved. */
export function verifyApproval(db: DatabaseSync, a: Pick<ApprovalRow, "quotationId" | "digest">): { ok: true } | { ok: false; reason: string } {
  const row = db.prepare("SELECT data FROM quotations WHERE id = ?").get(a.quotationId) as { data: string } | undefined;
  if (!row) return { ok: false, reason: "The approved quotation is missing." };
  return digestOf(row.data) === a.digest ? { ok: true } : { ok: false, reason: "The stored quotation no longer matches what was approved." };
}

/** What a later version changed against the approved one: the figures an approval protects. Empty when nothing that was agreed has moved. */
export function termChanges(agreed: FrozenTerms, now: FrozenTerms): string[] {
  const out: string[] = [];
  const cmp = (label: string, a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) out.push(label); };
  cmp("price", agreed.grandTotal, now.grandTotal);
  cmp("hourly price", agreed.hourlyRate, now.hourlyRate);
  cmp("hours", agreed.totalHours, now.totalHours);
  cmp("spending cap and hour range", agreed.hourly, now.hourly);
  cmp("tax", agreed.tax, now.tax);
  cmp("scope", agreed.scope, now.scope);
  cmp("currency", [agreed.currency, agreed.inrPerUnit], [now.currency, now.inrPerUnit]);
  cmp("market rate used", agreed.market, now.market);
  return out;
}

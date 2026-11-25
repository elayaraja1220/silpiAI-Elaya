import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { transaction, getDb } from "@/lib/business/db";

/**
 * The credit engine (server only). The only code that changes a wallet.
 *
 * Units: whole numbers. 1 credit = UNITS_PER_CREDIT units, so a cost smaller than a credit is still exact.
 * balance = credits owned, reserved = the part held for running work, available = balance - reserved.
 *
 * Rules, all enforced here AND by CHECK constraints and triggers in the database:
 *  - every change is one append-only row in credit_ledger (the database refuses to edit or delete it);
 *  - available credits can never go below zero: a reservation that does not fit is refused;
 *  - every operation runs in one locked transaction, so two requests (or two processes) cannot both spend the same credits;
 *  - every operation that changes a wallet carries an idempotency key: repeating it returns the first result and changes
 *    nothing; reusing the key for a DIFFERENT request is an error.
 *
 * Conversion from AI provider cost or tokens into credits is NOT here: it is configuration for the AI Gateway (next phase).
 */

export const UNITS_PER_CREDIT = 1000;
export const creditsToUnits = (credits: number): number => Math.round(credits * UNITS_PER_CREDIT);
export const unitsToCredits = (units: number): number => units / UNITS_PER_CREDIT;

export type CreditErrorCode = "invalid" | "insufficient" | "not-found" | "over-reservation" | "closed" | "idempotency-conflict";
export class CreditError extends Error {
  code: CreditErrorCode;
  constructor(code: CreditErrorCode, message: string) {
    super(message);
    this.name = "CreditError";
    this.code = code;
  }
}

export type Wallet = { orgId: string; balanceUnits: number; reservedUnits: number; availableUnits: number };
export type LedgerKind = "grant" | "purchase" | "refund" | "adjust" | "reserve" | "extend" | "release" | "settle";
export type LedgerEntry = { id: number; orgId: string; kind: LedgerKind; deltaUnits: number; reservedDelta: number; balanceAfter: number; reservedAfter: number; reservationId: string | null; idempotencyKey: string | null; reference: string; note: string; createdBy: string; createdAt: string };
export type Reservation = { id: string; orgId: string; units: number; status: "active" | "settled" | "released"; purpose: string; actualUnits: number | null; createdAt: string; closedAt: string | null };

const now = () => new Date().toISOString();
const isUnits = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);
const positive = (n: unknown, what: string): number => {
  if (!isUnits(n) || n <= 0) throw new CreditError("invalid", `${what} must be a whole number of units greater than zero.`);
  return n;
};
const nonNegative = (n: unknown, what: string): number => {
  if (!isUnits(n) || n < 0) throw new CreditError("invalid", `${what} must be a whole number of units, zero or more.`);
  return n;
};
const key = (k: unknown): string => {
  if (typeof k !== "string" || k.trim().length < 6 || k.length > 200) throw new CreditError("invalid", "An idempotency key of 6 to 200 characters is required.");
  return k.trim();
};

type WalletRow = { balance_units: number; reserved_units: number };
type LedgerRow = { id: number; org_id: string; kind: LedgerKind; delta_units: number; reserved_delta: number; balance_after: number; reserved_after: number; reservation_id: string | null; idempotency_key: string | null; reference: string; note: string; created_by: string; created_at: string };
type ReservationRow = { id: string; org_id: string; units: number; status: Reservation["status"]; purpose: string; actual_units: number | null; created_at: string; closed_at: string | null };

const toEntry = (r: LedgerRow): LedgerEntry => ({ id: r.id, orgId: r.org_id, kind: r.kind, deltaUnits: r.delta_units, reservedDelta: r.reserved_delta, balanceAfter: r.balance_after, reservedAfter: r.reserved_after, reservationId: r.reservation_id, idempotencyKey: r.idempotency_key, reference: r.reference, note: r.note, createdBy: r.created_by, createdAt: r.created_at });
const toReservation = (r: ReservationRow): Reservation => ({ id: r.id, orgId: r.org_id, units: r.units, status: r.status, purpose: r.purpose, actualUnits: r.actual_units, createdAt: r.created_at, closedAt: r.closed_at });

function walletOf(db: DatabaseSync, orgId: string): WalletRow {
  const org = db.prepare("SELECT 1 FROM organizations WHERE id = ?").get(orgId);
  if (!org) throw new CreditError("not-found", "That organization does not exist.");
  db.prepare("INSERT OR IGNORE INTO credit_wallets (org_id, balance_units, reserved_units, updated_at) VALUES (?, 0, 0, ?)").run(orgId, now());
  return db.prepare("SELECT balance_units, reserved_units FROM credit_wallets WHERE org_id = ?").get(orgId) as WalletRow;
}

type Change = { kind: LedgerKind; delta: number; reservedDelta: number; reservationId?: string | null; key?: string | null; reference?: string; note?: string; by?: string };

/** The ONE place a wallet and its ledger are written, always together, always inside a transaction the caller opened. */
function apply(db: DatabaseSync, orgId: string, c: Change): LedgerEntry {
  const w = walletOf(db, orgId);
  const balance = w.balance_units + c.delta;
  const reserved = w.reserved_units + c.reservedDelta;
  if (balance < 0 || reserved < 0 || reserved > balance) throw new CreditError("insufficient", "Not enough available credits.");
  const at = now();
  db.prepare("UPDATE credit_wallets SET balance_units = ?, reserved_units = ?, updated_at = ? WHERE org_id = ?").run(balance, reserved, at, orgId);
  const info = db
    .prepare(
      `INSERT INTO credit_ledger (org_id, kind, delta_units, reserved_delta, balance_after, reserved_after, reservation_id, idempotency_key, reference, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(orgId, c.kind, c.delta, c.reservedDelta, balance, reserved, c.reservationId ?? null, c.key ?? null, c.reference ?? "", c.note ?? "", c.by ?? "", at);
  return toEntry(db.prepare("SELECT * FROM credit_ledger WHERE id = ?").get(Number(info.lastInsertRowid)) as LedgerRow);
}

/** A repeated request: the first result if it is the same request, an error if the key was used for something else. */
function earlier(db: DatabaseSync, orgId: string, idempotencyKey: string, same: (e: LedgerEntry) => boolean): LedgerEntry | null {
  const row = db.prepare("SELECT * FROM credit_ledger WHERE org_id = ? AND idempotency_key = ?").get(orgId, idempotencyKey) as LedgerRow | undefined;
  if (!row) return null;
  const entry = toEntry(row);
  if (!same(entry)) throw new CreditError("idempotency-conflict", "That idempotency key was already used for a different request.");
  return entry;
}

// ---- reading ---------------------------------------------------------------------------------------------------------
export function getWallet(orgId: string): Wallet {
  const row = getDb().prepare("SELECT balance_units, reserved_units FROM credit_wallets WHERE org_id = ?").get(orgId) as WalletRow | undefined;
  const balanceUnits = row?.balance_units ?? 0;
  const reservedUnits = row?.reserved_units ?? 0;
  return { orgId, balanceUnits, reservedUnits, availableUnits: balanceUnits - reservedUnits };
}

/** Newest first. `before` is a ledger id, for paging. */
export function listLedger(orgId: string, opts: { limit?: number; before?: number } = {}): LedgerEntry[] {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const rows = getDb()
    .prepare("SELECT * FROM credit_ledger WHERE org_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
    .all(orgId, opts.before ?? Number.MAX_SAFE_INTEGER, limit) as LedgerRow[];
  return rows.map(toEntry);
}

export function getReservation(orgId: string, reservationId: string): Reservation | null {
  const row = getDb().prepare("SELECT * FROM credit_reservations WHERE id = ? AND org_id = ?").get(reservationId, orgId) as ReservationRow | undefined;
  return row ? toReservation(row) : null;
}

// ---- adding credits ----------------------------------------------------------------------------------------------------
/** Credits arriving: a plan allowance (grant), a paid top-up (purchase) or money returned as credits (refund). */
export type AddCredits = { orgId: string; units: number; kind: "grant" | "purchase" | "refund"; idempotencyKey: string; reference?: string; note?: string; createdBy?: string };

/** Same as addCredits, inside a transaction the caller already opened (so credits and the event that earned them commit together). */
export function addCreditsIn(db: DatabaseSync, input: AddCredits): LedgerEntry {
  const units = positive(input.units, "The amount");
  const k = key(input.idempotencyKey);
  if (!["grant", "purchase", "refund"].includes(input.kind)) throw new CreditError("invalid", "Unknown kind.");
  const done = earlier(db, input.orgId, k, (e) => e.kind === input.kind && e.deltaUnits === units);
  if (done) return done;
  return apply(db, input.orgId, { kind: input.kind, delta: units, reservedDelta: 0, key: k, reference: input.reference, note: input.note, by: input.createdBy });
}

export function addCredits(input: AddCredits): LedgerEntry {
  return transaction((db) => addCreditsIn(db, input));
}

/** A manual correction by an administrator, up or down. A reason is mandatory, and it can never dip into reserved credits. */
export function adjustCredits(input: { orgId: string; deltaUnits: number; idempotencyKey: string; note: string; createdBy: string }): LedgerEntry {
  if (!isUnits(input.deltaUnits) || input.deltaUnits === 0) throw new CreditError("invalid", "The adjustment must be a non-zero whole number of units.");
  if (typeof input.note !== "string" || input.note.trim().length < 3) throw new CreditError("invalid", "A reason is required for a manual adjustment.");
  if (typeof input.createdBy !== "string" || !input.createdBy.trim()) throw new CreditError("invalid", "Who made the adjustment is required.");
  const k = key(input.idempotencyKey);
  return transaction((db) => {
    const done = earlier(db, input.orgId, k, (e) => e.kind === "adjust" && e.deltaUnits === input.deltaUnits);
    if (done) return done;
    return apply(db, input.orgId, { kind: "adjust", delta: input.deltaUnits, reservedDelta: 0, key: k, note: input.note.trim(), by: input.createdBy.trim() });
  });
}

// ---- spending: reserve, extend, settle, release ------------------------------------------------------------------------
/** Holds credits for work that is about to run. Refused when the available credits do not cover it. */
export function reserveCredits(input: { orgId: string; units: number; idempotencyKey: string; purpose?: string }): Reservation {
  const units = positive(input.units, "The amount");
  const k = key(input.idempotencyKey);
  return transaction((db) => {
    walletOf(db, input.orgId); // an unknown organization is a clean "not found", not a database error
    const prior = db.prepare("SELECT * FROM credit_reservations WHERE org_id = ? AND idempotency_key = ?").get(input.orgId, k) as ReservationRow | undefined;
    if (prior) {
      if (prior.units !== units) throw new CreditError("idempotency-conflict", "That idempotency key was already used for a different request.");
      return toReservation(prior);
    }
    const id = `res_${randomUUID()}`;
    db.prepare("INSERT INTO credit_reservations (id, org_id, units, status, purpose, idempotency_key, created_at) VALUES (?, ?, ?, 'active', ?, ?, ?)").run(id, input.orgId, units, input.purpose ?? "", k, now());
    // apply() refuses when it does not fit, and the whole transaction (including the row above) is rolled back.
    apply(db, input.orgId, { kind: "reserve", delta: 0, reservedDelta: units, reservationId: id, key: `reserve:${id}`, note: input.purpose });
    return toReservation(db.prepare("SELECT * FROM credit_reservations WHERE id = ?").get(id) as ReservationRow);
  });
}

function activeReservation(db: DatabaseSync, orgId: string, reservationId: string): ReservationRow {
  const row = db.prepare("SELECT * FROM credit_reservations WHERE id = ? AND org_id = ?").get(reservationId, orgId) as ReservationRow | undefined;
  if (!row) throw new CreditError("not-found", "That reservation does not exist.");
  return row;
}

/** More credits for work already running (the "ask the customer to approve more" step). Refused when they are not available. */
export function extendReservation(input: { orgId: string; reservationId: string; extraUnits: number; idempotencyKey: string }): Reservation {
  const extra = positive(input.extraUnits, "The extra amount");
  const k = key(input.idempotencyKey);
  return transaction((db) => {
    const res = activeReservation(db, input.orgId, input.reservationId);
    const done = earlier(db, input.orgId, k, (e) => e.kind === "extend" && e.reservationId === res.id && e.reservedDelta === extra);
    if (done) return toReservation(db.prepare("SELECT * FROM credit_reservations WHERE id = ?").get(res.id) as ReservationRow);
    if (res.status !== "active") throw new CreditError("closed", "That reservation is already closed.");
    apply(db, input.orgId, { kind: "extend", delta: 0, reservedDelta: extra, reservationId: res.id, key: k });
    db.prepare("UPDATE credit_reservations SET units = units + ? WHERE id = ?").run(extra, res.id);
    return toReservation(db.prepare("SELECT * FROM credit_reservations WHERE id = ?").get(res.id) as ReservationRow);
  });
}

/**
 * Charges the ACTUAL cost against a reservation and gives back whatever was not used. The actual cost may not exceed
 * the reservation: ask for more first (extendReservation). Repeating the same settlement is harmless.
 */
export function settleReservation(input: { orgId: string; reservationId: string; actualUnits: number; note?: string }): Reservation {
  const actual = nonNegative(input.actualUnits, "The actual cost");
  return transaction((db) => {
    const res = activeReservation(db, input.orgId, input.reservationId);
    if (res.status === "settled") {
      if (res.actual_units === actual) return toReservation(res);
      throw new CreditError("closed", "That reservation was already settled with a different cost.");
    }
    if (res.status === "released") throw new CreditError("closed", "That reservation was released, so it cannot be settled.");
    if (actual > res.units) throw new CreditError("over-reservation", `The actual cost (${actual}) is more than the reserved amount (${res.units}). Reserve more first.`);
    apply(db, input.orgId, { kind: "settle", delta: -actual, reservedDelta: -res.units, reservationId: res.id, key: `settle:${res.id}`, note: input.note });
    db.prepare("UPDATE credit_reservations SET status = 'settled', actual_units = ?, closed_at = ? WHERE id = ?").run(actual, now(), res.id);
    return toReservation(db.prepare("SELECT * FROM credit_reservations WHERE id = ?").get(res.id) as ReservationRow);
  });
}

/** Gives the whole reservation back untouched (work cancelled or failed before it cost anything). Repeating it is harmless. */
export function releaseReservation(input: { orgId: string; reservationId: string; note?: string }): Reservation {
  return transaction((db) => {
    const res = activeReservation(db, input.orgId, input.reservationId);
    if (res.status === "released") return toReservation(res);
    if (res.status === "settled") throw new CreditError("closed", "That reservation was already settled, so it cannot be released.");
    apply(db, input.orgId, { kind: "release", delta: 0, reservedDelta: -res.units, reservationId: res.id, key: `release:${res.id}`, note: input.note });
    db.prepare("UPDATE credit_reservations SET status = 'released', closed_at = ? WHERE id = ?").run(now(), res.id);
    return toReservation(db.prepare("SELECT * FROM credit_reservations WHERE id = ?").get(res.id) as ReservationRow);
  });
}

/**
 * Re-derives every wallet from its ledger and reports any that disagree. A healthy system returns an empty list.
 * Meant for a periodic check and for tests.
 */
export function auditWallets(): { orgId: string; walletBalance: number; ledgerBalance: number; walletReserved: number; ledgerReserved: number }[] {
  return getDb()
    .prepare(
      `SELECT w.org_id AS orgId, w.balance_units AS walletBalance, COALESCE(SUM(l.delta_units), 0) AS ledgerBalance,
              w.reserved_units AS walletReserved, COALESCE(SUM(l.reserved_delta), 0) AS ledgerReserved
         FROM credit_wallets w LEFT JOIN credit_ledger l ON l.org_id = w.org_id
        GROUP BY w.org_id
       HAVING walletBalance != ledgerBalance OR walletReserved != ledgerReserved`,
    )
    .all() as never;
}

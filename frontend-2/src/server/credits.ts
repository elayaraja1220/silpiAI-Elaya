import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { transaction, getDb } from "@/lib/business/db";

/**
 * The credit engine (server only). The only code that changes a wallet.
 *
 * Units: whole numbers. 1 credit = UNITS_PER_CREDIT units, so a cost smaller than a credit is still exact.
 * balance = credits owned, reserved = the part held for running work, available = what can still be spent (not held, not expired).
 *
 * Rules, all enforced here AND by CHECK constraints and triggers in the database:
 *  - every change is one append-only row in credit_ledger (the database refuses to edit or delete it);
 *  - available credits can never go below zero: a reservation that does not fit is refused;
 *  - every operation runs in one locked transaction, so two requests (or two processes) cannot both spend the same credits;
 *  - every operation that changes a wallet carries an idempotency key: repeating it returns the first result and changes
 *    nothing; reusing the key for a DIFFERENT request is an error.
 *
 * Buckets: credits live in buckets of three categories, spent in a fixed order: promotional first, then subscription, then
 * purchased; inside a category the soonest expiry first, then the oldest. Each ledger row also records how it moved each bucket
 * (credit_ledger_buckets, append-only), so buckets can be reconciled against the ledger at any time (auditBuckets).
 *
 * Conversion from AI provider cost or tokens into credits is NOT here: it is configuration for the AI Gateway.
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

export const BUCKET_CATEGORIES = ["promotional", "subscription", "purchased"] as const;
export type BucketCategory = (typeof BUCKET_CATEGORIES)[number];

export type Wallet = { orgId: string; balanceUnits: number; reservedUnits: number; availableUnits: number };
export type LedgerKind = "grant" | "purchase" | "refund" | "adjust" | "reserve" | "extend" | "release" | "settle";
export type LedgerEntry = { id: number; orgId: string; kind: LedgerKind; deltaUnits: number; reservedDelta: number; balanceAfter: number; reservedAfter: number; reservationId: string | null; idempotencyKey: string | null; reference: string; note: string; createdBy: string; createdAt: string };
export type Reservation = { id: string; orgId: string; units: number; status: "active" | "settled" | "released"; purpose: string; actualUnits: number | null; createdAt: string; closedAt: string | null };
export type Bucket = { id: string; orgId: string; category: BucketCategory; grantedUnits: number; remainingUnits: number; heldUnits: number; freeUnits: number; expiresAt: string | null; expired: boolean; source: string; createdAt: string };

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
type BucketRow = { id: string; org_id: string; category: BucketCategory; granted_units: number; remaining_units: number; held_units: number; expires_at: string | null; source: string; created_at: string };

const toEntry = (r: LedgerRow): LedgerEntry => ({ id: r.id, orgId: r.org_id, kind: r.kind, deltaUnits: r.delta_units, reservedDelta: r.reserved_delta, balanceAfter: r.balance_after, reservedAfter: r.reserved_after, reservationId: r.reservation_id, idempotencyKey: r.idempotency_key, reference: r.reference, note: r.note, createdBy: r.created_by, createdAt: r.created_at });
const toReservation = (r: ReservationRow): Reservation => ({ id: r.id, orgId: r.org_id, units: r.units, status: r.status, purpose: r.purpose, actualUnits: r.actual_units, createdAt: r.created_at, closedAt: r.closed_at });
const toBucket = (r: BucketRow, at: string): Bucket => ({ id: r.id, orgId: r.org_id, category: r.category, grantedUnits: r.granted_units, remainingUnits: r.remaining_units, heldUnits: r.held_units, freeUnits: r.remaining_units - r.held_units, expiresAt: r.expires_at, expired: r.expires_at !== null && r.expires_at <= at, source: r.source, createdAt: r.created_at });

function walletOf(db: DatabaseSync, orgId: string): WalletRow {
  const org = db.prepare("SELECT 1 FROM organizations WHERE id = ?").get(orgId);
  if (!org) throw new CreditError("not-found", "That organization does not exist.");
  db.prepare("INSERT OR IGNORE INTO credit_wallets (org_id, balance_units, reserved_units, updated_at) VALUES (?, 0, 0, ?)").run(orgId, now());
  return db.prepare("SELECT balance_units, reserved_units FROM credit_wallets WHERE org_id = ?").get(orgId) as WalletRow;
}

// ---- buckets: which credits a change touches -----------------------------------------------------------------------------
/** A change to one bucket: its remaining credits (delta) and the part of it held by reservations (held). */
type Move = { bucketId: string; delta: number; held: number };

/** Promotional first, then subscription, then purchased; the soonest expiry first (no expiry last); then the oldest. */
const SPEND_ORDER = "CASE category WHEN 'promotional' THEN 0 WHEN 'subscription' THEN 1 ELSE 2 END, expires_at IS NULL, expires_at, created_at, id";

/** Chooses which buckets pay for `units` from the credits that are free (not held, not expired). Refuses when they do not cover it. */
function pick(db: DatabaseSync, orgId: string, units: number, at: string): { bucketId: string; take: number }[] {
  const rows = db
    .prepare(`SELECT id, remaining_units - held_units AS free FROM credit_buckets WHERE org_id = ? AND remaining_units > held_units AND (expires_at IS NULL OR expires_at > ?) ORDER BY ${SPEND_ORDER}`)
    .all(orgId, at) as { id: string; free: number }[];
  const takes: { bucketId: string; take: number }[] = [];
  let left = units;
  for (const r of rows) {
    if (left <= 0) break;
    const take = Math.min(r.free, left);
    takes.push({ bucketId: r.id, take });
    left -= take;
  }
  if (left > 0) throw new CreditError("insufficient", "Not enough available credits.");
  return takes;
}

const EXPIRY_SETTING: Record<BucketCategory, string> = { promotional: "credits_promotional_expiry_days", subscription: "credits_subscription_expiry_days", purchased: "credits_purchased_expiry_days" };

/** The expiry a new bucket gets by default: days after it arrives, from a setting (0 or unset = never expires). */
function defaultExpiry(db: DatabaseSync, category: BucketCategory, from: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(EXPIRY_SETTING[category]) as { value: string } | undefined;
  const days = row ? Number(row.value) : 0;
  return Number.isInteger(days) && days > 0 && days <= 3650 ? new Date(Date.parse(from) + days * 86_400_000).toISOString() : null;
}

function newBucket(db: DatabaseSync, orgId: string, input: { category: BucketCategory; units: number; expiresAt?: string | null; source?: string }, at: string): Move {
  if (!(BUCKET_CATEGORIES as readonly string[]).includes(input.category)) throw new CreditError("invalid", `Credit category must be one of: ${BUCKET_CATEGORIES.join(", ")}.`);
  let expires: string | null;
  if (input.expiresAt === undefined) expires = defaultExpiry(db, input.category, at);
  else if (input.expiresAt === null) expires = null;
  else {
    const t = Date.parse(input.expiresAt);
    if (!Number.isFinite(t) || t <= Date.parse(at)) throw new CreditError("invalid", "The expiry must be a valid date in the future.");
    expires = new Date(t).toISOString();
  }
  const id = `bkt_${randomUUID()}`;
  // Created empty and filled by the move, so the ledger row and the bucket change are one recorded event.
  db.prepare("INSERT INTO credit_buckets (id, org_id, category, granted_units, remaining_units, held_units, expires_at, source, created_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)").run(id, orgId, input.category, input.units, expires, (input.source ?? "").slice(0, 200), at);
  return { bucketId: id, delta: input.units, held: 0 };
}

type Change = { kind: LedgerKind; delta: number; reservedDelta: number; moves: Move[]; reservationId?: string | null; key?: string | null; reference?: string; note?: string; by?: string };

/** The ONE place a wallet, its ledger and its buckets are written, always together, always inside a transaction the caller opened. */
function apply(db: DatabaseSync, orgId: string, c: Change): LedgerEntry {
  // The bucket moves must add up to exactly what the ledger row says, or something is badly wrong: refuse rather than record it.
  const movedDelta = c.moves.reduce((n, m) => n + m.delta, 0);
  const movedHeld = c.moves.reduce((n, m) => n + m.held, 0);
  if (movedDelta !== c.delta || movedHeld !== c.reservedDelta) throw new Error(`Credit bucket moves (${movedDelta}, ${movedHeld}) do not match the ledger change (${c.delta}, ${c.reservedDelta}).`);
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
  const ledgerId = Number(info.lastInsertRowid);
  const update = db.prepare("UPDATE credit_buckets SET remaining_units = remaining_units + ?, held_units = held_units + ? WHERE id = ? AND org_id = ?");
  const record = db.prepare("INSERT INTO credit_ledger_buckets (ledger_id, bucket_id, delta_units, held_delta) VALUES (?, ?, ?, ?)");
  for (const m of c.moves) {
    if (update.run(m.delta, m.held, m.bucketId, orgId).changes !== 1) throw new Error("A credit bucket move named a bucket of another organization.");
    record.run(ledgerId, m.bucketId, m.delta, m.held);
  }
  return toEntry(db.prepare("SELECT * FROM credit_ledger WHERE id = ?").get(ledgerId) as LedgerRow);
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
/** available = credits that are not held and have not expired. Credits that expired but are not yet swept still count in the balance. */
export function getWallet(orgId: string): Wallet {
  const db = getDb();
  const row = db.prepare("SELECT balance_units, reserved_units FROM credit_wallets WHERE org_id = ?").get(orgId) as WalletRow | undefined;
  const free = db.prepare("SELECT COALESCE(SUM(remaining_units - held_units), 0) AS n FROM credit_buckets WHERE org_id = ? AND (expires_at IS NULL OR expires_at > ?)").get(orgId, now()) as { n: number };
  return { orgId, balanceUnits: row?.balance_units ?? 0, reservedUnits: row?.reserved_units ?? 0, availableUnits: free.n };
}

/** The buckets that still hold credits, in the order they will be spent. */
export function getBuckets(orgId: string, opts: { at?: string } = {}): Bucket[] {
  const at = opts.at ?? now();
  const rows = getDb().prepare(`SELECT * FROM credit_buckets WHERE org_id = ? AND remaining_units > 0 ORDER BY ${SPEND_ORDER}`).all(orgId) as BucketRow[];
  return rows.map((r) => toBucket(r, at));
}

export type BucketSummary = { byCategory: Record<BucketCategory, { remainingUnits: number; heldUnits: number }>; nextExpiry: { at: string; units: number } | null; pendingExpiryUnits: number };
/** Totals per category and the next expiry: what a wallet screen shows. Expired but not yet swept credits are reported apart. */
export function bucketSummary(orgId: string, opts: { at?: string } = {}): BucketSummary {
  const buckets = getBuckets(orgId, opts);
  const byCategory = { promotional: { remainingUnits: 0, heldUnits: 0 }, subscription: { remainingUnits: 0, heldUnits: 0 }, purchased: { remainingUnits: 0, heldUnits: 0 } };
  let pendingExpiryUnits = 0;
  const upcoming: { at: string; units: number }[] = [];
  for (const b of buckets) {
    if (b.expired) { pendingExpiryUnits += b.remainingUnits; continue; }
    byCategory[b.category].remainingUnits += b.remainingUnits;
    byCategory[b.category].heldUnits += b.heldUnits;
    if (b.expiresAt) upcoming.push({ at: b.expiresAt, units: b.remainingUnits });
  }
  upcoming.sort((a, b) => a.at.localeCompare(b.at));
  const first = upcoming[0];
  return { byCategory, nextExpiry: first ? { at: first.at, units: upcoming.filter((u) => u.at === first.at).reduce((n, u) => n + u.units, 0) } : null, pendingExpiryUnits };
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
/**
 * Credits arriving: a plan allowance (grant), a paid top-up (purchase) or money returned as credits (refund).
 * `category` says which bucket they go into (default: subscription for a grant, purchased for a purchase or refund).
 * `expiresAt` is a future UTC time; null means never; leaving it out uses the expiry setting for the category (default: never).
 */
export type AddCredits = { orgId: string; units: number; kind: "grant" | "purchase" | "refund"; idempotencyKey: string; reference?: string; note?: string; createdBy?: string; category?: BucketCategory; expiresAt?: string | null; source?: string; at?: string };

/** Same as addCredits, inside a transaction the caller already opened (so credits and the event that earned them commit together). */
export function addCreditsIn(db: DatabaseSync, input: AddCredits): LedgerEntry {
  const units = positive(input.units, "The amount");
  const k = key(input.idempotencyKey);
  if (!["grant", "purchase", "refund"].includes(input.kind)) throw new CreditError("invalid", "Unknown kind.");
  const done = earlier(db, input.orgId, k, (e) => e.kind === input.kind && e.deltaUnits === units);
  if (done) return done;
  walletOf(db, input.orgId); // an unknown organization is a clean "not found"
  const at = input.at ?? now();
  const category = input.category ?? (input.kind === "grant" ? "subscription" : "purchased");
  const move = newBucket(db, input.orgId, { category, units, expiresAt: input.expiresAt, source: input.source ?? input.reference }, at);
  return apply(db, input.orgId, { kind: input.kind, delta: units, reservedDelta: 0, moves: [move], key: k, reference: input.reference, note: input.note, by: input.createdBy });
}

export function addCredits(input: AddCredits): LedgerEntry {
  return transaction((db) => addCreditsIn(db, input));
}

/**
 * A manual correction by an administrator, up or down. A reason is mandatory, and it can never dip into reserved credits.
 * Adding credits makes a promotional bucket; taking credits away follows the normal spend order over the free credits.
 */
export function adjustCredits(input: { orgId: string; deltaUnits: number; idempotencyKey: string; note: string; createdBy: string; at?: string }): LedgerEntry {
  if (!isUnits(input.deltaUnits) || input.deltaUnits === 0) throw new CreditError("invalid", "The adjustment must be a non-zero whole number of units.");
  if (typeof input.note !== "string" || input.note.trim().length < 3) throw new CreditError("invalid", "A reason is required for a manual adjustment.");
  if (typeof input.createdBy !== "string" || !input.createdBy.trim()) throw new CreditError("invalid", "Who made the adjustment is required.");
  const k = key(input.idempotencyKey);
  return transaction((db) => {
    const done = earlier(db, input.orgId, k, (e) => e.kind === "adjust" && e.deltaUnits === input.deltaUnits);
    if (done) return done;
    walletOf(db, input.orgId);
    const at = input.at ?? now();
    const moves: Move[] = input.deltaUnits > 0
      ? [newBucket(db, input.orgId, { category: "promotional", units: input.deltaUnits, source: `adjustment by ${input.createdBy.trim()}` }, at)]
      : pick(db, input.orgId, -input.deltaUnits, at).map((t) => ({ bucketId: t.bucketId, delta: -t.take, held: 0 }));
    return apply(db, input.orgId, { kind: "adjust", delta: input.deltaUnits, reservedDelta: 0, moves, key: k, note: input.note.trim(), by: input.createdBy.trim() });
  });
}

// ---- spending: reserve, extend, settle, release ------------------------------------------------------------------------
/** Holds credits for work that is about to run. Refused when the available credits do not cover it. */
export function reserveCredits(input: { orgId: string; units: number; idempotencyKey: string; purpose?: string; at?: string }): Reservation {
  const units = positive(input.units, "The amount");
  const k = key(input.idempotencyKey);
  return transaction((db) => {
    walletOf(db, input.orgId); // an unknown organization is a clean "not found", not a database error
    const prior = db.prepare("SELECT * FROM credit_reservations WHERE org_id = ? AND idempotency_key = ?").get(input.orgId, k) as ReservationRow | undefined;
    if (prior) {
      if (prior.units !== units) throw new CreditError("idempotency-conflict", "That idempotency key was already used for a different request.");
      return toReservation(prior);
    }
    const takes = pick(db, input.orgId, units, input.at ?? now()); // refused here when the free credits do not cover it
    const id = `res_${randomUUID()}`;
    db.prepare("INSERT INTO credit_reservations (id, org_id, units, status, purpose, idempotency_key, created_at) VALUES (?, ?, ?, 'active', ?, ?, ?)").run(id, input.orgId, units, input.purpose ?? "", k, now());
    // apply() records the ledger row and the bucket holds together; any failure rolls back the whole transaction (the row above too).
    apply(db, input.orgId, { kind: "reserve", delta: 0, reservedDelta: units, moves: takes.map((t) => ({ bucketId: t.bucketId, delta: 0, held: t.take })), reservationId: id, key: `reserve:${id}`, note: input.purpose });
    const hold = db.prepare("INSERT INTO credit_reservation_holds (reservation_id, bucket_id, seq, units) VALUES (?, ?, ?, ?)");
    takes.forEach((t, i) => hold.run(id, t.bucketId, i + 1, t.take));
    return toReservation(db.prepare("SELECT * FROM credit_reservations WHERE id = ?").get(id) as ReservationRow);
  });
}

function activeReservation(db: DatabaseSync, orgId: string, reservationId: string): ReservationRow {
  const row = db.prepare("SELECT * FROM credit_reservations WHERE id = ? AND org_id = ?").get(reservationId, orgId) as ReservationRow | undefined;
  if (!row) throw new CreditError("not-found", "That reservation does not exist.");
  return row;
}

type HoldRow = { bucket_id: string; units: number };
const holdsOf = (db: DatabaseSync, reservationId: string) => db.prepare("SELECT bucket_id, units FROM credit_reservation_holds WHERE reservation_id = ? ORDER BY seq").all(reservationId) as HoldRow[];

/** More credits for work already running (the "ask the customer to approve more" step). Refused when they are not available. */
export function extendReservation(input: { orgId: string; reservationId: string; extraUnits: number; idempotencyKey: string; at?: string }): Reservation {
  const extra = positive(input.extraUnits, "The extra amount");
  const k = key(input.idempotencyKey);
  return transaction((db) => {
    const res = activeReservation(db, input.orgId, input.reservationId);
    const done = earlier(db, input.orgId, k, (e) => e.kind === "extend" && e.reservationId === res.id && e.reservedDelta === extra);
    if (done) return toReservation(db.prepare("SELECT * FROM credit_reservations WHERE id = ?").get(res.id) as ReservationRow);
    if (res.status !== "active") throw new CreditError("closed", "That reservation is already closed.");
    const takes = pick(db, input.orgId, extra, input.at ?? now());
    apply(db, input.orgId, { kind: "extend", delta: 0, reservedDelta: extra, moves: takes.map((t) => ({ bucketId: t.bucketId, delta: 0, held: t.take })), reservationId: res.id, key: k });
    const next = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM credit_reservation_holds WHERE reservation_id = ?").get(res.id) as { n: number }).n;
    const hold = db.prepare("INSERT INTO credit_reservation_holds (reservation_id, bucket_id, seq, units) VALUES (?, ?, ?, ?) ON CONFLICT(reservation_id, bucket_id) DO UPDATE SET units = units + excluded.units");
    takes.forEach((t, i) => hold.run(res.id, t.bucketId, next + i + 1, t.take));
    db.prepare("UPDATE credit_reservations SET units = units + ? WHERE id = ?").run(extra, res.id);
    return toReservation(db.prepare("SELECT * FROM credit_reservations WHERE id = ?").get(res.id) as ReservationRow);
  });
}

/**
 * Charges the ACTUAL cost against a reservation and gives back whatever was not used. The actual cost may not exceed
 * the reservation: ask for more first (extendReservation). Repeating the same settlement is harmless.
 * The cost is taken from the held buckets in the order they were chosen; credits that were held keep their right to be spent even if they
 * have expired meanwhile.
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
    let left = actual;
    const moves: Move[] = holdsOf(db, res.id).map((h) => {
      const take = Math.min(h.units, left);
      left -= take;
      return { bucketId: h.bucket_id, delta: -take, held: -h.units };
    });
    apply(db, input.orgId, { kind: "settle", delta: -actual, reservedDelta: -res.units, moves, reservationId: res.id, key: `settle:${res.id}`, note: input.note });
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
    const moves: Move[] = holdsOf(db, res.id).map((h) => ({ bucketId: h.bucket_id, delta: 0, held: -h.units }));
    apply(db, input.orgId, { kind: "release", delta: 0, reservedDelta: -res.units, moves, reservationId: res.id, key: `release:${res.id}`, note: input.note });
    db.prepare("UPDATE credit_reservations SET status = 'released', closed_at = ? WHERE id = ?").run(now(), res.id);
    return toReservation(db.prepare("SELECT * FROM credit_reservations WHERE id = ?").get(res.id) as ReservationRow);
  });
}

// ---- expiry -------------------------------------------------------------------------------------------------------------
/**
 * Removes credits whose expiry has passed, as one ledger row per bucket (kind adjust, created by "system", reference "expiry:<bucket>").
 * Credits held by a running reservation are not touched: they are honoured, and whatever is left expires on the next sweep.
 * Safe to run any number of times; meant for a daily schedule (the billing process route calls it).
 */
export function expireCredits(opts: { orgId?: string; at?: string } = {}): { expiredUnits: number; buckets: number } {
  const at = opts.at ?? now();
  return transaction((db) => {
    const due = db
      .prepare(`SELECT * FROM credit_buckets WHERE remaining_units > held_units AND expires_at IS NOT NULL AND expires_at <= ? ${opts.orgId ? "AND org_id = ?" : ""} ORDER BY org_id, expires_at, id`)
      .all(...(opts.orgId ? [at, opts.orgId] : [at])) as BucketRow[];
    let expiredUnits = 0;
    let buckets = 0;
    for (const b of due) {
      const expirable = b.remaining_units - b.held_units;
      const k = `expire:${b.id}:r${b.remaining_units}`;
      if (db.prepare("SELECT 1 FROM credit_ledger WHERE org_id = ? AND idempotency_key = ?").get(b.org_id, k)) continue;
      apply(db, b.org_id, { kind: "adjust", delta: -expirable, reservedDelta: 0, moves: [{ bucketId: b.id, delta: -expirable, held: 0 }], key: k, reference: `expiry:${b.id}`, note: "Credits expired", by: "system" });
      expiredUnits += expirable;
      buckets++;
    }
    return { expiredUnits, buckets };
  });
}

// ---- reconciliation -----------------------------------------------------------------------------------------------------
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

export type BucketMismatch = { check: string; ref: string; expected: number; actual: number };
/**
 * Checks the buckets against everything else, and reports each disagreement. A healthy system returns an empty list:
 *  1. each wallet's balance and reserved total equal the sum of its buckets;
 *  2. each bucket equals its opening amount plus every ledger movement recorded for it;
 *  3. each bucket's held credits equal the active reservations holding it;
 *  4. every ledger row since buckets began has bucket movements that add up to exactly its own amounts.
 */
export function auditBuckets(): BucketMismatch[] {
  const db = getDb();
  const out: BucketMismatch[] = [];
  type R = { ref: string; expected: number; actual: number };
  const add = (check: string, rows: R[]) => rows.forEach((r) => out.push({ check, ref: r.ref, expected: r.expected, actual: r.actual }));
  add("wallet balance = sum of buckets", db.prepare(`SELECT w.org_id AS ref, w.balance_units AS expected, COALESCE(SUM(b.remaining_units), 0) AS actual FROM credit_wallets w LEFT JOIN credit_buckets b ON b.org_id = w.org_id GROUP BY w.org_id HAVING expected != actual`).all() as R[]);
  add("wallet reserved = sum of held", db.prepare(`SELECT w.org_id AS ref, w.reserved_units AS expected, COALESCE(SUM(b.held_units), 0) AS actual FROM credit_wallets w LEFT JOIN credit_buckets b ON b.org_id = w.org_id GROUP BY w.org_id HAVING expected != actual`).all() as R[]);
  add("bucket remaining = opening + ledger movements", db.prepare(`SELECT b.id AS ref, b.remaining_units AS expected, b.opening_units + COALESCE(SUM(m.delta_units), 0) AS actual FROM credit_buckets b LEFT JOIN credit_ledger_buckets m ON m.bucket_id = b.id GROUP BY b.id HAVING expected != actual`).all() as R[]);
  add("bucket held = opening held + ledger movements", db.prepare(`SELECT b.id AS ref, b.held_units AS expected, b.opening_held_units + COALESCE(SUM(m.held_delta), 0) AS actual FROM credit_buckets b LEFT JOIN credit_ledger_buckets m ON m.bucket_id = b.id GROUP BY b.id HAVING expected != actual`).all() as R[]);
  add("bucket held = active reservation holds", db.prepare(`SELECT b.id AS ref, b.held_units AS expected, COALESCE(SUM(CASE WHEN r.status = 'active' THEN h.units ELSE 0 END), 0) AS actual FROM credit_buckets b LEFT JOIN credit_reservation_holds h ON h.bucket_id = b.id LEFT JOIN credit_reservations r ON r.id = h.reservation_id GROUP BY b.id HAVING expected != actual`).all() as R[]);
  const start = Number((db.prepare("SELECT value FROM settings WHERE key = 'bucket_ledger_start_id'").get() as { value: string } | undefined)?.value ?? 0);
  add("ledger amount = sum of its bucket movements", db.prepare(`SELECT CAST(l.id AS TEXT) AS ref, l.delta_units AS expected, COALESCE(SUM(m.delta_units), 0) AS actual FROM credit_ledger l LEFT JOIN credit_ledger_buckets m ON m.ledger_id = l.id WHERE l.id > ? GROUP BY l.id HAVING expected != actual`).all(start) as R[]);
  add("ledger held change = sum of its bucket holds", db.prepare(`SELECT CAST(l.id AS TEXT) AS ref, l.reserved_delta AS expected, COALESCE(SUM(m.held_delta), 0) AS actual FROM credit_ledger l LEFT JOIN credit_ledger_buckets m ON m.ledger_id = l.id WHERE l.id > ? GROUP BY l.id HAVING expected != actual`).all(start) as R[]);
  return out;
}

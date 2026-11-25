// Upgrading a database that already holds credits: migration 10 must carry every wallet and every running reservation over exactly.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { MIGRATIONS, runMigrations } from "@/lib/business/migrations";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-bucket-migration-"));
const file = path.join(dir, "legacy.db");
const LEGACY_LEADS = `CREATE TABLE leads (id TEXT PRIMARY KEY, stage TEXT NOT NULL, client TEXT NOT NULL, requirement TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;

after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("migration 10 on a database that already has credits", () => {
  it("is the last migration, and the database below it has no buckets", () => {
    assert.equal(MIGRATIONS[MIGRATIONS.length - 1]!.id >= 10, true);
    assert.equal(MIGRATIONS.find((m) => m.id === 10)!.name.startsWith("credit buckets"), true);
  });

  it("builds a database as it was before buckets, with a running reservation", () => {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(LEGACY_LEADS);
    runMigrations(db, MIGRATIONS.filter((m) => m.id <= 9));
    const t = "2026-11-01T00:00:00.000Z";
    // One agency lead, as in a real installation: the pre-migration backup is only taken for a database that holds data.
    db.prepare("INSERT INTO leads (id, stage, client, requirement, created_at, updated_at) VALUES ('lead-1', 'quoted', '{}', '{}', ?, ?)").run(t, t);
    db.prepare("INSERT INTO organizations (id, name, type, status, created_at) VALUES ('org_a', 'Legacy A', 'business', 'active', ?)").run(t);
    db.prepare("INSERT INTO organizations (id, name, type, status, created_at) VALUES ('org_b', 'Legacy B', 'business', 'active', ?)").run(t);
    // Org A: granted 6000, one finished job (reserved 300, paid 250) and one still running (holding 1200). Balance 5750, reserved 1200.
    db.prepare("INSERT INTO credit_wallets (org_id, balance_units, reserved_units, updated_at) VALUES ('org_a', 5750, 1200, ?)").run(t);
    db.prepare("INSERT INTO credit_wallets (org_id, balance_units, reserved_units, updated_at) VALUES ('org_b', 0, 0, ?)").run(t);
    db.prepare("INSERT INTO credit_reservations (id, org_id, units, status, actual_units, idempotency_key, created_at, closed_at) VALUES ('res_old', 'org_a', 300, 'settled', 250, 'k-old-1', ?, ?)").run(t, t);
    db.prepare("INSERT INTO credit_reservations (id, org_id, units, status, idempotency_key, created_at) VALUES ('res_run', 'org_a', 1200, 'active', 'k-run-1', ?)").run(t);
    const ledger = db.prepare("INSERT INTO credit_ledger (org_id, kind, delta_units, reserved_delta, balance_after, reserved_after, reservation_id, idempotency_key, created_at) VALUES ('org_a', ?, ?, ?, ?, ?, ?, ?, ?)");
    ledger.run("grant", 6000, 0, 6000, 0, null, "g-1-key", t);
    ledger.run("reserve", 0, 300, 6000, 300, "res_old", "reserve:res_old", t);
    ledger.run("settle", -250, -300, 5750, 0, "res_old", "settle:res_old", t);
    ledger.run("reserve", 0, 1200, 5750, 1200, "res_run", "reserve:res_run", t);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name = 'credit_buckets'").all(), [], "no buckets yet");
    db.close();
  });

  it("opening the database applies migration 10 after taking a backup, and loses nothing", async () => {
    process.env.SILPI_DB_PATH = file;
    const c = await import("@/server/credits");
    assert.deepEqual(c.getWallet("org_a"), { orgId: "org_a", balanceUnits: 5750, reservedUnits: 1200, availableUnits: 4550 });
    const b = c.getBuckets("org_a");
    assert.equal(b.length, 1);
    assert.deepEqual([b[0]!.category, b[0]!.remainingUnits, b[0]!.heldUnits, b[0]!.expiresAt, b[0]!.source], ["purchased", 5750, 1200, null, "opening-balance"], "one opening bucket that never expires, holding what the running reservation holds");
    assert.deepEqual(c.getBuckets("org_b"), [], "a wallet with nothing in it gets no bucket");
    assert.deepEqual(c.auditWallets(), []);
    assert.deepEqual(c.auditBuckets(), [], "the opening bucket reconciles with the old ledger");
    // The backup taken just before migration 10 is the way back: it must exist and still be the OLD shape with the OLD wallet.
    const backups = path.join(dir, "backups");
    assert.ok(existsSync(backups), "a backups folder was created next to the database");
    const copy = readdirSync(backups).find((f) => f.startsWith("silpi-before-migration-10-"));
    assert.ok(copy, "a backup named for migration 10 exists");
    const old = new DatabaseSync(path.join(backups, copy!));
    assert.deepEqual(old.prepare("SELECT name FROM sqlite_master WHERE name = 'credit_buckets'").all(), [], "the backup is from before the buckets");
    assert.deepEqual({ ...(old.prepare("SELECT balance_units AS balance, reserved_units AS reserved FROM credit_wallets WHERE org_id = 'org_a'").get() as object) }, { balance: 5750, reserved: 1200 }, "and it holds the old wallet exactly");
    old.close();
  });

  it("the running reservation keeps working on the new engine: extend, settle, and the old finished ones stay closed", async () => {
    const c = await import("@/server/credits");
    c.extendReservation({ orgId: "org_a", reservationId: "res_run", extraUnits: 300, idempotencyKey: "extend-after-migration" });
    assert.equal(c.getWallet("org_a").reservedUnits, 1500);
    c.settleReservation({ orgId: "org_a", reservationId: "res_run", actualUnits: 1400 });
    assert.deepEqual(c.getWallet("org_a"), { orgId: "org_a", balanceUnits: 4350, reservedUnits: 0, availableUnits: 4350 });
    assert.equal(c.settleReservation({ orgId: "org_a", reservationId: "res_old", actualUnits: 250 }).status, "settled", "repeating an old settlement is still harmless");
    assert.equal((() => { try { c.settleReservation({ orgId: "org_a", reservationId: "res_old", actualUnits: 10 }); return "no-error"; } catch (e) { return (e as { code?: string }).code; } })(), "closed");
    assert.deepEqual(c.auditWallets(), []);
    assert.deepEqual(c.auditBuckets(), []);
  });

  it("new credits after the upgrade form buckets of their own and are spent first when promotional", async () => {
    const c = await import("@/server/credits");
    c.addCredits({ orgId: "org_a", units: 500, kind: "grant", category: "promotional", idempotencyKey: "promo-after-migration" });
    const r = c.reserveCredits({ orgId: "org_a", units: 600, idempotencyKey: "spend-after-migration" });
    c.settleReservation({ orgId: "org_a", reservationId: r.id, actualUnits: 600 });
    assert.deepEqual(c.getBuckets("org_a").map((x) => [x.category, x.remainingUnits]), [["purchased", 4250]], "the 500 promotional went first, then 100 of the opening balance");
    assert.deepEqual(c.auditBuckets(), []);
  });
});

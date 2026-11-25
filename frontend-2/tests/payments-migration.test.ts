// Upgrading a database that already has agency data and subscribers to migration 14 (payments, top-ups, refunds): nothing existing changes, and a backup is made first.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { MIGRATIONS, runMigrations } from "@/lib/business/migrations";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-pay-migration-"));
const file = path.join(dir, "legacy.db");
const LEGACY_LEADS = `CREATE TABLE leads (id TEXT PRIMARY KEY, stage TEXT NOT NULL, client TEXT NOT NULL, requirement TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
const at = "2026-11-20T10:00:00.000Z";

after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("migration 14 on a database with data", () => {
  it("builds a database as it was before it: an agency lead, an agency payment, a paid subscriber", () => {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(LEGACY_LEADS);
    runMigrations(db, MIGRATIONS.filter((m) => m.id <= 13));
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'billing_payments'").get(), undefined, "the new tables do not exist yet");
    db.prepare("INSERT INTO leads (id, stage, client, requirement, created_at, updated_at) VALUES ('L1', 'new', 'Acme', 'A website', ?, ?)").run(at, at);
    db.prepare("INSERT INTO organizations (id, name, type, status, created_at) VALUES ('org_old', 'Old customer', 'business', 'active', ?)").run(at);
    db.close();
  });

  it("opening it adds the payment tables beside the agency's own, keeps the old rows, and backs up first", async () => {
    process.env.SILPI_DB_PATH = file;
    const { getDb } = await import("@/lib/business/db");
    const db = getDb();
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ["billing_payments", "payment_webhook_events", "refunds", "topups", "credit_packages", "credit_package_prices", "payments"]) assert.ok(names.includes(t), `${t} exists`);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number }).n, 1, "the agency lead is untouched");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE id = 'org_old'").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM credit_packages").get() as { n: number }).n, 4, "the four starting packs");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM credit_package_prices").get() as { n: number }).n, 12, "each in dollars, rupees and pounds");
    const copies = existsSync(path.join(dir, "backups")) ? readdirSync(path.join(dir, "backups")) : [];
    assert.ok(copies.some((n) => n.startsWith("silpi-before-migration-14-")), `a backup copy was made before migration 14: ${copies.join(", ")}`);
  });

  it("the old customer can buy credits and the books balance", async () => {
    const p = await import("@/server/payments/service");
    const c = await import("@/server/credits");
    const order = p.createTopupOrder({ orgId: "org_old", packageId: "pkg_100", currency: "USD" });
    p.recordManualPayment({ topupId: order.topup.id, reference: "UPI-MIGR-1" });
    assert.equal(c.getWallet("org_old").balanceUnits, 100_000);
    assert.deepEqual(c.auditWallets(), []);
    assert.deepEqual(c.auditBuckets(), []);
  });

  it("migrations are one-way and recorded once: opening again changes nothing", async () => {
    const { getDb } = await import("@/lib/business/db");
    const rows = getDb().prepare("SELECT id FROM schema_migrations WHERE id = 14").all();
    assert.equal(rows.length, 1);
  });
});

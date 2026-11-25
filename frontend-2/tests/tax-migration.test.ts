// Migration 16 on a database that already has invoices and credit-pack orders: they keep their numbers, gain the tax name they were charged under,
// and the backup is made first.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { MIGRATIONS, runMigrations } from "@/lib/business/migrations";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-tax-migration-"));
const file = path.join(dir, "legacy.db");
const LEGACY_LEADS = `CREATE TABLE leads (id TEXT PRIMARY KEY, stage TEXT NOT NULL, client TEXT NOT NULL, requirement TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
const at = "2026-11-20T10:00:00.000Z";

after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("migration 16 on a database with invoices", () => {
  it("builds a database as it was before it: a rupee invoice with GST, a dollar invoice, a rupee top-up with GST", () => {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(LEGACY_LEADS);
    runMigrations(db, MIGRATIONS.filter((m) => m.id <= 15));
    db.prepare("INSERT INTO leads (id, stage, client, requirement, created_at, updated_at) VALUES ('L1', 'new', 'Acme', 'A website', ?, ?)").run(at, at);
    for (const org of ["org_inr", "org_usd"]) db.prepare("INSERT INTO organizations (id, name, type, status, created_at) VALUES (?, ?, 'business', 'active', ?)").run(org, org, at);
    const sub = db.prepare("INSERT INTO subscriptions (id, org_id, plan_id, status, billing_period, current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at) VALUES (?, ?, 'pro', 'active', 'monthly', ?, ?, 0, ?, ?)");
    sub.run("sub_inr", "org_inr", at, "2026-12-20T10:00:00.000Z", at, at);
    sub.run("sub_usd", "org_usd", at, "2026-12-20T10:00:00.000Z", at, at);
    const inv = db.prepare("INSERT INTO subscription_invoices (id, number, org_id, subscription_id, plan_id, period_start, period_end, currency, subtotal_paise, gst_basis_points, gst_paise, total_paise, status, provider, issued_at) VALUES (?, ?, ?, ?, 'pro', ?, ?, ?, ?, ?, ?, ?, 'paid', 'manual', ?)");
    inv.run("inv_inr", "INV-2026-00001", "org_inr", "sub_inr", at, "2026-12-20T10:00:00.000Z", "INR", 149_900, 1800, 26_982, 176_882, at);
    inv.run("inv_usd", "INV-2026-00002", "org_usd", "sub_usd", at, "2026-12-20T10:00:00.000Z", "USD", 1900, 0, 0, 1900, at);
    db.prepare("INSERT INTO topups (id, number, org_id, package_id, credit_units, currency, subtotal_minor, gst_basis_points, gst_minor, total_minor, status, created_by, created_at) VALUES ('top_inr', 'TOP-2026-00001', 'org_inr', 'pkg_100', 100000, 'INR', 29900, 1800, 5382, 35282, 'paid', '', ?)").run(at);
    db.close();
  });

  it("opening it adds the new tables and columns, names the tax on old invoices, and keeps every amount", async () => {
    process.env.SILPI_DB_PATH = file;
    const { getDb } = await import("@/lib/business/db");
    const d = getDb();
    const label = (table: string, id: string) => (d.prepare(`SELECT tax_label AS l, bill_to AS b FROM ${table} WHERE id = ?`).get(id) as { l: string; b: string | null });
    assert.deepEqual({ ...label("subscription_invoices", "inv_inr") }, { l: "GST", b: null }, "the rupee invoice was charged GST, and says so");
    assert.deepEqual({ ...label("subscription_invoices", "inv_usd") }, { l: "", b: null });
    assert.equal(label("topups", "top_inr").l, "GST");
    assert.deepEqual({ ...(d.prepare("SELECT total_paise AS t, gst_paise AS g FROM subscription_invoices WHERE id = 'inv_inr'").get() as object) }, { t: 176_882, g: 26_982 }, "no amount changed");
    const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ["exchange_rates", "tax_rules", "billing_profiles"]) assert.ok(tables.includes(t), t);
    assert.equal((d.prepare("SELECT COUNT(*) AS n FROM tax_rules").get() as { n: number }).n, 0, "no tax rule is built in");
    assert.equal((d.prepare("SELECT COUNT(*) AS n FROM exchange_rates").get() as { n: number }).n, 0, "no exchange rate is built in");
    const backups = existsSync(path.join(dir, "backups")) ? readdirSync(path.join(dir, "backups")) : [];
    assert.ok(backups.some((n) => n.startsWith("silpi-before-migration-16-")), `a backup was made first: ${backups.join(", ")}`);
  });

  it("the services still work on it: the old subscriber renews with the same GST and the books balance", async () => {
    const s = await import("@/server/subscriptions");
    const c = await import("@/server/credits");
    const old = s.getInvoice("inv_inr")!;
    assert.deepEqual([old.taxLabel, old.gstBasisPoints, old.totalPaise], ["GST", 1800, 176_882]);
    s.processSubscriptions({ now: Date.parse("2026-12-16T10:00:00.000Z") });
    const renewal = s.listInvoices("org_inr").find((i) => i.status === "open")!;
    assert.deepEqual([renewal.gstBasisPoints, renewal.taxLabel], [1800, "GST"]);
    assert.deepEqual(c.auditWallets(), []);
    assert.deepEqual(c.auditBuckets(), []);
  });
});

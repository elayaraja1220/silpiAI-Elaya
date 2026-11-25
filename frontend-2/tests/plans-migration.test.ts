// Upgrading a database that already has subscribers to the new catalogue (migrations 12 and 13): nobody's price or allowance changes by surprise.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { MIGRATIONS, runMigrations } from "@/lib/business/migrations";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-plans-migration-"));
const file = path.join(dir, "legacy.db");
const LEGACY_LEADS = `CREATE TABLE leads (id TEXT PRIMARY KEY, stage TEXT NOT NULL, client TEXT NOT NULL, requirement TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
const T0 = Date.parse("2026-11-20T10:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("migrations 12 and 13 on a database with subscribers", () => {
  it("builds a database as it was before them: a Professional subscriber at 1,200 credits and a Starter subscriber", () => {
    const db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(LEGACY_LEADS);
    runMigrations(db, MIGRATIONS.filter((m) => m.id <= 11));
    const plan = db.prepare("SELECT monthly_price_paise AS price, monthly_credit_units AS credits FROM plans WHERE id = ?");
    assert.deepEqual({ ...(plan.get("professional") as object) }, { price: 449_900, credits: 1_200_000 }, "the catalogue before the six plans");
    assert.deepEqual({ ...(plan.get("starter") as object) }, { price: 49_900, credits: 100_000 });
    const at = iso(T0);
    for (const [org, name] of [["org_prof", "Professional customer"], ["org_start", "Starter customer"]]) db.prepare("INSERT INTO organizations (id, name, type, status, created_at) VALUES (?, ?, 'business', 'active', ?)").run(org, name, at);
    const sub = db.prepare("INSERT INTO subscriptions (id, org_id, plan_id, status, billing_period, current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at) VALUES (?, ?, ?, 'active', 'monthly', ?, ?, 0, ?, ?)");
    sub.run("sub_prof", "org_prof", "professional", at, iso(T0 + 30 * DAY), at, at);
    sub.run("sub_start", "org_start", "starter", at, iso(T0 + 30 * DAY), at, at);
    db.close();
  });

  it("opening it applies the migrations and locks each subscriber to what they were sold", async () => {
    process.env.SILPI_DB_PATH = file;
    const { getDb } = await import("@/lib/business/db");
    const rows = getDb().prepare("SELECT id, currency, unit_amount_minor AS unit, allowance_monthly_units AS allowance FROM subscriptions ORDER BY id").all() as { id: string; currency: string; unit: number; allowance: number }[];
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { id: "sub_prof", currency: "INR", unit: 449_900, allowance: 1_200_000 },
      { id: "sub_start", currency: "INR", unit: 49_900, allowance: 100_000 },
    ]);
  });

  it("the catalogue is now the six plans, while the subscribers keep their old allowance at renewal", async () => {
    const s = await import("@/server/subscriptions");
    const c = await import("@/server/credits");
    assert.deepEqual(s.listPlans().map((p) => p.id), ["free", "starter", "creator", "pro", "professional", "studio", "enterprise"]);
    assert.equal(s.getPlan("professional")!.monthlyCreditUnits, 2_000_000, "new customers get the brief's 2,000 credits");
    assert.equal(s.getPlan("starter")!.monthlyCreditUnits, 200_000);

    // Renew both subscribers: the invoice is at the locked price, and paying grants the LOCKED allowance, not the new one.
    s.processSubscriptions({ now: T0 + 25 * DAY });
    for (const [org, expected] of [["org_prof", 1_200_000], ["org_start", 100_000]] as const) {
      const inv = s.listInvoices(org).find((i) => i.status === "open")!;
      assert.equal(inv.subtotalPaise, org === "org_prof" ? 449_900 : 49_900);
      const before = c.getWallet(org).balanceUnits;
      s.markInvoicePaid({ invoiceId: inv.id, providerRef: `UPI-${org}`, now: T0 + 25 * DAY });
      assert.equal(c.getWallet(org).balanceUnits - before, expected, `${org} received the allowance it was sold with`);
    }
    assert.deepEqual(c.auditWallets(), []);
    assert.deepEqual(c.auditBuckets(), []);
  });

  it("the prices are in plan_prices for rupees, dollars and pounds, and the old retired sizes are off sale and sorted last", async () => {
    const { getDb } = await import("@/lib/business/db");
    const s = await import("@/server/subscriptions");
    const count = (getDb().prepare("SELECT COUNT(*) AS n FROM plan_prices WHERE plan_id = 'pro' AND active = 1").get() as { n: number }).n;
    assert.equal(count, 6, "rupee, dollar and pound, monthly and yearly");
    const all = s.listPlans({ includeInactive: true }).map((p) => [p.id, p.active]);
    assert.deepEqual(all.slice(-8).map(([id]) => id).sort(), ["pro-1600", "pro-3200", "pro-6400", "pro-800", "professional-19200", "professional-2400", "professional-4800", "professional-9600"]);
    assert.ok(all.slice(-8).every(([, active]) => active === false));
  });

  it("a credit is now worth one cent: the conversion and every model's markup moved, with the old figures kept in the history", async () => {
    const cat = await import("@/server/ai/catalog");
    assert.equal(cat.getUnitsPerUsd(), 100_000);
    assert.deepEqual(cat.listPriceHistory("sonnet-5-5").map((v) => [v.version, v.markupBasisPoints]), [[2, 25_000], [1, 10_000]]);
  });
});

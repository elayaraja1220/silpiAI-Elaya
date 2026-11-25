// Step 9: running the books on a timer, the development shortcut being impossible in production, and the security headers.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-operations-"));
const DAY = 86_400_000;
let seq = 0;
const mods = async () => ({
  cycle: await import("@/server/billing-cycle"),
  s: await import("@/server/subscriptions"),
  p: await import("@/server/payments/service"),
  c: await import("@/server/credits"),
  a: await import("@/server/audit"),
  t: await import("@/server/tenancy"),
});
const newOrg = async () => (await mods()).t.createOrganization({ name: `Ops Org ${++seq}`, type: "business" }).id;

before(() => {
  process.env.SILPI_DB_PATH = path.join(dir, "ops.db");
  delete process.env.ANTHROPIC_API_KEY;
});
after(async () => {
  (await mods()).cycle.stopBillingScheduler();
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("1. the billing cycle", () => {
  it("raises the renewal invoice when it is due, records that it did, and does nothing more when run again", async () => {
    const { cycle, s, p, a } = await mods();
    const org = await newOrg();
    const t0 = Date.now();
    p.recordManualPayment({ invoiceId: s.startSubscription({ orgId: org, planId: "pro", currency: "USD", now: t0 }).invoice!.id, reference: "OPS-1", now: t0 });
    const due = t0 + 25 * DAY; // inside the last week of the period: the next invoice is raised
    const first = cycle.runBillingCycle(due);
    assert.ok(first.processed.renewalInvoices >= 1, JSON.stringify(first));
    assert.equal(s.listInvoices(org).filter((i) => i.status === "open").length, 1);
    const entry = a.listAudit({ action: "billing.auto_run" })[0]!;
    assert.deepEqual([entry.actor, entry.entityType], ["system", "billing"]);
    const entries = a.listAudit({ action: "billing.auto_run" }).length;
    const again = cycle.runBillingCycle(due);
    assert.equal(Object.values(again.processed).every((n) => n === 0), true, "nothing more to do");
    assert.equal(a.listAudit({ action: "billing.auto_run" }).length, entries, "and a run that changes nothing leaves no entry");
    assert.equal(s.listInvoices(org).filter((i) => i.status === "open").length, 1, "still one invoice, not two");
  });
  it("an unpaid renewal goes past due and then lapses to Free, from the timer alone", async () => {
    const { cycle, s, p } = await mods();
    const org = await newOrg();
    const t0 = Date.now();
    p.recordManualPayment({ invoiceId: s.startSubscription({ orgId: org, planId: "pro", currency: "USD", now: t0 }).invoice!.id, reference: "OPS-2", now: t0 });
    cycle.runBillingCycle(t0 + 25 * DAY);
    const afterEnd = cycle.runBillingCycle(t0 + 31 * DAY);
    assert.ok(afterEnd.processed.pastDue >= 1);
    assert.equal(s.getBilling(org).running!.status, "past_due");
    const lapsed = cycle.runBillingCycle(t0 + 45 * DAY);
    assert.ok(lapsed.processed.lapsedToFree >= 1, JSON.stringify(lapsed));
    assert.equal(s.getBilling(org).plan!.id, "free");
  });
  it("credits past their expiry are removed by the same run", async () => {
    const { cycle, c } = await mods();
    const org = await newOrg();
    const now = Date.now();
    const before = c.getWallet(org).balanceUnits;
    c.addCredits({ orgId: org, units: 7000, kind: "grant", category: "promotional", expiresAt: new Date(now + DAY).toISOString(), idempotencyKey: `ops-promo-${org}` });
    assert.equal(c.getWallet(org).balanceUnits, before + 7000);
    const r = cycle.runBillingCycle(now + 2 * DAY);
    assert.ok(r.expired.expiredUnits >= 7000 && r.expired.buckets >= 1, JSON.stringify(r));
    assert.equal(c.getWallet(org).balanceUnits, before);
    assert.deepEqual(c.auditWallets(), []);
    assert.deepEqual(c.auditBuckets(), []);
  });
});

describe("2. when the timer runs", () => {
  it("is on by default in production, off elsewhere unless asked, and can be switched off", async () => {
    const { cycle } = await mods();
    const on = cycle.autoBillingEnabled;
    assert.deepEqual([on({ NODE_ENV: "production" }), on({ NODE_ENV: "development" }), on({}), on({ NODE_ENV: "test" })], [true, false, false, false]);
    assert.deepEqual([on({ NODE_ENV: "development", SILPI_AUTO_BILLING: "1" }), on({ NODE_ENV: "production", SILPI_AUTO_BILLING: "0" }), on({ NODE_ENV: "production", SILPI_AUTO_BILLING: "yes" })], [true, false, true]);
  });
  it("runs hourly unless told otherwise, and an unreasonable interval is ignored", async () => {
    const { cycle } = await mods();
    const ms = cycle.billingIntervalMs;
    assert.deepEqual([ms({}), ms({ SILPI_BILLING_INTERVAL_MINUTES: "30" }), ms({ SILPI_BILLING_INTERVAL_MINUTES: "5" }), ms({ SILPI_BILLING_INTERVAL_MINUTES: "1440" })], [3_600_000, 1_800_000, 300_000, 86_400_000]);
    for (const bad of ["0", "1", "4", "1441", "abc", "-30", ""]) assert.equal(ms({ SILPI_BILLING_INTERVAL_MINUTES: bad }), 3_600_000, `"${bad}" is ignored`);
  });
  it("starts one timer per process however often it is asked, and nothing when disabled", async () => {
    const { cycle } = await mods();
    const holder = globalThis as unknown as { silpiBillingTimer?: unknown };
    assert.equal(cycle.startBillingScheduler({ NODE_ENV: "development" }), false);
    assert.equal(holder.silpiBillingTimer, undefined);
    assert.equal(cycle.startBillingScheduler({ NODE_ENV: "development", SILPI_AUTO_BILLING: "1" }), true);
    const first = holder.silpiBillingTimer;
    assert.ok(first);
    assert.equal(cycle.startBillingScheduler({ NODE_ENV: "development", SILPI_AUTO_BILLING: "1" }), true);
    assert.equal(holder.silpiBillingTimer, first, "the same timer, not a second one");
    cycle.stopBillingScheduler();
    assert.equal(holder.silpiBillingTimer, undefined);
  });
  it("is started when the server starts", async () => {
    const { readFileSync } = await import("node:fs");
    assert.match(readFileSync(path.resolve("src/instrumentation.ts"), "utf8"), /startBillingTimer\(\)/);
  });
});

describe("3. the development shortcut", () => {
  const flag = (nodeEnv: string) => execFileSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning", "--import", "./tests/register.mjs", "--input-type=module", "-e", "import('@/lib/dev-flags').then((m) => console.log(m.DEV_START_WITHOUT_PAYMENT))"], { env: { ...process.env, NODE_ENV: nodeEnv } as NodeJS.ProcessEnv, encoding: "utf8" }).trim();
  it("is available while developing and impossible in a production build, whatever the source file says", () => {
    assert.equal(flag("development"), "true");
    assert.equal(flag("production"), "false");
  });
});

describe("4. security headers", () => {
  it("every page carries the protective headers, and HSTS only in production", async () => {
    const config = ((await import(pathToFileURL(path.resolve("next.config.ts")).href)) as { default: { headers?: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> } }).default;
    const headersOf = async (env: string) => {
      const saved = process.env.NODE_ENV;
      (process.env as Record<string, string>).NODE_ENV = env;
      try {
        const rules = await config.headers!();
        assert.equal(rules.length, 1);
        assert.equal(rules[0]!.source, "/:path*");
        return Object.fromEntries(rules[0]!.headers.map((h) => [h.key, h.value]));
      } finally { (process.env as Record<string, string>).NODE_ENV = saved!; }
    };
    const dev = await headersOf("development");
    assert.deepEqual([dev["X-Content-Type-Options"], dev["X-Frame-Options"], dev["Referrer-Policy"]], ["nosniff", "SAMEORIGIN", "strict-origin-when-cross-origin"]);
    assert.match(dev["Permissions-Policy"]!, /camera=\(\).*microphone=\(\)/);
    assert.equal(dev["Strict-Transport-Security"], undefined, "HSTS would lock a developer's localhost to https");
    assert.match((await headersOf("production"))["Strict-Transport-Security"]!, /max-age=\d+/);
  });
});

describe("5. the launch checklist", () => {
  const level = async (id: string, input: Parameters<(typeof import("@/server/readiness"))["readiness"]>[0] = {}) => {
    const { readiness } = await import("@/server/readiness");
    const c = readiness(input).checks.find((x) => x.id === id);
    assert.ok(c, `check ${id} exists`);
    return c!.level;
  };
  it("judges the administrator token by whether it exists and how long it is", async () => {
    const saved = process.env.SILPI_ADMIN_TOKEN;
    try {
      delete process.env.SILPI_ADMIN_TOKEN;
      assert.equal(await level("admin-token"), "fail");
      process.env.SILPI_ADMIN_TOKEN = "a".repeat(20);
      assert.equal(await level("admin-token", { env: { SILPI_ADMIN_TOKEN: "a".repeat(20) } }), "warn");
      process.env.SILPI_ADMIN_TOKEN = "a".repeat(40);
      assert.equal(await level("admin-token", { env: { SILPI_ADMIN_TOKEN: "a".repeat(40) } }), "ok");
    } finally { if (saved === undefined) delete process.env.SILPI_ADMIN_TOKEN; else process.env.SILPI_ADMIN_TOKEN = saved; }
  });
  it("treats plain HTTP as a failure in production and a warning while developing", async () => {
    assert.deepEqual([await level("https", { secure: true }), await level("https", { secure: false }), await level("https", { secure: false, env: { NODE_ENV: "production" } })], ["ok", "warn", "fail"]);
    assert.deepEqual([await level("production", { env: { NODE_ENV: "production" } }), await level("production", { env: { NODE_ENV: "development" } })], ["ok", "warn"]);
  });
  it("notices the development shortcut, a missing seller, missing accounts and a missing timer, and clears each when fixed", async () => {
    const { readiness } = await import("@/server/readiness");
    const tax = await import("@/server/tax");
    const accounts = await import("@/server/admin-accounts");
    assert.equal(await level("dev-shortcut", { env: { NODE_ENV: "production" } }), "fail", "on while claiming to be production");
    assert.equal(await level("dev-shortcut", { env: { NODE_ENV: "development" } }), "warn");
    assert.equal(await level("seller"), "warn");
    tax.saveSeller({ legalName: "SILPI Technologies", address: "Chennai" });
    assert.equal(await level("seller"), "ok");
    assert.equal(await level("admin-accounts"), "warn");
    await accounts.createAdminAccount({ email: "ready@x.example", name: "Ready", password: "a-correct-horse-battery", role: "admin" });
    assert.equal(await level("admin-accounts"), "ok");
    assert.deepEqual([await level("auto-billing", { env: { NODE_ENV: "development" } }), await level("auto-billing", { env: { NODE_ENV: "production" } })], ["warn", "ok"]);
    const r = readiness();
    assert.deepEqual(r.summary, { ok: r.checks.filter((c) => c.level === "ok").length, warn: r.checks.filter((c) => c.level === "warn").length, fail: r.checks.filter((c) => c.level === "fail").length });
    assert.ok(r.checks.every((c) => c.level === "ok" || c.fix), "everything that is not fine says how to fix it");
  });
  it("AI: no key, a key with nothing switched on, and a switched-on model without its key are each told apart", async () => {
    const cat = await import("@/server/ai/catalog");
    const { readiness } = await import("@/server/readiness");
    const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"];
    for (const k of keys) delete process.env[k];
    const detail = () => readiness().checks.find((c) => c.id === "ai-provider")!;
    assert.match(detail().detail, /No AI provider key/);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    try {
      assert.equal(detail().level, "ok", "the seeded Anthropic models are on and the key is set");
      for (const m of cat.listModels({ enabledOnly: true })) if (m.provider !== "echo") cat.saveModel({ id: m.id, enabled: false });
      assert.match(detail().detail, /no real model is switched on/);
      cat.saveModel({ id: "ready-model", provider: "openai", providerModel: "x", label: "x", tier: "fast", inputUsdMicroPerMtok: 100_000, outputUsdMicroPerMtok: 400_000, enabled: true });
      assert.match(detail().detail, /ready-model is switched on but has no key/);
    } finally { delete process.env.ANTHROPIC_API_KEY; cat.saveModel({ id: "ready-model", enabled: false }); }
  });
  it("exchange rates, backups and failed notices are each noticed, and the books check is a failure when they do not balance", async () => {
    const { s, p } = await mods();
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const db = (await import("@/lib/business/db")).getDb();
    const fx = await import("@/server/fx");
    const org = await newOrg();
    p.recordManualPayment({ invoiceId: s.startSubscription({ orgId: org, planId: "starter", currency: "INR" }).invoice!.id, reference: "READY-INR" });
    assert.equal(await level("fx"), "warn");
    fx.setRate({ currency: "INR", perUsd: "85", source: "bank, today" });
    assert.equal(await level("fx"), "ok");

    assert.equal(await level("backups"), "warn");
    mkdirSync(path.join(dir, "backups"), { recursive: true });
    writeFileSync(path.join(dir, "backups", "copy.db"), "x");
    assert.equal(await level("backups"), "ok");
    assert.equal(await level("backups", { now: Date.now() + 10 * 86_400_000 }), "warn", "a copy ten days old is stale");

    assert.equal(await level("webhooks"), "ok");
    db.prepare("INSERT INTO payment_webhook_events (provider, event_id, type, status, error, payload, received_at) VALUES ('x', 'e1', 'payment.succeeded', 'failed', 'bad', '{}', ?)").run(new Date().toISOString());
    assert.equal(await level("webhooks"), "warn");

    assert.equal(await level("ledger"), "ok");
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("UPDATE credit_wallets SET balance_units = balance_units + 3 WHERE org_id = ?").run(org);
    assert.equal(await level("ledger"), "fail");
    db.prepare("UPDATE credit_wallets SET balance_units = balance_units - 3 WHERE org_id = ?").run(org);
    db.exec("PRAGMA foreign_keys = ON");
    assert.equal(await level("ledger"), "ok");
  });
  it("the route needs the administrator token and returns the checklist", async () => {
    const route = await import("@/app/api/admin/readiness/route");
    const { NextRequest } = await import("next/server");
    const call = (headers: Record<string, string>) => route.GET(new NextRequest("http://localhost:3000/api/admin/readiness", { headers: { host: "localhost:3000", ...headers } }));
    const saved = process.env.SILPI_ADMIN_TOKEN;
    process.env.SILPI_ADMIN_TOKEN = "t".repeat(40);
    try {
      assert.equal((await call({})).status, 401);
      const body = await (await call({ authorization: `Bearer ${"t".repeat(40)}` })).json();
      assert.ok(body.readiness.checks.length >= 12 && body.readiness.summary.ok >= 1);
      assert.ok(!JSON.stringify(body).includes("t".repeat(40)), "the token itself is never in the answer");
    } finally { if (saved === undefined) delete process.env.SILPI_ADMIN_TOKEN; else process.env.SILPI_ADMIN_TOKEN = saved; }
  });
});

describe("6. the backup command", () => {
  it("makes a consistent, checked copy beside the database, never overwrites, and never touches the original", async () => {
    const { readdirSync, statSync, readFileSync } = await import("node:fs");
    const { DatabaseSync } = await import("node:sqlite");
    const db = (await import("@/lib/business/db")).getDb();
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    const dbFile = path.join(dir, "ops.db");
    const before = statSync(dbFile).mtimeMs;
    const out = execFileSync(process.execPath, ["scripts/backup-db.cjs"], { env: { ...process.env, SILPI_DB_PATH: dbFile }, encoding: "utf8" });
    assert.match(out, /Backup written: .*silpi-manual-.*\.db/);
    assert.match(out, /integrity ok/);
    const copies = readdirSync(path.join(dir, "backups")).filter((n) => n.startsWith("silpi-manual-"));
    assert.equal(copies.length, 1);
    const copy = new DatabaseSync(path.join(dir, "backups", copies[0]!), { readOnly: true });
    try {
      assert.ok((copy.prepare("SELECT COUNT(*) AS n FROM credit_wallets").get() as { n: number }).n >= 1, "the data is in the copy");
      assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n >= 17, true, "with its migration history");
    } finally { copy.close(); }
    assert.equal(statSync(dbFile).mtimeMs, before, "the original was not modified");
    assert.ok(readFileSync(path.resolve("scripts/backup-db.cjs"), "utf8").includes("readOnly: true"), "it opens the original read-only");
    assert.equal(await (async () => { const { readiness } = await import("@/server/readiness"); return readiness().checks.find((c) => c.id === "backups")!.level; })(), "ok", "and the launch checklist sees the new copy");
  });
  it("says so and stops when there is no database", () => {
    let failed = false;
    try { execFileSync(process.execPath, ["scripts/backup-db.cjs"], { env: { ...process.env, SILPI_DB_PATH: path.join(dir, "no-such.db") }, encoding: "utf8", stdio: "pipe" }); } catch (e) { failed = true; assert.match(String((e as { stderr?: string }).stderr), /No database at/); }
    assert.ok(failed);
  });
});

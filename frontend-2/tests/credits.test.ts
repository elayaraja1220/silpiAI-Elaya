// Phase 2: the credit engine. Real SQLite database, no mocks.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-credits-"));
const mods = async () => ({ c: await import("@/server/credits"), t: await import("@/server/tenancy"), db: await import("@/lib/business/db") });
let seq = 0;
const k = (p = "k") => `${p}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
const newOrg = async () => (await mods()).t.createOrganization({ name: `Org ${++seq}`, type: "business" }).id;
const fund = async (orgId: string, units: number) => (await mods()).c.addCredits({ orgId, units, kind: "grant", idempotencyKey: k("fund") });
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code?: string }).code ?? "other"; } return "no-error"; };

before(() => { process.env.SILPI_DB_PATH = path.join(dir, "credits.db"); });
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

// =================================================================================================
describe("1. adding credits", () => {
  it("a grant raises the balance and writes one ledger row", async () => {
    const { c } = await mods();
    const org = await newOrg();
    const e = c.addCredits({ orgId: org, units: 10_000, kind: "grant", idempotencyKey: k(), reference: "plan:free", note: "Free plan" });
    assert.deepEqual([e.kind, e.deltaUnits, e.balanceAfter, e.reservedAfter, e.reference], ["grant", 10_000, 10_000, 0, "plan:free"]);
    assert.deepEqual(c.getWallet(org), { orgId: org, balanceUnits: 10_000, reservedUnits: 0, availableUnits: 10_000 });
    assert.equal(c.listLedger(org).length, 1);
  });
  it("repeating a request with the same key changes nothing; the same key for a different request is an error", async () => {
    const { c } = await mods();
    const org = await newOrg();
    const key = k();
    const first = c.addCredits({ orgId: org, units: 500, kind: "purchase", idempotencyKey: key });
    const again = c.addCredits({ orgId: org, units: 500, kind: "purchase", idempotencyKey: key });
    assert.equal(again.id, first.id, "the same ledger row comes back");
    assert.equal(c.getWallet(org).balanceUnits, 500, "credited once");
    assert.equal(code(() => c.addCredits({ orgId: org, units: 900, kind: "purchase", idempotencyKey: key })), "idempotency-conflict");
    assert.equal(code(() => c.addCredits({ orgId: org, units: 500, kind: "grant", idempotencyKey: key })), "idempotency-conflict");
    assert.equal(c.getWallet(org).balanceUnits, 500);
  });
  it("refuses amounts that are not whole positive numbers, a bad key, and an unknown organization", async () => {
    const { c } = await mods();
    const org = await newOrg();
    for (const units of [0, -5, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, "10" as never]) assert.equal(code(() => c.addCredits({ orgId: org, units, kind: "grant", idempotencyKey: k() })), "invalid", String(units));
    for (const idempotencyKey of ["", "abc", " ", undefined as never]) assert.equal(code(() => c.addCredits({ orgId: org, units: 5, kind: "grant", idempotencyKey })), "invalid");
    assert.equal(code(() => c.addCredits({ orgId: org, units: 5, kind: "adjust" as never, idempotencyKey: k() })), "invalid");
    assert.equal(code(() => c.addCredits({ orgId: "org_missing", units: 5, kind: "grant", idempotencyKey: k() })), "not-found");
    assert.equal(c.getWallet(org).balanceUnits, 0);
  });
  it("credits are whole units: 1 credit is 1000 units, so a fraction of a credit is exact", async () => {
    const { c } = await mods();
    assert.deepEqual([c.creditsToUnits(1), c.creditsToUnits(0.001), c.creditsToUnits(2.5), c.unitsToCredits(2500)], [1000, 1, 2500, 2.5]);
  });
});

// =================================================================================================
describe("2. reserving", () => {
  it("holds credits: available drops, balance does not", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await fund(org, 1000);
    const r = c.reserveCredits({ orgId: org, units: 400, idempotencyKey: k(), purpose: "generate site" });
    assert.deepEqual([r.status, r.units, r.purpose], ["active", 400, "generate site"]);
    assert.deepEqual(c.getWallet(org), { orgId: org, balanceUnits: 1000, reservedUnits: 400, availableUnits: 600 });
  });
  it("a reservation that does not fit is refused and leaves NOTHING behind (no row, no ledger entry, no change)", async () => {
    const { c, db } = await mods();
    const org = await newOrg();
    await fund(org, 1000);
    c.reserveCredits({ orgId: org, units: 700, idempotencyKey: k() });
    const ledgerBefore = c.listLedger(org).length;
    assert.equal(code(() => c.reserveCredits({ orgId: org, units: 301, idempotencyKey: k() })), "insufficient");
    assert.equal(c.getWallet(org).availableUnits, 300);
    assert.equal(c.listLedger(org).length, ledgerBefore);
    assert.equal((db.getDb().prepare("SELECT COUNT(*) AS n FROM credit_reservations WHERE org_id = ?").get(org) as { n: number }).n, 1);
    assert.ok(c.reserveCredits({ orgId: org, units: 300, idempotencyKey: k() }), "exactly what is left is fine");
    assert.equal(c.getWallet(org).availableUnits, 0);
  });
  it("an organization with no wallet yet cannot reserve", async () => {
    const { c } = await mods();
    const org = await newOrg();
    assert.equal(code(() => c.reserveCredits({ orgId: org, units: 1, idempotencyKey: k() })), "insufficient");
    assert.equal(code(() => c.reserveCredits({ orgId: "org_missing", units: 1, idempotencyKey: k() })), "not-found");
  });
  it("the same key reserves once; the same key for a different amount is an error", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await fund(org, 1000);
    const key = k();
    const a = c.reserveCredits({ orgId: org, units: 200, idempotencyKey: key });
    const b = c.reserveCredits({ orgId: org, units: 200, idempotencyKey: key });
    assert.equal(a.id, b.id);
    assert.equal(c.getWallet(org).reservedUnits, 200, "held once, not twice");
    assert.equal(code(() => c.reserveCredits({ orgId: org, units: 250, idempotencyKey: key })), "idempotency-conflict");
  });
  it("two organizations may use the same key without touching each other", async () => {
    const { c } = await mods();
    const [a, b] = [await newOrg(), await newOrg()];
    await fund(a, 100);
    await fund(b, 100);
    const key = k();
    const ra = c.reserveCredits({ orgId: a, units: 60, idempotencyKey: key });
    const rb = c.reserveCredits({ orgId: b, units: 60, idempotencyKey: key });
    assert.notEqual(ra.id, rb.id);
    assert.deepEqual([c.getWallet(a).reservedUnits, c.getWallet(b).reservedUnits], [60, 60]);
  });
});

// =================================================================================================
describe("3. settling and releasing", () => {
  it("charges the actual cost and gives back the rest", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await fund(org, 1000);
    const r = c.reserveCredits({ orgId: org, units: 600, idempotencyKey: k() });
    const s = c.settleReservation({ orgId: org, reservationId: r.id, actualUnits: 250 });
    assert.deepEqual([s.status, s.actualUnits], ["settled", 250]);
    assert.deepEqual(c.getWallet(org), { orgId: org, balanceUnits: 750, reservedUnits: 0, availableUnits: 750 });
    const last = c.listLedger(org)[0];
    assert.deepEqual([last.kind, last.deltaUnits, last.reservedDelta], ["settle", -250, -600]);
  });
  it("can settle at exactly the reserved amount, and at zero", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await fund(org, 1000);
    const a = c.reserveCredits({ orgId: org, units: 300, idempotencyKey: k() });
    const b = c.reserveCredits({ orgId: org, units: 300, idempotencyKey: k() });
    c.settleReservation({ orgId: org, reservationId: a.id, actualUnits: 300 });
    c.settleReservation({ orgId: org, reservationId: b.id, actualUnits: 0 });
    assert.deepEqual(c.getWallet(org), { orgId: org, balanceUnits: 700, reservedUnits: 0, availableUnits: 700 });
  });
  it("a cost above the reservation is refused and changes nothing; extending first makes it possible", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await fund(org, 1000);
    const r = c.reserveCredits({ orgId: org, units: 300, idempotencyKey: k() });
    assert.equal(code(() => c.settleReservation({ orgId: org, reservationId: r.id, actualUnits: 301 })), "over-reservation");
    assert.deepEqual(c.getWallet(org), { orgId: org, balanceUnits: 1000, reservedUnits: 300, availableUnits: 700 });
    assert.equal(c.getReservation(org, r.id)?.status, "active");
    const ext = c.extendReservation({ orgId: org, reservationId: r.id, extraUnits: 100, idempotencyKey: k() });
    assert.equal(ext.units, 400);
    assert.equal(c.settleReservation({ orgId: org, reservationId: r.id, actualUnits: 350 }).status, "settled");
    assert.equal(c.getWallet(org).balanceUnits, 650);
  });
  it("extending is refused when the credits are not there, when closed, and is idempotent", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await fund(org, 500);
    const r = c.reserveCredits({ orgId: org, units: 400, idempotencyKey: k() });
    assert.equal(code(() => c.extendReservation({ orgId: org, reservationId: r.id, extraUnits: 101, idempotencyKey: k() })), "insufficient");
    const key = k();
    c.extendReservation({ orgId: org, reservationId: r.id, extraUnits: 50, idempotencyKey: key });
    c.extendReservation({ orgId: org, reservationId: r.id, extraUnits: 50, idempotencyKey: key });
    assert.equal(c.getReservation(org, r.id)?.units, 450, "extended once");
    c.releaseReservation({ orgId: org, reservationId: r.id });
    assert.equal(code(() => c.extendReservation({ orgId: org, reservationId: r.id, extraUnits: 10, idempotencyKey: k() })), "closed");
  });
  it("settling twice with the same cost is harmless; with a different cost, or after release, it is an error", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await fund(org, 1000);
    const r = c.reserveCredits({ orgId: org, units: 500, idempotencyKey: k() });
    c.settleReservation({ orgId: org, reservationId: r.id, actualUnits: 200 });
    c.settleReservation({ orgId: org, reservationId: r.id, actualUnits: 200 });
    assert.equal(c.getWallet(org).balanceUnits, 800, "charged once");
    assert.equal(code(() => c.settleReservation({ orgId: org, reservationId: r.id, actualUnits: 300 })), "closed");
    assert.equal(code(() => c.releaseReservation({ orgId: org, reservationId: r.id })), "closed");
    const r2 = c.reserveCredits({ orgId: org, units: 100, idempotencyKey: k() });
    c.releaseReservation({ orgId: org, reservationId: r2.id });
    assert.equal(code(() => c.settleReservation({ orgId: org, reservationId: r2.id, actualUnits: 10 })), "closed");
  });
  it("releasing gives everything back, and repeating it is harmless", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await fund(org, 1000);
    const r = c.reserveCredits({ orgId: org, units: 400, idempotencyKey: k() });
    c.releaseReservation({ orgId: org, reservationId: r.id });
    c.releaseReservation({ orgId: org, reservationId: r.id });
    assert.deepEqual(c.getWallet(org), { orgId: org, balanceUnits: 1000, reservedUnits: 0, availableUnits: 1000 });
    assert.equal(c.listLedger(org).filter((e) => e.kind === "release").length, 1);
  });
  it("one organization cannot touch another organization's reservation", async () => {
    const { c } = await mods();
    const [a, b] = [await newOrg(), await newOrg()];
    await fund(a, 1000);
    const r = c.reserveCredits({ orgId: a, units: 400, idempotencyKey: k() });
    assert.equal(c.getReservation(b, r.id), null);
    assert.equal(code(() => c.settleReservation({ orgId: b, reservationId: r.id, actualUnits: 1 })), "not-found");
    assert.equal(code(() => c.releaseReservation({ orgId: b, reservationId: r.id })), "not-found");
    assert.equal(code(() => c.extendReservation({ orgId: b, reservationId: r.id, extraUnits: 1, idempotencyKey: k() })), "not-found");
    assert.equal(c.getWallet(a).reservedUnits, 400);
  });
});

// =================================================================================================
describe("4. manual adjustments", () => {
  it("need a reason and a name, work up and down, and can never dip into reserved credits", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await fund(org, 1000);
    c.reserveCredits({ orgId: org, units: 600, idempotencyKey: k() });
    assert.equal(code(() => c.adjustCredits({ orgId: org, deltaUnits: -100, idempotencyKey: k(), note: "", createdBy: "admin" })), "invalid");
    assert.equal(code(() => c.adjustCredits({ orgId: org, deltaUnits: -100, idempotencyKey: k(), note: "fix", createdBy: " " })), "invalid");
    assert.equal(code(() => c.adjustCredits({ orgId: org, deltaUnits: 0, idempotencyKey: k(), note: "fix", createdBy: "admin" })), "invalid");
    assert.equal(code(() => c.adjustCredits({ orgId: org, deltaUnits: -401, idempotencyKey: k(), note: "too much", createdBy: "admin" })), "insufficient");
    const down = c.adjustCredits({ orgId: org, deltaUnits: -400, idempotencyKey: k(), note: "chargeback", createdBy: "admin" });
    assert.deepEqual([down.kind, down.deltaUnits, down.note, down.createdBy], ["adjust", -400, "chargeback", "admin"]);
    assert.deepEqual(c.getWallet(org), { orgId: org, balanceUnits: 600, reservedUnits: 600, availableUnits: 0 });
    const key = k();
    c.adjustCredits({ orgId: org, deltaUnits: 50, idempotencyKey: key, note: "goodwill", createdBy: "admin" });
    c.adjustCredits({ orgId: org, deltaUnits: 50, idempotencyKey: key, note: "goodwill", createdBy: "admin" });
    assert.equal(c.getWallet(org).balanceUnits, 650, "applied once");
  });
});

// =================================================================================================
describe("5. the ledger and the database refuse what the code should never do", () => {
  it("the ledger cannot be edited or deleted, even by direct SQL", async () => {
    const { c, db } = await mods();
    const org = await newOrg();
    await fund(org, 100);
    assert.throws(() => db.getDb().prepare("UPDATE credit_ledger SET delta_units = 999999 WHERE org_id = ?").run(org), /append-only/);
    assert.throws(() => db.getDb().prepare("DELETE FROM credit_ledger WHERE org_id = ?").run(org), /append-only/);
    assert.equal(c.listLedger(org)[0].deltaUnits, 100);
  });
  it("the wallet cannot be pushed negative, or reserved above its balance, even by direct SQL", async () => {
    const { db } = await mods();
    const org = await newOrg();
    await fund(org, 100);
    assert.throws(() => db.getDb().prepare("UPDATE credit_wallets SET balance_units = -1 WHERE org_id = ?").run(org), /CHECK/);
    assert.throws(() => db.getDb().prepare("UPDATE credit_wallets SET reserved_units = 101 WHERE org_id = ?").run(org), /CHECK/);
  });
  it("an organization that owns financial records cannot be deleted", async () => {
    const { db } = await mods();
    const org = await newOrg();
    await fund(org, 100);
    db.getDb().exec("PRAGMA foreign_keys = ON");
    assert.throws(() => db.getDb().prepare("DELETE FROM organizations WHERE id = ?").run(org), /FOREIGN KEY/);
  });
  it("listing the ledger is newest first and pages", async () => {
    const { c } = await mods();
    const org = await newOrg();
    for (let i = 1; i <= 5; i++) c.addCredits({ orgId: org, units: i * 10, kind: "grant", idempotencyKey: k() });
    const all = c.listLedger(org);
    assert.deepEqual(all.map((e) => e.deltaUnits), [50, 40, 30, 20, 10]);
    assert.deepEqual(c.listLedger(org, { limit: 2 }).map((e) => e.deltaUnits), [50, 40]);
    assert.deepEqual(c.listLedger(org, { limit: 2, before: all[1].id }).map((e) => e.deltaUnits), [30, 20]);
  });
});

// =================================================================================================
describe("6. many operations, then check the books", () => {
  it("300 random operations keep every invariant, and every wallet equals the sum of its ledger", async () => {
    const { c } = await mods();
    const orgs = [await newOrg(), await newOrg(), await newOrg()];
    for (const o of orgs) await fund(o, 5000);
    let state = 12345; // a small seeded generator: the same sequence every run
    const rand = (n: number) => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state % n; };
    const open: { org: string; id: string; units: number }[] = [];
    for (let i = 0; i < 300; i++) {
      const org = orgs[rand(orgs.length)];
      const op = rand(6);
      try {
        if (op === 0) c.addCredits({ orgId: org, units: 1 + rand(500), kind: "purchase", idempotencyKey: k("r") });
        else if (op === 1) { const units = 1 + rand(1500); open.push({ org, id: c.reserveCredits({ orgId: org, units, idempotencyKey: k("r") }).id, units }); }
        else if (op === 2 && open.length) { const r = open.splice(rand(open.length), 1)[0]; c.settleReservation({ orgId: r.org, reservationId: r.id, actualUnits: rand(r.units + 1) }); }
        else if (op === 3 && open.length) { const r = open.splice(rand(open.length), 1)[0]; c.releaseReservation({ orgId: r.org, reservationId: r.id }); }
        else if (op === 4 && open.length) { const r = open[rand(open.length)]; c.extendReservation({ orgId: r.org, reservationId: r.id, extraUnits: 1 + rand(300), idempotencyKey: k("r") }); r.units = c.getReservation(r.org, r.id)!.units; }
        else if (op === 5) c.adjustCredits({ orgId: org, deltaUnits: rand(400) - 200 || 1, idempotencyKey: k("r"), note: "test", createdBy: "t" });
      } catch (e) {
        assert.ok(["insufficient", "over-reservation"].includes((e as { code?: string }).code ?? ""), `unexpected failure: ${(e as Error).message}`);
      }
      const w = c.getWallet(org);
      assert.ok(w.balanceUnits >= 0 && w.reservedUnits >= 0 && w.availableUnits >= 0, "never negative");
    }
    assert.deepEqual(c.auditWallets(), [], "every wallet equals its ledger");
  });
});

// =================================================================================================
describe("7. spending at the same time", () => {
  it("50 simultaneous reservations against 100 available: exactly 10 of 10 units succeed", async () => {
    const { c } = await mods();
    const org = await newOrg();
    await fund(org, 100);
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => Promise.resolve().then(() => { try { return c.reserveCredits({ orgId: org, units: 10, idempotencyKey: `burst-${org}-${i}` }).id; } catch (e) { return (e as { code?: string }).code; } })));
    assert.equal(results.filter((r) => r?.startsWith("res_")).length, 10);
    assert.equal(results.filter((r) => r === "insufficient").length, 40);
    assert.deepEqual(c.getWallet(org), { orgId: org, balanceUnits: 100, reservedUnits: 100, availableUnits: 0 });
    assert.deepEqual(c.auditWallets().filter((x) => x.orgId === org), []);
  });

  it("four separate processes racing for the same credits: exactly 10 of 10 units succeed in total", async () => {
    const { c, db } = await mods();
    const org = await newOrg();
    await fund(org, 100);
    const register = pathToFileURL(path.resolve("tests/register.mjs")).href; // an absolute --import path must be a file:// URL on Windows
    const worker = path.resolve("tests/fixtures/credit-worker.ts");
    const run = (tag: string) => new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", register, worker, org, "10", "10", tag], { env: { ...process.env, SILPI_DB_PATH: path.join(dir, "credits.db") } });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (status) => (status === 0 ? resolve(Number(/WON:(\d+)/.exec(out)?.[1])) : reject(new Error(`worker ${tag} failed: ${err.slice(0, 1200)}`))));
    });
    const won = await Promise.all(["p1", "p2", "p3", "p4"].map(run));
    assert.equal(won.reduce((a, b) => a + b, 0), 10, `the four processes won ${won.join("+")}`);
    assert.deepEqual(c.getWallet(org), { orgId: org, balanceUnits: 100, reservedUnits: 100, availableUnits: 0 });
    assert.equal((db.getDb().prepare("SELECT COUNT(*) AS n FROM credit_reservations WHERE org_id = ?").get(org) as { n: number }).n, 10);
    assert.deepEqual(c.auditWallets().filter((x) => x.orgId === org), []);
  });
});

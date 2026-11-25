// The payments layer: signatures, top-up orders, recording payments, the provider's notices, refunds, chargebacks and the HTTP doors.
// Real SQLite, the real catalogue. The provider is a TEST-ONLY adapter registered here (it checks a real HMAC signature); nothing in the product pretends a payment succeeded.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { hmacSha256Hex, safeEqualHex, verifyBodySignature, verifyTimestampedSignature } from "@/server/payments/signature";
import { WebhookError, type PaymentEvent, type PaymentProvider } from "@/server/payments/provider";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-payments-"));
const ADMIN = "test-admin-token-0123456789abcdef";
const PASSWORD = "a-long-test-password";
const SECRET = "whsec_test_secret_for_the_test_provider";
const T0 = Date.parse("2026-12-01T10:00:00.000Z");
let seq = 0;
const uid = (p = "e") => `${p}_${++seq}_${Math.random().toString(36).slice(2, 8)}`;

const mods = async () => ({
  p: await import("@/server/payments/service"),
  prov: await import("@/server/payments/provider"),
  s: await import("@/server/subscriptions"),
  c: await import("@/server/credits"),
  t: await import("@/server/tenancy"),
  db: await import("@/lib/business/db"),
});
const newOrg = async () => (await mods()).t.createOrganization({ name: `Pay Org ${++seq}`, type: "business" }).id;
const fails = async (fn: () => unknown, pattern: RegExp) => { try { await fn(); } catch (e) { assert.match((e as Error).message, pattern); return; } assert.fail(`expected an error matching ${pattern}`); };
const reconciled = async () => { const { c } = await mods(); assert.deepEqual(c.auditWallets(), []); assert.deepEqual(c.auditBuckets(), []); };

// ---- the test provider ----------------------------------------------------------------------------------------------------------
const refundCalls: { providerPaymentId: string; amountMinor: number; idempotencyKey: string }[] = [];
let refundBehaviour: "ok" | "reject" | "slow" = "ok";
const testProvider: PaymentProvider = {
  id: "testpay",
  label: "Test provider",
  isConfigured: () => true,
  parseWebhook(rawBody, headers) {
    if (!verifyBodySignature(headers["x-test-signature"], rawBody, SECRET)) throw new WebhookError(401, "The signature is not valid.");
    let parsed: { events?: PaymentEvent[] };
    try { parsed = JSON.parse(rawBody); } catch { throw new WebhookError(400, "The notice is not valid JSON."); }
    if (!Array.isArray(parsed.events)) throw new WebhookError(400, "The notice has no events.");
    return parsed.events;
  },
  async refund(input) {
    refundCalls.push({ providerPaymentId: input.providerPaymentId, amountMinor: input.amountMinor, idempotencyKey: input.idempotencyKey });
    if (refundBehaviour === "reject") throw new Error("insufficient balance at the provider");
    if (refundBehaviour === "slow") await new Promise((r) => setTimeout(r, 40));
    return { providerRefundId: `re_${input.idempotencyKey}` };
  },
};
const signed = (events: PaymentEvent[]) => { const body = JSON.stringify({ events }); return { body, headers: { "x-test-signature": hmacSha256Hex(SECRET, body) } as Record<string, string> }; };
const send = async (events: PaymentEvent[]) => { const { p } = await mods(); const n = signed(events); return p.ingestWebhook("testpay", n.body, n.headers, T0); };

/** A paid-up Pro subscription's open invoice, in dollars: total 1900. */
async function openInvoice(currency = "USD") {
  const { s } = await mods();
  const org = await newOrg();
  const started = s.startSubscription({ orgId: org, planId: "pro", currency, now: T0 });
  return { org, invoice: started.invoice! };
}
const succeed = (target: PaymentEvent extends infer E ? E extends { target: infer T } ? T : never : never, amountMinor: number, currency: string, over: Partial<{ eventId: string; providerPaymentId: string }> = {}): PaymentEvent =>
  ({ type: "payment.succeeded", eventId: over.eventId ?? uid("evt"), providerPaymentId: over.providerPaymentId ?? uid("pay"), target, amountMinor, currency });

before(async () => {
  process.env.SILPI_DB_PATH = path.join(dir, "payments.db");
  process.env.SILPI_ADMIN_TOKEN = ADMIN;
  delete process.env.ANTHROPIC_API_KEY;
  (await mods()).prov.registerPaymentProvider(testProvider);
});
after(async () => {
  (await mods()).prov.unregisterPaymentProvider("testpay");
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

// =================================================================================================
describe("1. checking a provider's signature", () => {
  it("the HMAC primitive matches the published test vector (RFC 4231, case 2)", () => {
    assert.equal(hmacSha256Hex("Jefe", "what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });
  it("compares signatures safely: only equal, well-formed hex passes", () => {
    assert.equal(safeEqualHex("ab12", "ab12"), true);
    assert.equal(safeEqualHex("AB12", "ab12"), true, "case does not matter in hex");
    for (const [a, b] of [["ab12", "ab13"], ["ab12", "ab1"], ["", ""], ["zz", "zz"], ["abc", "abc"], ["ab12", "ab1234"]] as const) assert.equal(safeEqualHex(a, b), false, `${a} vs ${b}`);
  });
  it("the plain scheme: valid, tampered, wrong secret, missing", () => {
    const body = '{"a":1}';
    const sig = hmacSha256Hex("secret", body);
    assert.equal(verifyBodySignature(sig, body, "secret"), true);
    assert.equal(verifyBodySignature(sig, body + " ", "secret"), false, "a changed body");
    assert.equal(verifyBodySignature(sig, body, "other"), false, "the wrong secret");
    assert.equal(verifyBodySignature(null, body, "secret"), false);
    assert.equal(verifyBodySignature(sig, body, ""), false, "an empty secret never verifies");
  });
  it("the timestamped scheme: valid, tampered, stale, from the future, rotated secrets, malformed", () => {
    const body = '{"id":"evt_1"}';
    const now = 1_800_000_000;
    const header = (t: number, secret = "s3cret") => `t=${t},v1=${hmacSha256Hex(secret, `${t}.${body}`)}`;
    assert.equal(verifyTimestampedSignature(header(now), body, "s3cret", { nowSeconds: now }), true);
    assert.equal(verifyTimestampedSignature(header(now), body + "x", "s3cret", { nowSeconds: now }), false, "a changed body");
    assert.equal(verifyTimestampedSignature(header(now), body, "wrong", { nowSeconds: now }), false);
    assert.equal(verifyTimestampedSignature(header(now - 301), body, "s3cret", { nowSeconds: now }), false, "older than five minutes: a replay");
    assert.equal(verifyTimestampedSignature(header(now - 299), body, "s3cret", { nowSeconds: now }), true);
    assert.equal(verifyTimestampedSignature(header(now + 400), body, "s3cret", { nowSeconds: now }), false, "from the future");
    assert.equal(verifyTimestampedSignature(`${header(now, "old")},v1=${hmacSha256Hex("s3cret", `${now}.${body}`)}`, body, "s3cret", { nowSeconds: now }), true, "any one of several signatures may match");
    for (const bad of [null, "", "t=abc,v1=00", `t=${now}`, `v1=${hmacSha256Hex("s3cret", body)}`, `t=${now},v1=nothex`]) assert.equal(verifyTimestampedSignature(bad, body, "s3cret", { nowSeconds: now }), false, String(bad));
    assert.equal(verifyTimestampedSignature(header(now), body, "", { nowSeconds: now }), false, "an empty secret never verifies");
  });
});

// =================================================================================================
describe("2. providers", () => {
  it("only the manual provider exists until another is set up, and a provider cannot take its place", async () => {
    const { prov } = await mods();
    assert.deepEqual(prov.listPaymentProviders().map((p) => p.id).sort(), ["manual", "testpay"]);
    assert.equal(prov.getPaymentProvider("manual")!.parseWebhook, undefined, "manual has no webhook");
    assert.throws(() => prov.registerPaymentProvider({ ...testProvider, id: "manual" }), /built in/);
    assert.throws(() => prov.registerPaymentProvider({ ...testProvider, id: "Bad Id" }), /lowercase/);
    prov.unregisterPaymentProvider("manual");
    assert.ok(prov.getPaymentProvider("manual"), "manual cannot be removed");
  });
});

// =================================================================================================
describe("3. credit top-up orders", () => {
  it("the starting packs are the brief's, with dollar, rupee and pound prices", async () => {
    const { p } = await mods();
    const packs = p.listCreditPackages();
    assert.deepEqual(packs.map((x) => x.creditUnits / 1000), [100, 250, 500, 1000]);
    const price = (id: string, c: string) => packs.find((x) => x.id === id)!.prices.find((x) => x.currency === c)!.amountMinor;
    assert.deepEqual([price("pkg_100", "USD"), price("pkg_250", "USD"), price("pkg_500", "USD"), price("pkg_1000", "USD")], [300, 700, 1400, 2700]);
    assert.deepEqual([price("pkg_100", "INR"), price("pkg_1000", "INR")], [29_900, 249_900]);
  });
  it("an order fixes its amount, carries GST on rupees only, and makes a pending payment", async () => {
    const { p } = await mods();
    const usd = p.createTopupOrder({ orgId: await newOrg(), packageId: "pkg_100", currency: "USD", now: T0 });
    assert.deepEqual([usd.topup.subtotalMinor, usd.topup.gstMinor, usd.topup.totalMinor, usd.topup.status, usd.topup.creditUnits], [300, 0, 300, "pending", 100_000]);
    assert.match(usd.topup.number, /^TOP-2026-\d{5}$/);
    assert.deepEqual([usd.payment.status, usd.payment.amountMinor, usd.payment.provider, usd.payment.purpose, usd.payment.providerPaymentId], ["pending", 300, "manual", "topup", null]);
    const inr = p.createTopupOrder({ orgId: await newOrg(), packageId: "pkg_100", currency: "INR", now: T0 });
    assert.deepEqual([inr.topup.subtotalMinor, inr.topup.gstMinor, inr.topup.totalMinor], [29_900, 5382, 35_282], "18% GST on rupees");
  });
  it("a later price change does not change an order already made", async () => {
    const { p } = await mods();
    const order = p.createTopupOrder({ orgId: await newOrg(), packageId: "pkg_250", currency: "USD", now: T0 });
    p.setPackagePrice({ packageId: "pkg_250", currency: "USD", amountMinor: 900 });
    try {
      assert.equal(p.getTopup(order.topup.id)!.totalMinor, 700);
      assert.equal(p.createTopupOrder({ orgId: await newOrg(), packageId: "pkg_250", currency: "USD", now: T0 }).topup.totalMinor, 900, "a new order uses the new price");
    } finally { p.setPackagePrice({ packageId: "pkg_250", currency: "USD", amountMinor: 700 }); }
  });
  it("refuses an unknown or switched-off pack, a currency it is not sold in, a bad payment method, the agency, and too many unpaid orders", async () => {
    const { p, db } = await mods();
    const org = await newOrg();
    const internalOrg = (db.getDb().prepare("SELECT id FROM organizations WHERE type = 'internal' LIMIT 1").get() as { id: string }).id;
    await fails(() => p.createTopupOrder({ orgId: org, packageId: "nope", currency: "USD" }), /not available/);
    await fails(() => p.createTopupOrder({ orgId: org, packageId: "pkg_100", currency: "EUR" }), /not sold in EUR/);
    await fails(() => p.createTopupOrder({ orgId: org, packageId: "pkg_100", currency: "XYZ" }), /currency must be/);
    await fails(() => p.createTopupOrder({ orgId: org, packageId: "pkg_100", currency: "USD", provider: "stripe" }), /payment method is not available/);
    await fails(() => p.createTopupOrder({ orgId: "org_missing", packageId: "pkg_100", currency: "USD" }), /does not exist/);
    await fails(() => p.createTopupOrder({ orgId: internalOrg, packageId: "pkg_100", currency: "USD" }), /agency/);
    p.saveCreditPackage({ id: "pkg_100", active: false });
    try { await fails(() => p.createTopupOrder({ orgId: org, packageId: "pkg_100", currency: "USD" }), /not available/); } finally { p.saveCreditPackage({ id: "pkg_100", active: true }); }
    for (let i = 0; i < 5; i++) p.createTopupOrder({ orgId: org, packageId: "pkg_100", currency: "USD", now: T0 });
    await fails(() => p.createTopupOrder({ orgId: org, packageId: "pkg_100", currency: "USD", now: T0 }), /5 unpaid/);
  });
  it("an unpaid order can be cancelled by its own organization only; a paid one cannot", async () => {
    const { p } = await mods();
    const org = await newOrg();
    const other = await newOrg();
    const order = p.createTopupOrder({ orgId: org, packageId: "pkg_100", currency: "USD", now: T0 });
    await fails(() => p.cancelTopupOrder({ orgId: other, topupId: order.topup.id }), /does not exist/);
    assert.equal(p.cancelTopupOrder({ orgId: org, topupId: order.topup.id }).status, "cancelled");
    assert.equal(p.getPayment(order.payment.id)!.status, "failed");
    await fails(() => p.cancelTopupOrder({ orgId: org, topupId: order.topup.id }), /already cancelled/);
    await fails(() => p.recordManualPayment({ topupId: order.topup.id, reference: "UPI-CANCELLED-1" }), /cancelled/);
    const paid = p.createTopupOrder({ orgId: org, packageId: "pkg_100", currency: "USD", now: T0 });
    p.recordManualPayment({ topupId: paid.topup.id, reference: "UPI-PAIDORDER-1", now: T0 });
    await fails(() => p.cancelTopupOrder({ orgId: org, topupId: paid.topup.id }), /Ask for a refund/);
  });
  it("the packs can be edited, priced in any currency, and refuse nonsense", async () => {
    const { p } = await mods();
    const made = p.saveCreditPackage({ id: "pkg_test", name: "Test pack", credits: 50, sortOrder: 9 });
    assert.equal(made.creditUnits, 50_000);
    assert.equal(p.setPackagePrice({ packageId: "pkg_test", currency: "EUR", amountMinor: 150 }).prices[0]!.currency, "EUR");
    assert.equal(p.setPackagePrice({ packageId: "pkg_test", currency: "EUR", amountMinor: null }).prices.length, 0);
    await fails(() => p.saveCreditPackage({ id: "Bad Id", name: "x", credits: 1 }), /package id/);
    await fails(() => p.saveCreditPackage({ id: "pkg_new2" }), /needs a name/);
    await fails(() => p.saveCreditPackage({ id: "pkg_test", credits: -5 }), /positive/);
    await fails(() => p.setPackagePrice({ packageId: "pkg_test", currency: "USD", amountMinor: 0 }), /at least 1/);
    await fails(() => p.setPackagePrice({ packageId: "nope", currency: "USD", amountMinor: 5 }), /does not exist/);
    await fails(() => p.setPackagePrice({ packageId: "pkg_test", currency: "ZZZ", amountMinor: 5 }), /currency must be/);
    p.saveCreditPackage({ id: "pkg_test", active: false });
  });
});

// =================================================================================================
describe("4. recording a payment by hand", () => {
  it("a top-up payment grants the credits into the purchased bucket, once", async () => {
    const { p, c } = await mods();
    const org = await newOrg();
    const before = c.getWallet(org).balanceUnits; // the Free plan's credits
    const order = p.createTopupOrder({ orgId: org, packageId: "pkg_250", currency: "USD", now: T0 });
    const r = p.recordManualPayment({ topupId: order.topup.id, reference: "UPI-HAND-1", amountMinor: 700, now: T0 });
    assert.deepEqual([r.applied, r.duplicate, r.payment.status, r.payment.id === order.payment.id], [true, false, "succeeded", true], "the pending payment of the order is the one that is completed");
    assert.equal(c.getWallet(org).balanceUnits, before + 250_000);
    const purchased = c.getBuckets(org).filter((b) => b.category === "purchased");
    assert.deepEqual(purchased.map((b) => b.remainingUnits), [250_000]);
    assert.equal(p.getTopup(order.topup.id)!.status, "paid");
    const again = p.recordManualPayment({ topupId: order.topup.id, reference: "UPI-HAND-1", now: T0 });
    assert.deepEqual([again.applied, again.duplicate], [false, true]);
    assert.equal(c.getWallet(org).balanceUnits, before + 250_000, "recording it twice added nothing");
    await fails(() => p.recordManualPayment({ topupId: order.topup.id, reference: "UPI-OTHER-REF" }), /already paid/);
    await reconciled();
  });
  it("refuses a wrong amount, and exactly one target", async () => {
    const { p } = await mods();
    const order = p.createTopupOrder({ orgId: await newOrg(), packageId: "pkg_100", currency: "USD", now: T0 });
    await fails(() => p.recordManualPayment({ topupId: order.topup.id, reference: "UPI-AMOUNT-1", amountMinor: 250 }), /is 250 but top-up/);
    assert.equal(p.getTopup(order.topup.id)!.status, "pending", "nothing was applied");
    await fails(() => p.recordManualPayment({ reference: "UPI-NONE-1" }), /either invoiceId or topupId/);
    await fails(() => p.recordManualPayment({ topupId: order.topup.id, invoiceId: "x", reference: "UPI-BOTH-1" }), /either invoiceId or topupId/);
    await fails(() => p.recordManualPayment({ topupId: order.topup.id, reference: "ab" }), /3 to 200/);
    await fails(() => p.recordManualPayment({ topupId: "nope", reference: "UPI-NOPE-1" }), /does not exist/);
  });
  it("an invoice payment activates the plan and credits, and is recorded as a payment", async () => {
    const { p, s, c } = await mods();
    const { org, invoice } = await openInvoice();
    const r = p.recordManualPayment({ invoiceId: invoice.id, reference: "UPI-INV-1", amountMinor: invoice.totalPaise, now: T0 });
    assert.equal(r.payment.purpose, "subscription_invoice");
    assert.equal(r.payment.amountMinor, 1900);
    assert.equal(s.getBilling(org).plan!.id, "pro");
    assert.ok(c.getWallet(org).balanceUnits >= 700_000);
    assert.equal(s.getInvoice(invoice.id)!.status, "paid");
    assert.equal(p.listPayments({ orgId: org }).length, 1);
    await reconciled();
  });
});

// =================================================================================================
describe("5. a provider's notices", () => {
  it("a notice with no valid signature changes nothing and is refused", async () => {
    const { p } = await mods();
    const { invoice } = await openInvoice();
    const n = signed([succeed({ kind: "invoice", invoiceId: invoice.id }, 1900, "USD")]);
    await fails(() => p.ingestWebhook("testpay", n.body, {}, T0), /signature is not valid/);
    await fails(() => p.ingestWebhook("testpay", n.body, { "x-test-signature": "00".repeat(32) }, T0), /signature is not valid/);
    await fails(() => p.ingestWebhook("testpay", n.body + " ", n.headers, T0), /signature is not valid/);
    const { s } = await mods();
    assert.equal(s.getInvoice(invoice.id)!.status, "open");
  });
  it("an unknown provider is not found, and an empty or unreadable notice is a bad request", async () => {
    const { p } = await mods();
    const status = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as WebhookError).status; } return 0; };
    assert.equal(await status(() => p.ingestWebhook("nope", "{}", {})), 404);
    assert.equal(await status(() => p.ingestWebhook("manual", "{}", {})), 404, "manual has no webhook");
    assert.equal(await status(() => p.ingestWebhook("testpay", "", {})), 400);
    const junk = "not json"; const sig = { "x-test-signature": hmacSha256Hex(SECRET, junk) };
    assert.equal(await status(() => p.ingestWebhook("testpay", junk, sig)), 400);
  });
  it("a verified payment notice pays the invoice and is recorded; the same notice again does nothing", async () => {
    const { p, s, c } = await mods();
    const { org, invoice } = await openInvoice();
    const ev = succeed({ kind: "invoice", invoiceId: invoice.id }, 1900, "USD");
    const first = await send([ev]);
    assert.deepEqual(first, { received: 1, processed: 1, duplicates: 0, ignored: 0, failed: 0 });
    assert.equal(s.getInvoice(invoice.id)!.status, "paid");
    assert.equal(s.getBilling(org).plan!.id, "pro");
    const balance = c.getWallet(org).balanceUnits;
    const again = await send([ev]);
    assert.deepEqual(again, { received: 1, processed: 0, duplicates: 1, ignored: 0, failed: 0 });
    assert.equal(c.getWallet(org).balanceUnits, balance, "no second grant");
    // The same payment announced under a different event id (a provider sending it twice) also changes nothing.
    const sameMoney = await send([{ ...ev, eventId: uid("evt") } as PaymentEvent]);
    assert.equal(sameMoney.processed, 1);
    assert.equal(c.getWallet(org).balanceUnits, balance);
    assert.equal(p.listPayments({ orgId: org }).length, 1, "one payment, not two");
    await reconciled();
  });
  it("a payment of the wrong amount or in the wrong currency is recorded as a failed notice and applies nothing, but is answered normally", async () => {
    const { p, s } = await mods();
    const { invoice } = await openInvoice();
    const result = await send([succeed({ kind: "invoice", invoiceId: invoice.id }, 1800, "USD"), succeed({ kind: "invoice", invoiceId: invoice.id }, 1900, "INR")]);
    assert.equal(result.failed, 2);
    assert.equal(s.getInvoice(invoice.id)!.status, "open");
    const events = p.listWebhookEvents(5);
    assert.ok(events.slice(0, 2).every((e) => e.status === "failed" && /is 1800 but|is in INR/.test(e.error ?? "")), JSON.stringify(events.slice(0, 2)));
  });
  it("a top-up payment notice grants the credits; a failed attempt can be followed by a success; a late failure never undoes a success", async () => {
    const { p, c } = await mods();
    const org = await newOrg();
    const order = p.createTopupOrder({ orgId: org, packageId: "pkg_100", currency: "USD", now: T0 });
    const target = { kind: "topup" as const, topupId: order.topup.id };
    const payId = uid("pay");
    await send([{ type: "payment.failed", eventId: uid("evt"), providerPaymentId: payId, target, reason: "card declined" }]);
    const failed = p.listPayments({ orgId: org }).find((x) => x.providerPaymentId === payId)!;
    assert.deepEqual([failed.status, failed.failureReason], ["failed", "card declined"]);
    const base = c.getWallet(org).balanceUnits;
    await send([succeed(target, 300, "USD", { providerPaymentId: payId })]);
    assert.equal(c.getWallet(org).balanceUnits, base + 100_000, "the retry succeeded");
    assert.equal(p.getPayment(failed.id)!.status, "succeeded");
    await send([{ type: "payment.failed", eventId: uid("evt"), providerPaymentId: payId, target, reason: "a late duplicate failure" }]);
    assert.equal(p.getPayment(failed.id)!.status, "succeeded", "a success is not undone by a failure notice");
    assert.equal(c.getWallet(org).balanceUnits, base + 100_000);
    await reconciled();
  });
  it("a second payment for something already paid is kept, flagged and applied to nothing, so it can be refunded", async () => {
    const { p, c } = await mods();
    const { org, invoice } = await openInvoice();
    await send([succeed({ kind: "invoice", invoiceId: invoice.id }, 1900, "USD")]);
    const balance = c.getWallet(org).balanceUnits;
    const dupId = uid("pay");
    await send([succeed({ kind: "invoice", invoiceId: invoice.id }, 1900, "USD", { providerPaymentId: dupId })]);
    assert.equal(c.getWallet(org).balanceUnits, balance, "no second grant");
    const dup = p.listPayments({ orgId: org }).find((x) => x.providerPaymentId === dupId)!;
    assert.equal(dup.status, "succeeded");
    assert.match(dup.failureReason ?? "", /Second payment/);
    const refund = await p.refundPayment({ paymentId: dup.id, reason: "paid twice", requestedBy: "admin" });
    assert.deepEqual([refund.status, refund.creditsReversedUnits], ["succeeded", 0], "refunding the duplicate takes no credits");
    assert.equal(c.getWallet(org).balanceUnits, balance);
  });
  it("a payment for a cancelled invoice, an unknown invoice, or an unknown top-up is a failed notice; other notice types are ignored", async () => {
    const { p, s } = await mods();
    const { invoice } = await openInvoice();
    (await mods()).db.getDb().prepare("UPDATE subscription_invoices SET status = 'void' WHERE id = ?").run(invoice.id); // as when a newer choice replaces the open invoice
    assert.equal(s.getInvoice(invoice.id)!.status, "void");
    const r = await send([
      succeed({ kind: "invoice", invoiceId: invoice.id }, 1900, "USD"),
      succeed({ kind: "invoice", invoiceId: "inv_does_not_exist" }, 1900, "USD"),
      succeed({ kind: "topup", topupId: "top_does_not_exist" }, 300, "USD"),
      { type: "ignored", eventId: uid("evt"), original: "customer.updated" },
    ]);
    assert.deepEqual([r.failed, r.ignored, r.processed], [3, 1, 0]);
    assert.ok(p.listWebhookEvents(4).some((e) => e.status === "ignored" && e.type === "ignored"));
  });
  it("a notice with several events applies each once, and the stored copy of the notice is capped", async () => {
    const { p } = await mods();
    const { invoice } = await openInvoice();
    const ev = succeed({ kind: "invoice", invoiceId: invoice.id }, 1900, "USD");
    await send([ev]);
    const r = await send([ev, { type: "ignored", eventId: uid("evt"), original: "x".repeat(30_000) }]);
    assert.deepEqual([r.received, r.duplicates, r.ignored], [2, 1, 1]);
    const stored = (await mods()).db.getDb().prepare("SELECT MAX(LENGTH(payload)) AS n FROM payment_webhook_events").get() as { n: number };
    assert.ok(stored.n <= 20_000, "an oversized notice is stored cut short");
    assert.ok(p.listWebhookEvents(1).length === 1);
  });
});

// =================================================================================================
describe("6. refunds", () => {
  async function paidTopup(packageId = "pkg_100", currency = "USD") {
    const { p, c } = await mods();
    const org = await newOrg();
    const base = c.getWallet(org).balanceUnits;
    const order = p.createTopupOrder({ orgId: org, packageId, currency, now: T0 });
    const { payment } = p.recordManualPayment({ topupId: order.topup.id, reference: uid("UPI"), now: T0 });
    return { org, payment, base, units: order.topup.creditUnits, total: order.topup.totalMinor };
  }

  it("a full refund returns the money, takes back the unspent credits and says so", async () => {
    const { p, c } = await mods();
    const t = await paidTopup();
    const refund = await p.refundPayment({ paymentId: t.payment.id, reason: "customer asked", requestedBy: "admin" });
    assert.deepEqual([refund.status, refund.amountMinor, refund.creditsReversedUnits, refund.creditsUnrecoveredUnits], ["succeeded", 300, 100_000, 0]);
    assert.equal(p.getPayment(t.payment.id)!.status, "refunded");
    assert.equal(c.getWallet(t.org).balanceUnits, t.base, "back to what the organization had before buying");
    await reconciled();
  });
  it("a partial refund takes back the same share of the credits, and the shares add up exactly across several refunds", async () => {
    const { p, c } = await mods();
    const t = await paidTopup("pkg_100", "USD"); // $3.00 for 100,000 units
    const r1 = await p.refundPayment({ paymentId: t.payment.id, amountMinor: 100, reason: "first third", requestedBy: "admin" });
    assert.equal(r1.creditsReversedUnits, 33_333, "floor of a third");
    assert.equal(p.getPayment(t.payment.id)!.status, "partially_refunded");
    const r2 = await p.refundPayment({ paymentId: t.payment.id, amountMinor: 100, reason: "second third", requestedBy: "admin" });
    assert.equal(r1.creditsReversedUnits + r2.creditsReversedUnits, 66_666, "two thirds, rounded down, never up");
    const r3 = await p.refundPayment({ paymentId: t.payment.id, reason: "the rest", requestedBy: "admin" });
    assert.equal(r1.creditsReversedUnits + r2.creditsReversedUnits + r3.creditsReversedUnits, 100_000, "nothing lost to rounding in the end");
    assert.equal(c.getWallet(t.org).balanceUnits, t.base);
    assert.equal(p.getPayment(t.payment.id)!.status, "refunded");
    assert.equal(p.listRefunds(t.payment.id).length, 3);
    await reconciled();
  });
  it("credits already spent cannot be taken back: the shortfall is recorded, and the balance never goes below zero", async () => {
    const { p, c } = await mods();
    const t = await paidTopup("pkg_100", "USD");
    // Spend nearly everything the organization has, most of it from the purchased bucket (the free allowance goes first only within its own order).
    const spendable = c.getWallet(t.org).availableUnits;
    const hold = c.reserveCredits({ orgId: t.org, units: spendable - 20_000, idempotencyKey: uid("spend") });
    c.settleReservation({ orgId: t.org, reservationId: hold.id, actualUnits: spendable - 20_000 });
    const refund = await p.refundPayment({ paymentId: t.payment.id, reason: "refund after use", requestedBy: "admin" });
    assert.ok(refund.creditsReversedUnits <= 20_000);
    assert.equal(refund.creditsReversedUnits + refund.creditsUnrecoveredUnits, 100_000, "everything is accounted for");
    assert.ok(refund.creditsUnrecoveredUnits >= 80_000, "most of it was already spent");
    assert.ok(c.getWallet(t.org).balanceUnits >= 0);
    await reconciled();
  });
  it("credits held by a running job are not taken", async () => {
    const { p, c } = await mods();
    const t = await paidTopup("pkg_100", "USD");
    const hold = c.reserveCredits({ orgId: t.org, units: c.getWallet(t.org).availableUnits, idempotencyKey: uid("hold") }); // holds everything
    const refund = await p.refundPayment({ paymentId: t.payment.id, reason: "while a job runs", requestedBy: "admin" });
    assert.equal(refund.creditsReversedUnits, 0);
    assert.equal(refund.creditsUnrecoveredUnits, 100_000);
    c.releaseReservation({ orgId: t.org, reservationId: hold.id });
    await reconciled();
  });
  it("refunding a subscription payment takes back that period's allowance", async () => {
    const { p, c } = await mods();
    const { org, invoice } = await openInvoice();
    const before = c.getWallet(org).balanceUnits;
    const paid = p.recordManualPayment({ invoiceId: invoice.id, reference: uid("UPI"), now: T0 });
    assert.equal(c.getWallet(org).balanceUnits, before + 700_000);
    const refund = await p.refundPayment({ paymentId: paid.payment.id, reason: "cancelled within the day", requestedBy: "admin" });
    assert.equal(refund.creditsReversedUnits, 700_000);
    assert.equal(c.getWallet(org).balanceUnits, before);
    await reconciled();
  });
  it("repeating a request with the same key refunds once; a different amount under that key is refused", async () => {
    const { p } = await mods();
    const t = await paidTopup("pkg_250", "USD"); // $7.00
    const key = uid("refund-key");
    const a = await p.refundPayment({ paymentId: t.payment.id, amountMinor: 200, reason: "partial", requestedBy: "admin", idempotencyKey: key });
    const b = await p.refundPayment({ paymentId: t.payment.id, amountMinor: 200, reason: "partial", requestedBy: "admin", idempotencyKey: key });
    assert.equal(a.id, b.id);
    assert.equal(p.getPayment(t.payment.id)!.refundedMinor, 200, "refunded once");
    await fails(() => p.refundPayment({ paymentId: t.payment.id, amountMinor: 300, reason: "partial", requestedBy: "admin", idempotencyKey: key }), /different refund/);
    await fails(() => p.refundPayment({ paymentId: t.payment.id, reason: "x", requestedBy: "admin" }), /3 to 300/);
    await fails(() => p.refundPayment({ paymentId: t.payment.id, reason: "short key", requestedBy: "admin", idempotencyKey: "abc" }), /6 to 200/);
  });
  it("refuses more than is left, nothing, an unknown payment, and a payment that did not succeed", async () => {
    const { p } = await mods();
    const t = await paidTopup("pkg_100", "USD");
    await fails(() => p.refundPayment({ paymentId: t.payment.id, amountMinor: 301, reason: "too much", requestedBy: "admin" }), /Only 300/);
    await fails(() => p.refundPayment({ paymentId: t.payment.id, amountMinor: 0, reason: "nothing at all", requestedBy: "admin" }), /at least 1/);
    await fails(() => p.refundPayment({ paymentId: "pay_nope", reason: "no such payment", requestedBy: "admin" }), /does not exist/);
    const pending = p.createTopupOrder({ orgId: await newOrg(), packageId: "pkg_100", currency: "USD", now: T0 });
    await fails(() => p.refundPayment({ paymentId: pending.payment.id, reason: "never paid", requestedBy: "admin" }), /Only a successful payment/);
    await p.refundPayment({ paymentId: t.payment.id, reason: "all of it", requestedBy: "admin" });
    await fails(() => p.refundPayment({ paymentId: t.payment.id, reason: "again", requestedBy: "admin" }), /already fully refunded/);
  });
  it("with a provider that can refund, the provider is asked first and the books change only if it agrees", async () => {
    const { p, c } = await mods();
    const org = await newOrg();
    const order = p.createTopupOrder({ orgId: org, packageId: "pkg_100", currency: "USD", provider: "testpay", now: T0 });
    const payId = uid("pay");
    await send([succeed({ kind: "topup", topupId: order.topup.id }, 300, "USD", { providerPaymentId: payId })]);
    const payment = p.listPayments({ orgId: org }).find((x) => x.providerPaymentId === payId)!;
    refundCalls.length = 0;
    refundBehaviour = "reject";
    await fails(() => p.refundPayment({ paymentId: payment.id, reason: "the provider says no", requestedBy: "admin" }), /did not accept the refund: insufficient balance/);
    assert.equal(p.getPayment(payment.id)!.status, "succeeded", "the books did not change");
    assert.equal(p.listRefunds(payment.id)[0]!.status, "failed");
    const before = c.getWallet(org).balanceUnits;
    refundBehaviour = "ok";
    const refund = await p.refundPayment({ paymentId: payment.id, reason: "now it works", requestedBy: "admin" });
    assert.equal(refundCalls.at(-1)!.providerPaymentId, payId);
    assert.equal(refundCalls.at(-1)!.amountMinor, 300);
    assert.equal(refund.providerRefundId, `re_${refund.id}`);
    assert.equal(c.getWallet(org).balanceUnits, before - 100_000);
    // The provider then tells us about the refund it just made: recognised, not applied again.
    const note = await send([{ type: "refund.succeeded", eventId: uid("evt"), providerPaymentId: payId, providerRefundId: refund.providerRefundId!, amountMinor: 300 }]);
    assert.equal(note.processed, 1);
    assert.equal(p.listRefunds(payment.id).filter((r) => r.status === "succeeded").length, 1, "still one refund");
    assert.equal(c.getWallet(org).balanceUnits, before - 100_000);
    await reconciled();
  });
  it("the manual provider never calls a provider: the money is returned outside the system", async () => {
    const { p } = await mods();
    refundCalls.length = 0;
    const t = await paidTopup();
    await p.refundPayment({ paymentId: t.payment.id, reason: "returned by bank transfer", requestedBy: "admin" });
    assert.equal(refundCalls.length, 0);
  });
  it("two refunds started at once for the same payment cannot both take the same money", async () => {
    const { p } = await mods();
    const org = await newOrg();
    const order = p.createTopupOrder({ orgId: org, packageId: "pkg_100", currency: "USD", provider: "testpay", now: T0 });
    const payId = uid("pay");
    await send([succeed({ kind: "topup", topupId: order.topup.id }, 300, "USD", { providerPaymentId: payId })]);
    const payment = p.listPayments({ orgId: org }).find((x) => x.providerPaymentId === payId)!;
    refundBehaviour = "slow";
    try {
      const results = await Promise.allSettled([
        p.refundPayment({ paymentId: payment.id, reason: "first request", requestedBy: "admin" }),
        p.refundPayment({ paymentId: payment.id, reason: "second request", requestedBy: "admin" }),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
      assert.equal(p.getPayment(payment.id)!.refundedMinor, 300, "refunded once, not twice");
    } finally { refundBehaviour = "ok"; }
    await reconciled();
  });
  it("a refund the provider made on its own is recorded once, with the credits taken back; an unknown payment is a failed notice", async () => {
    const { p, c } = await mods();
    const org = await newOrg();
    const order = p.createTopupOrder({ orgId: org, packageId: "pkg_500", currency: "USD", provider: "testpay", now: T0 });
    const payId = uid("pay");
    await send([succeed({ kind: "topup", topupId: order.topup.id }, 1400, "USD", { providerPaymentId: payId })]);
    const base = c.getWallet(org).balanceUnits;
    const refundEvent: PaymentEvent = { type: "refund.succeeded", eventId: uid("evt"), providerPaymentId: payId, providerRefundId: uid("re"), amountMinor: 700, reason: "from the dashboard" };
    await send([refundEvent]);
    await send([{ ...refundEvent, eventId: uid("evt") } as PaymentEvent]); // the same refund announced again
    const payment = p.listPayments({ orgId: org }).find((x) => x.providerPaymentId === payId)!;
    assert.deepEqual([payment.refundedMinor, payment.status], [700, "partially_refunded"]);
    assert.equal(c.getWallet(org).balanceUnits, base - 250_000, "half of 500 credits taken back, once");
    const lost = await send([{ type: "refund.succeeded", eventId: uid("evt"), providerPaymentId: "pay_unknown", providerRefundId: uid("re"), amountMinor: 100 }]);
    assert.equal(lost.failed, 1);
    await reconciled();
  });
});

// =================================================================================================
describe("7. chargebacks", () => {
  async function disputedSetup() {
    const { p } = await mods();
    const org = await newOrg();
    const order = p.createTopupOrder({ orgId: org, packageId: "pkg_100", currency: "USD", provider: "testpay", now: T0 });
    const payId = uid("pay");
    await send([succeed({ kind: "topup", topupId: order.topup.id }, 300, "USD", { providerPaymentId: payId })]);
    return { org, payId, payment: p.listPayments({ orgId: org }).find((x) => x.providerPaymentId === payId)! };
  }
  const dispute = (type: "dispute.opened" | "dispute.won" | "dispute.lost", providerPaymentId: string): PaymentEvent => ({ type, eventId: uid("evt"), providerPaymentId });

  it("an opened dispute marks the payment, which cannot be refunded meanwhile; winning restores it", async () => {
    const { p } = await mods();
    const d = await disputedSetup();
    await send([dispute("dispute.opened", d.payId)]);
    assert.equal(p.getPayment(d.payment.id)!.status, "disputed");
    await fails(() => p.refundPayment({ paymentId: d.payment.id, reason: "during a dispute", requestedBy: "admin" }), /Only a successful payment/);
    await send([dispute("dispute.won", d.payId)]);
    assert.equal(p.getPayment(d.payment.id)!.status, "succeeded");
  });
  it("losing a dispute counts as a full refund and takes the unspent credits back", async () => {
    const { p, c } = await mods();
    const d = await disputedSetup();
    const base = c.getWallet(d.org).balanceUnits;
    await send([dispute("dispute.opened", d.payId), dispute("dispute.lost", d.payId)]);
    const payment = p.getPayment(d.payment.id)!;
    assert.deepEqual([payment.status, payment.refundedMinor], ["refunded", 300]);
    assert.equal(c.getWallet(d.org).balanceUnits, base - 100_000);
    const refund = p.listRefunds(payment.id)[0]!;
    assert.match(refund.reason, /Chargeback/);
    await send([dispute("dispute.lost", d.payId)]);
    assert.equal(p.listRefunds(payment.id).length, 1, "a repeated notice refunds nothing more");
    await reconciled();
  });
  it("a dispute for a payment this system does not know is a failed notice", async () => {
    const r = await send([dispute("dispute.opened", "pay_unknown")]);
    assert.equal(r.failed, 1);
  });
});

// =================================================================================================
describe("8. the HTTP doors", () => {
  type Init = { method?: string; body?: string | object; cookie?: string; headers?: Record<string, string> };
  function req(url: string, init: Init = {}): NextRequest {
    const headers: Record<string, string> = { host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-for": `10.7.0.${++seq % 250}`, ...(init.headers ?? {}) };
    if (init.cookie) headers.cookie = init.cookie;
    const raw = typeof init.body === "string" ? init.body : init.body === undefined ? undefined : JSON.stringify(init.body);
    if (raw !== undefined && typeof init.body !== "string") headers["content-type"] = "application/json";
    return new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers, body: raw });
  }
  const admin = { authorization: `Bearer ${ADMIN}` };
  async function customer(name: string, role?: string, orgId?: string) {
    const users = await import("@/app/api/admin/users/route");
    const login = await import("@/app/api/auth/login/route");
    const email = `${role ?? "owner"}@${name}.example`;
    const made = await users.POST(req("/api/admin/users", { method: "POST", headers: admin, body: orgId ? { email, name: email, password: PASSWORD, orgId, role } : { email, name: email, password: PASSWORD, newOrg: { name, type: "agency" } } }));
    assert.equal(made.status, 200, await made.clone().text());
    const org = (await made.json()).organization.id as string;
    const res = await login.POST(req("/api/auth/login", { method: "POST", body: { email, password: PASSWORD } }));
    return { org, cookie: `silpi_session=${/silpi_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]}` };
  }
  const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });

  it("the webhook address needs no sign-in but a valid signature; it answers 401, 404, 400 and 413 as it should", async () => {
    const route = await import("@/app/api/webhooks/[provider]/route");
    const { s } = await mods();
    const { invoice } = await openInvoice();
    const n = signed([succeed({ kind: "invoice", invoiceId: invoice.id }, 1900, "USD")]);
    const post = (provider: string, body: string, headers: Record<string, string> = {}) => route.POST(req(`/api/webhooks/${provider}`, { method: "POST", body, headers }), ctx(provider));
    assert.equal((await post("testpay", n.body)).status, 401, "no signature");
    assert.equal((await post("testpay", n.body, { "x-test-signature": "bad" })).status, 401);
    assert.equal(s.getInvoice(invoice.id)!.status, "open");
    assert.equal((await post("unknown-provider", n.body, n.headers)).status, 404);
    assert.equal((await post("testpay", "", n.headers)).status, 400);
    assert.equal((await post("testpay", "x".repeat(300_000), n.headers)).status, 413);
    const ok = await post("testpay", n.body, n.headers);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).processed, 1);
    assert.equal(s.getInvoice(invoice.id)!.status, "paid");
    assert.equal("GET" in route, false, "it accepts notices (POST) and nothing else");
  });
  it("the administrator's payment tools need the token and work", async () => {
    const list = await import("@/app/api/admin/payments/route");
    const record = await import("@/app/api/admin/payments/record/route");
    const refund = await import("@/app/api/admin/payments/refund/route");
    const events = await import("@/app/api/admin/webhook-events/route");
    const packages = await import("@/app/api/admin/credit-packages/route");
    const prices = await import("@/app/api/admin/credit-packages/prices/route");
    const { p } = await mods();
    for (const call of [() => list.GET(req("/api/admin/payments")), () => record.POST(req("/api/admin/payments/record", { method: "POST", body: {} })), () => refund.POST(req("/api/admin/payments/refund", { method: "POST", body: {} })), () => events.GET(req("/api/admin/webhook-events")), () => packages.GET(req("/api/admin/credit-packages")), () => packages.PUT(req("/api/admin/credit-packages", { method: "PUT", body: {} })), () => prices.PUT(req("/api/admin/credit-packages/prices", { method: "PUT", body: {} }))]) assert.equal((await call()).status, 401);
    const order = p.createTopupOrder({ orgId: await newOrg(), packageId: "pkg_100", currency: "USD", now: T0 });
    const rec = await record.POST(req("/api/admin/payments/record", { method: "POST", headers: admin, body: { topupId: order.topup.id, reference: "UPI-API-1", amountMinor: 300 } }));
    assert.equal(rec.status, 200);
    const paymentId = (await rec.json()).payment.id as string;
    assert.equal((await record.POST(req("/api/admin/payments/record", { method: "POST", headers: admin, body: { topupId: order.topup.id, reference: "UPI-API-2" } }))).status, 400, "already paid");
    const ref = await refund.POST(req("/api/admin/payments/refund", { method: "POST", headers: admin, body: { paymentId, amountMinor: 100, reason: "api refund", idempotencyKey: "api-refund-key-1" } }));
    assert.equal(ref.status, 200);
    assert.equal((await ref.json()).payment.status, "partially_refunded");
    assert.equal((await refund.POST(req("/api/admin/payments/refund", { method: "POST", headers: admin, body: { paymentId, amountMinor: 99_999, reason: "too much" } }))).status, 400);
    const listed = await (await list.GET(req(`/api/admin/payments?orgId=${order.topup.orgId}`, { headers: admin }))).json();
    assert.equal(listed.payments[0].refunds.length, 1);
    const seen = await (await events.GET(req("/api/admin/webhook-events", { headers: admin }))).json();
    assert.ok(seen.providers.some((x: { id: string; webhook: boolean }) => x.id === "testpay" && x.webhook === true) && seen.providers.some((x: { id: string }) => x.id === "manual"));
    assert.equal((await packages.PUT(req("/api/admin/credit-packages", { method: "PUT", headers: admin, body: { id: "pkg_api", name: "API pack", credits: 75 } }))).status, 200);
    assert.equal((await prices.PUT(req("/api/admin/credit-packages/prices", { method: "PUT", headers: admin, body: { packageId: "pkg_api", currency: "USD", amountMinor: 250 } }))).status, 200);
    assert.equal((await prices.PUT(req("/api/admin/credit-packages/prices", { method: "PUT", headers: admin, body: { packageId: "pkg_api", currency: "USD", amountMinor: -1 } }))).status, 400);
  });
  it("the existing manual invoice route still works, and now leaves a payment record", async () => {
    const invoices = await import("@/app/api/admin/invoices/route");
    const { p } = await mods();
    const { org, invoice } = await openInvoice();
    const res = await invoices.POST(req("/api/admin/invoices", { method: "POST", headers: admin, body: { invoiceId: invoice.id, providerRef: "UPI-LEGACY-1" } }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual([body.invoice.status, body.subscription.status, body.payment.status], ["paid", "active", "succeeded"]);
    assert.equal(p.listPayments({ orgId: org }).length, 1);
    assert.equal((await invoices.POST(req("/api/admin/invoices", { method: "POST", headers: admin, body: { invoiceId: invoice.id, providerRef: "UPI-LEGACY-1" } }))).status, 200, "the same reference again is harmless");
    assert.equal((await invoices.POST(req("/api/admin/invoices", { method: "POST", headers: admin, body: { invoiceId: invoice.id, providerRef: "UPI-LEGACY-2" } }))).status, 400, "a different one is refused");
  });
  it("a customer orders credits through their own route: owners and admins only, their own organization only, and the credits come only when payment is confirmed", async () => {
    const route = await import("@/app/api/workspace/billing/topup/route");
    const { c, p } = await mods();
    const owner = await customer("topup-api");
    const viewer = await customer("topup-api", "viewer", owner.org);
    const stranger = await customer("topup-other");
    const order = (cookie: string, body: object) => route.POST(req("/api/workspace/billing/topup", { method: "POST", cookie, body }));
    assert.equal((await route.POST(req("/api/workspace/billing/topup", { method: "POST", body: { packageId: "pkg_100", currency: "USD" } }))).status, 401);
    assert.equal((await order(viewer.cookie, { packageId: "pkg_100", currency: "USD" })).status, 403, "a viewer may not buy credits");
    assert.equal((await order(owner.cookie, { packageId: "pkg_100" })).status, 400);
    const before = c.getWallet(owner.org).balanceUnits;
    const made = await order(owner.cookie, { packageId: "pkg_100", currency: "USD" });
    assert.equal(made.status, 200);
    const { topup } = await made.json();
    assert.equal(c.getWallet(owner.org).balanceUnits, before, "ordering gave no credits");
    const mine = await (await route.GET(req("/api/workspace/billing/topup", { cookie: owner.cookie }))).json();
    assert.ok(mine.topups.some((t: { id: string }) => t.id === topup.id) && mine.packages.length >= 4);
    const theirs = await (await route.GET(req("/api/workspace/billing/topup", { cookie: stranger.cookie }))).json();
    assert.ok(theirs.topups.every((t: { id: string }) => t.id !== topup.id), "another organization cannot see it");
    assert.equal((await route.DELETE(req(`/api/workspace/billing/topup?id=${topup.id}`, { method: "DELETE", cookie: stranger.cookie }))).status, 400, "nor cancel it");
    p.recordManualPayment({ topupId: topup.id, reference: "UPI-CUST-1", now: T0 });
    assert.equal(c.getWallet(owner.org).balanceUnits, before + 100_000, "the credits came when the payment was recorded");
  });
  it("the public price list includes the packs of credits", async () => {
    const route = await import("@/app/api/plans/route");
    const body = await (await route.GET(req("/api/plans"))).json();
    const sizes = body.creditPackages.map((x: { creditUnits: number }) => x.creditUnits / 1000);
    for (const n of [100, 250, 500, 1000]) assert.ok(sizes.includes(n), `the ${n}-credit pack is listed`);
  });
});

// =================================================================================================
describe("9. the whole ledger still balances", () => {
  it("after everything above, wallets agree with the ledger and the buckets agree with both", async () => {
    await reconciled();
  });
  it("the agency's own payments table is untouched by the new one", async () => {
    const { db } = await mods();
    const columns = (db.getDb().prepare("PRAGMA table_info(payments)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(columns.includes("lead_id"), "the agency's table is still the agency's");
    assert.ok(!columns.includes("provider"), "and does not carry the new provider column");
  });
});

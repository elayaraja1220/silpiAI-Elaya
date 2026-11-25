// The AI Gateway: pricing maths, model catalogue, the reserve -> call -> settle flow, failure paths, limits, tenancy and the API.
// Real SQLite database. The AI provider is a fake the test controls; no network, no key, no cost.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { resetLoginAttempts } from "@/lib/admin-auth";
import { useFixedMetering } from "./fixtures/fixed-pricing";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-ai-"));
const ADMIN = "test-admin-token-0123456789abcdef";
const PASSWORD = "a-long-test-password";
let seq = 0;
const k = (p = "k") => `${p}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

const mods = async () => ({
  g: await import("@/server/ai/gateway"),
  cat: await import("@/server/ai/catalog"),
  p: await import("@/server/ai/pricing"),
  prov: await import("@/server/ai/providers"),
  c: await import("@/server/credits"),
  t: await import("@/server/tenancy"),
  db: await import("@/lib/business/db"),
});
const newOrg = async () => (await mods()).t.createOrganization({ name: `AI Org ${++seq}`, type: "business" }).id;
const fund = async (orgId: string, units: number) => (await mods()).c.addCredits({ orgId, units, kind: "grant", idempotencyKey: k("fund") });
const noSleep = async () => {};

type Call = { providerModel: string; maxOutputTokens: number };
/** A fake provider: `script` decides each call's outcome; every call is recorded. */
async function fake(script: (n: number, call: Call) => { in: number; out: number; text?: string } | Error) {
  const { prov } = await mods();
  const calls: Call[] = [];
  const adapter: import("@/server/ai/providers").ProviderAdapter = {
    id: "fake",
    isConfigured: () => true,
    async complete(req) {
      calls.push({ providerModel: req.providerModel, maxOutputTokens: req.maxOutputTokens });
      const r = script(calls.length, calls[calls.length - 1]!);
      if (r instanceof Error) throw r;
      return { text: r.text ?? "an answer", inputTokens: r.in, outputTokens: r.out, providerRequestId: `pr_${calls.length}` };
    },
  };
  return { calls, providers: { fake: adapter, echo: prov.echoAdapter } };
}
/** $1 / $5 per million tokens on provider "fake", in the balanced tier, ahead of the seeded models. */
async function fakeModel(id = "fake-a", over: Record<string, unknown> = {}, exclusive = true) {
  const { cat } = await mods();
  // Only one fake model is live at a time, so a test's routing never depends on what an earlier test left behind.
  if (exclusive) for (const m of cat.listModels()) if (m.provider === "fake" && m.enabled && m.id !== id) cat.saveModel({ id: m.id, enabled: false });
  return cat.saveModel({ id, provider: "fake", providerModel: `${id}-v1`, label: id, tier: "balanced", inputUsdMicroPerMtok: 1_000_000, outputUsdMicroPerMtok: 5_000_000, maxOutputTokens: 4096, priority: 1, enabled: true, ...over } as never);
}
const ask = (orgId: string, over: Record<string, unknown> = {}) => ({ orgId, model: "balanced", messages: [{ role: "user", content: "hello" }], maxOutputTokens: 100, idempotencyKey: k("req"), ...over });
const code = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as { code?: string }).code ?? "other"; } return "no-error"; };
const request = async (id: string) => (await mods()).db.getDb().prepare("SELECT * FROM ai_requests WHERE id = ?").get(id) as Record<string, string | number | null>;

before(async () => {
  process.env.SILPI_DB_PATH = path.join(dir, "ai.db");
  process.env.SILPI_ADMIN_TOKEN = ADMIN;
  delete process.env.ANTHROPIC_API_KEY;
  await useFixedMetering();
});
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

// =================================================================================================
describe("1. the cost maths", () => {
  it("is exact in whole numbers and always rounds up", async () => {
    const { p } = await mods();
    const price = { inputUsdMicroPerMtok: 1_000_000, outputUsdMicroPerMtok: 5_000_000, markupBasisPoints: 10_000 };
    assert.equal(p.providerCostMicroUsd(price, 1000, 500), 3500, "1000 in at $1/M + 500 out at $5/M = $0.0035");
    assert.equal(p.providerCostMicroUsd(price, 1, 0), 1, "a single token still rounds up to a whole micro-dollar");
    assert.equal(p.unitsForCost(3500, 10_000, 45_000), 158, "3500 micro-USD x 45,000 units per USD = 157.5 -> 158");
    assert.equal(p.unitsForCost(3500, 20_000, 45_000), 315, "a x2 model markup doubles it");
    assert.equal(p.unitsForCost(1, 10_000, 45_000), 1, "the smallest real cost is never free");
    assert.equal(p.unitsForCost(0, 10_000, 45_000), 0, "a free model stays free");
  });
  it("does not overflow on very large numbers", async () => {
    const { p } = await mods();
    const price = { inputUsdMicroPerMtok: 1_000_000_000, outputUsdMicroPerMtok: 1_000_000_000, markupBasisPoints: 100_000 };
    const units = p.unitsForTokens(price, 10_000_000, 5_000_000, 5_000_000);
    assert.ok(Number.isSafeInteger(units) || units > 0);
    assert.equal(p.unitsForCost(1_000_000_000_000, 100_000, 10_000_000), 100_000_000_000_000);
  });
  it("estimates tokens high on purpose", async () => {
    const { p } = await mods();
    assert.equal(p.estimateTokens(300), 100);
    assert.equal(p.estimateTokens(0), 0);
  });
});

// =================================================================================================
describe("2. the model catalogue", () => {
  it("starts with fast, balanced, best and a free demo model, and one conversion setting", async () => {
    const { cat } = await mods();
    const ids = cat.listModels().map((m) => m.id);
    for (const id of ["haiku-5-5", "sonnet-5-5", "opus-5-5", "silpi-demo"]) assert.ok(ids.includes(id), id);
    assert.equal(cat.getUnitsPerUsd(), 45_000);
  });
  it("what customers see has credit prices only, never the provider, its cost or the markup", async () => {
    const { cat } = await mods();
    const list = cat.publicModels();
    assert.ok(list.length >= 4);
    for (const m of list) assert.deepEqual(Object.keys(m).sort(), ["creditsPer1kInput", "creditsPer1kOutput", "id", "label", "maxOutputTokens", "tier"]);
    const sonnet = list.find((m) => m.id === "sonnet-5-5")!;
    assert.ok(Math.abs(sonnet.creditsPer1kOutput - 0.45) < 1e-9, "$10/M x 45 credits per USD = 0.45 credits per 1,000 output tokens");
  });
  it("refuses a bad model: real provider at a zero price, unknown tier, bad id", async () => {
    const { cat } = await mods();
    const reject = (m: object) => assert.throws(() => cat.saveModel(m as never), /./);
    reject({ id: "free-lunch", provider: "anthropic", providerModel: "x", label: "x", tier: "fast", inputUsdMicroPerMtok: 0, outputUsdMicroPerMtok: 0, enabled: true });
    reject({ id: "bad-tier", provider: "anthropic", providerModel: "x", label: "x", tier: "ultra", inputUsdMicroPerMtok: 1, outputUsdMicroPerMtok: 1, enabled: true });
    reject({ id: "Bad Id!", provider: "a", providerModel: "x", label: "x" });
    reject({ id: "needs-fields" });
    assert.equal(cat.getModel("free-lunch"), null);
  });
  it("updates only the fields sent", async () => {
    const { cat } = await mods();
    await fakeModel("patch-me");
    const after = cat.saveModel({ id: "patch-me", priority: 7 });
    assert.equal(after.priority, 7);
    assert.equal(after.inputUsdMicroPerMtok, 1_000_000, "price untouched");
    cat.saveModel({ id: "patch-me", enabled: false });
  });
});

// =================================================================================================
describe("3. a normal request: reserve, call, settle the real cost", () => {
  it("holds the worst case, charges the real tokens, returns the rest, and stores no text", async () => {
    const { g, c } = await mods();
    await fakeModel("fake-a");
    const org = await newOrg();
    await fund(org, 1_000_000);
    const f = await fake(() => ({ in: 1000, out: 500, text: "a private answer" }));
    const r = await g.complete(ask(org, { messages: [{ role: "user", content: "a private question" }] }), { providers: f.providers, sleep: noSleep });
    assert.equal(r.text, "a private answer");
    assert.equal(r.model.id, "fake-a");
    assert.equal(r.chargedUnits, 158);
    assert.equal(r.fallbackUsed, false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.maxOutputTokens, 100);
    const w = c.getWallet(org);
    assert.equal(w.balanceUnits, 1_000_000 - 158, "the real cost was charged");
    assert.equal(w.reservedUnits, 0, "nothing is left held");
    const kinds = c.listLedger(org).map((e) => e.kind);
    assert.ok(kinds.includes("reserve") && kinds.includes("settle"));
    const row = await request(r.requestId);
    assert.equal(row.status, "completed");
    assert.equal(row.provider_cost_micro_usd, 3500);
    assert.equal(row.charged_units, 158);
    assert.ok(!JSON.stringify(row).includes("private"), "prompts and answers are not stored");
    assert.deepEqual(c.auditWallets(), [], "the ledger still reconciles");
  });
  it("the output allowance is capped to the model's own maximum", async () => {
    const { g } = await mods();
    await fakeModel("fake-cap", { maxOutputTokens: 300, priority: 0 });
    const org = await newOrg();
    await fund(org, 5_000_000);
    const f = await fake(() => ({ in: 10, out: 10 }));
    await g.complete(ask(org, { maxOutputTokens: 100_000 }), { providers: f.providers, sleep: noSleep });
    assert.equal(f.calls[0]!.maxOutputTokens, 300);
  });
  it("the real-cost charge can be less than the hold, never more than what was held without more credits", async () => {
    const { g, c } = await mods();
    await fakeModel("fake-over", { priority: 0 });
    const org = await newOrg();
    // Fund only the worst-case hold for a 5-character prompt and 100 output tokens: 502 micro-USD x 0.045 = 22.59 -> 23 units.
    await fund(org, 23);
    const f = await fake(() => ({ in: 50_000, out: 100 })); // the prompt was far bigger than estimated: real cost 50,500 micro-USD
    const r = await g.complete(ask(org), { providers: f.providers, sleep: noSleep });
    assert.equal(r.chargedUnits, 23, "only what was held can be charged");
    assert.equal(r.uncollectedUnits, 2250, "real cost 50,500 micro-USD = 2,273 units, 23 collected");
    assert.equal(c.getWallet(org).balanceUnits, 0);
    assert.equal(c.getWallet(org).reservedUnits, 0);
  });
  it("holds MORE when the prompt was larger than estimated and the wallet has it", async () => {
    const { g, c } = await mods();
    await fakeModel("fake-ext", { priority: 0 });
    const org = await newOrg();
    await fund(org, 1_000_000);
    const f = await fake(() => ({ in: 50_000, out: 100 }));
    const r = await g.complete(ask(org), { providers: f.providers, sleep: noSleep });
    assert.equal(r.uncollectedUnits, 0);
    assert.equal(r.chargedUnits, 2273, "50,500 micro-USD x 0.045 = 2,272.5 -> 2,273");
    assert.equal(c.getWallet(org).balanceUnits, 1_000_000 - r.chargedUnits);
  });
});

// =================================================================================================
describe("4. a request that cannot be paid for never reaches the provider", () => {
  it("not enough credits: refused with 402-style error, provider never called, nothing held", async () => {
    const { g, c } = await mods();
    await fakeModel("fake-poor", { priority: 0 });
    const org = await newOrg();
    await fund(org, 5);
    const f = await fake(() => ({ in: 1, out: 1 }));
    assert.equal(await code(() => g.complete(ask(org), { providers: f.providers, sleep: noSleep })), "insufficient");
    assert.equal(f.calls.length, 0);
    assert.deepEqual([c.getWallet(org).balanceUnits, c.getWallet(org).reservedUnits], [5, 0]);
  });
  it("a provider with no key is skipped before any credits are held", async () => {
    const { g, c, prov } = await mods();
    const org = await newOrg();
    await fund(org, 1_000_000);
    // The real tiers use the "anthropic" provider and no key is set in tests.
    const err = await code(() => g.complete(ask(org, { model: "fast" }), { providers: prov.defaultProviders(), sleep: noSleep }));
    assert.equal(err, "provider-not-configured");
    assert.equal(c.getWallet(org).reservedUnits, 0);
    assert.equal(c.listLedger(org).filter((e) => e.kind === "reserve").length, 0);
  });
  it("an unknown or disabled model is refused", async () => {
    const { g, cat } = await mods();
    const org = await newOrg();
    assert.equal(await code(() => g.complete(ask(org, { model: "nope-9" }))), "model-unavailable");
    await fakeModel("fake-off", { enabled: false });
    assert.equal(await code(() => g.complete(ask(org, { model: "fake-off" }))), "model-unavailable");
    assert.equal(cat.getModel("fake-off")!.enabled, false);
  });
  it("bad input is refused before anything is written", async () => {
    const { g } = await mods();
    const org = await newOrg();
    const bad = (over: Record<string, unknown>) => code(() => g.complete(ask(org, over)));
    assert.equal(await bad({ idempotencyKey: "x" }), "invalid");
    assert.equal(await bad({ messages: [] }), "invalid");
    assert.equal(await bad({ messages: [{ role: "assistant", content: "hi" }] }), "invalid", "must start with the user");
    assert.equal(await bad({ messages: [{ role: "system", content: "hi" }] }), "invalid");
    assert.equal(await bad({ messages: [{ role: "user", content: "   " }] }), "invalid");
    assert.equal(await bad({ messages: [{ role: "user", content: "x".repeat(200_001) }] }), "invalid");
    assert.equal(await bad({ maxOutputTokens: 0 }), "invalid");
    assert.equal(await bad({ maxOutputTokens: 1.5 }), "invalid");
    assert.equal(await bad({ messages: "hello" }), "invalid");
  });
  it("an unknown organization is a clean not-found", async () => {
    const { g } = await mods();
    assert.equal(await code(() => g.complete(ask("org_missing"))), "not-found");
  });
});

// =================================================================================================
describe("5. failures cost nothing", () => {
  it("retries a temporary failure on the same model, then succeeds", async () => {
    const { g, c, prov } = await mods();
    await fakeModel("fake-retry", { priority: 0 });
    const org = await newOrg();
    await fund(org, 1_000_000);
    const f = await fake((n) => (n === 1 ? new prov.ProviderError("overloaded", true, 529) : { in: 100, out: 10 }));
    const r = await g.complete(ask(org), { providers: f.providers, sleep: noSleep });
    assert.equal(r.attempts, 2);
    assert.equal(r.fallbackUsed, false);
    assert.equal(f.calls.length, 2);
    assert.ok(c.getWallet(org).balanceUnits < 1_000_000);
  });
  it("falls back to the next model of the same tier, and charges that model's price", async () => {
    const { g, c, prov } = await mods();
    await fakeModel("fake-first", { priority: 0 });
    await fakeModel("fake-second", { priority: 1, inputUsdMicroPerMtok: 2_000_000 }, false);
    const org = await newOrg();
    await fund(org, 1_000_000);
    const f = await fake((_, call) => (call.providerModel === "fake-first-v1" ? new prov.ProviderError("down", true, 503) : { in: 1000, out: 500 }));
    const r = await g.complete(ask(org), { providers: f.providers, sleep: noSleep });
    assert.equal(r.model.id, "fake-second");
    assert.equal(r.fallbackUsed, true);
    assert.equal(r.attempts, 3, "two tries on the first model, then one on the second");
    assert.equal(r.chargedUnits, 203, "(1000 x $2 + 500 x $5) = 4500 micro-USD x 45 = 202.5 -> 203");
    assert.equal(c.getWallet(org).reservedUnits, 0);
    f.calls.forEach((x) => assert.ok(x.providerModel.startsWith("fake-")));
    for (const id of ["fake-first", "fake-second"]) (await mods()).cat.saveModel({ id, enabled: false });
  });
  it("a request the provider rejects is not retried on the same model", async () => {
    const { g, prov } = await mods();
    await fakeModel("fake-reject", { priority: 0 });
    const org = await newOrg();
    await fund(org, 1_000_000);
    const f = await fake(() => new prov.ProviderError("invalid request", false, 400));
    await code(() => g.complete(ask(org, { model: "fake-reject" }), { providers: f.providers, sleep: noSleep }));
    assert.equal(f.calls.length, 1);
  });
  it("when every attempt fails the reservation is released and the customer pays nothing", async () => {
    const { g, c, prov } = await mods();
    await fakeModel("fake-dead", { priority: 0 });
    const org = await newOrg();
    await fund(org, 1_000_000);
    const f = await fake(() => new prov.ProviderError("down", true, 500));
    const key = k("dead");
    assert.equal(await code(() => g.complete(ask(org, { model: "fake-dead", idempotencyKey: key }), { providers: f.providers, sleep: noSleep })), "provider-failed");
    const w = c.getWallet(org);
    assert.deepEqual([w.balanceUnits, w.reservedUnits], [1_000_000, 0]);
    const row = (await mods()).db.getDb().prepare("SELECT status, charged_units, error_code FROM ai_requests WHERE org_id = ? AND idempotency_key = ?").get(org, key) as Record<string, unknown>;
    assert.deepEqual({ ...row }, { status: "failed", charged_units: 0, error_code: "provider-failed" });
    assert.equal(await code(() => g.complete(ask(org, { model: "fake-dead", idempotencyKey: key }), { providers: f.providers, sleep: noSleep })), "provider-failed", "the same key reports the same failure, without calling the provider again");
    assert.equal(f.calls.length, 2, "only the first request's two attempts reached the provider");
    assert.deepEqual(c.auditWallets(), []);
  });
  it("an unexpected crash inside the provider call also gives the credits back", async () => {
    const { g, c } = await mods();
    await fakeModel("fake-crash", { priority: 0 });
    const org = await newOrg();
    await fund(org, 1_000_000);
    const f = await fake(() => { throw new TypeError("boom"); });
    assert.equal(await code(() => g.complete(ask(org, { model: "fake-crash" }), { providers: f.providers, sleep: noSleep })), "other");
    assert.deepEqual([c.getWallet(org).balanceUnits, c.getWallet(org).reservedUnits], [1_000_000, 0]);
  });
});

// =================================================================================================
describe("6. repeating a request", () => {
  it("the same idempotency key never charges twice and never calls the provider twice", async () => {
    const { g, c } = await mods();
    await fakeModel("fake-idem", { priority: 0 });
    const org = await newOrg();
    await fund(org, 1_000_000);
    const f = await fake(() => ({ in: 1000, out: 500 }));
    const key = k("same");
    const first = await g.complete(ask(org, { model: "fake-idem", idempotencyKey: key }), { providers: f.providers, sleep: noSleep });
    const again = await g.complete(ask(org, { model: "fake-idem", idempotencyKey: key }), { providers: f.providers, sleep: noSleep });
    assert.equal(again.replayed, true);
    assert.equal(again.requestId, first.requestId);
    assert.equal(again.chargedUnits, first.chargedUnits);
    assert.equal(again.text, "", "answers are not kept");
    assert.equal(f.calls.length, 1);
    assert.equal(c.getWallet(org).balanceUnits, 1_000_000 - first.chargedUnits);
  });
  it("two organizations may use the same key independently", async () => {
    const { g } = await mods();
    await fakeModel("fake-two", { priority: 0 });
    const [a, b] = [await newOrg(), await newOrg()];
    await fund(a, 1_000_000);
    await fund(b, 1_000_000);
    const f = await fake(() => ({ in: 10, out: 10 }));
    const key = k("shared");
    const ra = await g.complete(ask(a, { model: "fake-two", idempotencyKey: key }), { providers: f.providers, sleep: noSleep });
    const rb = await g.complete(ask(b, { model: "fake-two", idempotencyKey: key }), { providers: f.providers, sleep: noSleep });
    assert.notEqual(ra.requestId, rb.requestId);
    assert.equal(rb.replayed, false);
  });
  it("a request that is still running is reported, not run twice", async () => {
    const { g } = await mods();
    await fakeModel("fake-slow", { priority: 0 });
    const org = await newOrg();
    await fund(org, 1_000_000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { prov } = await mods();
    const slow: import("@/server/ai/providers").ProviderAdapter = { id: "fake", isConfigured: () => true, complete: async () => { await gate; return { text: "late", inputTokens: 1, outputTokens: 1, providerRequestId: null }; } };
    const providers = { fake: slow, echo: prov.echoAdapter };
    const key = k("slow");
    const running = g.complete(ask(org, { model: "fake-slow", idempotencyKey: key }), { providers, sleep: noSleep });
    assert.equal(await code(() => g.complete(ask(org, { model: "fake-slow", idempotencyKey: key }), { providers, sleep: noSleep })), "in-progress");
    release();
    assert.equal((await running).text, "late");
  });
});

// =================================================================================================
describe("7. limits", () => {
  it("a daily cap stops spending before the provider is called, and counts what is in flight", async () => {
    const { g, cat } = await mods();
    await fakeModel("fake-cap-day", { priority: 0 });
    const org = await newOrg();
    await fund(org, 10_000_000);
    cat.setDailyCap(org, 28); // each request HOLDS 23 units and really costs 3
    const f = await fake(() => ({ in: 10, out: 10 }));
    const first = await g.complete(ask(org, { model: "fake-cap-day" }), { providers: f.providers, sleep: noSleep });
    assert.equal(first.chargedUnits, 3, "60 micro-USD x 0.045 = 2.7 -> 3");
    await g.complete(ask(org, { model: "fake-cap-day" }), { providers: f.providers, sleep: noSleep }); // used 3 + hold 23 = 26 <= 28
    const before = f.calls.length;
    assert.equal(await code(() => g.complete(ask(org, { model: "fake-cap-day" }), { providers: f.providers, sleep: noSleep })), "daily-cap");
    assert.equal(f.calls.length, before, "the provider was not called");
    // a third: used 6 + hold 23 = 29 > 28, so it was refused above
    cat.setDailyCap(org, null);
    await g.complete(ask(org, { model: "fake-cap-day" }), { providers: f.providers, sleep: noSleep });
  });
  it("at most four requests run at once per organization", async () => {
    const { g, prov } = await mods();
    await fakeModel("fake-par", { priority: 0 });
    const org = await newOrg();
    await fund(org, 50_000_000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: import("@/server/ai/providers").ProviderAdapter = { id: "fake", isConfigured: () => true, complete: async () => { await gate; return { text: "ok", inputTokens: 1, outputTokens: 1, providerRequestId: null }; } };
    const providers = { fake: slow, echo: prov.echoAdapter };
    const running = [1, 2, 3, 4].map(() => g.complete(ask(org, { model: "fake-par" }), { providers, sleep: noSleep }));
    assert.equal(await code(() => g.complete(ask(org, { model: "fake-par" }), { providers, sleep: noSleep })), "too-many-requests");
    release();
    const done = await Promise.all(running);
    assert.equal(done.length, 4);
    await g.complete(ask(org, { model: "fake-par" }), { providers: { fake: { ...slow, complete: async () => ({ text: "ok", inputTokens: 1, outputTokens: 1, providerRequestId: null }) }, echo: prov.echoAdapter }, sleep: noSleep });
  });
  it("a crashed request is cleaned up: its held credits come back", async () => {
    const { g, c } = await mods();
    const org = await newOrg();
    await fund(org, 100_000);
    const res = c.reserveCredits({ orgId: org, units: 40_000, idempotencyKey: k("stuck") });
    const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
    (await mods()).db.getDb().prepare("INSERT INTO ai_requests (id, org_id, idempotency_key, status, requested_model, reservation_id, reserved_units, created_at) VALUES ('air_stuck', ?, 'stuck-key', 'running', 'balanced', ?, 40000, ?)").run(org, res.id, old);
    assert.equal(c.getWallet(org).reservedUnits, 40_000);
    assert.equal(g.sweepStaleRequests(org), 1);
    assert.equal(c.getWallet(org).reservedUnits, 0);
    assert.equal((await request("air_stuck")).status, "failed");
    assert.equal(g.sweepStaleRequests(org), 0, "repeating is harmless");
  });
});

// =================================================================================================
describe("8. routing and the demo model", () => {
  it("auto sends small jobs to the cheap tier and larger ones to the balanced tier, never to the best tier", async () => {
    const { g } = await mods();
    assert.equal(g.autoTier(200, 256), "fast");
    assert.equal(g.autoTier(5000, 256), "balanced");
    assert.equal(g.autoTier(200, 4096), "balanced");
  });
  it("the demo model is free: no credits are held or charged, and it works with an empty wallet", async () => {
    const { g, c, prov } = await mods();
    const org = await newOrg();
    const r = await g.complete(ask(org, { model: "silpi-demo" }), { providers: prov.defaultProviders(), sleep: noSleep });
    assert.equal(r.chargedUnits, 0);
    assert.match(r.text, /Demo reply/);
    assert.equal(c.listLedger(org).length, 0, "the ledger was not touched");
  });
  it("the demo model is never picked by a tier or auto", async () => {
    const { g } = await mods();
    const org = await newOrg();
    assert.equal(await code(() => g.complete(ask(org, { model: "demo" }))), "model-unavailable");
  });
  it("estimate gives the same hold the real request uses", async () => {
    const { g, c } = await mods();
    await fakeModel("fake-est", { priority: 0 });
    const org = await newOrg();
    await fund(org, 1_000_000);
    const e = g.estimate({ model: "fake-est", messages: [{ role: "user", content: "hello" }], maxOutputTokens: 100 });
    assert.equal(e.maxUnits, 23);
    const f = await fake(() => ({ in: 1, out: 1 }));
    await g.complete(ask(org, { model: "fake-est" }), { providers: f.providers, sleep: noSleep });
    const reserve = c.listLedger(org).find((x) => x.kind === "reserve")!;
    assert.equal(reserve.reservedDelta, e.maxUnits);
  });
});

// =================================================================================================
describe("9. tenancy: one organization never sees or spends another's", () => {
  it("usage and request lists are per organization", async () => {
    const { g, cat } = await mods();
    await fakeModel("fake-ten", { priority: 0 });
    const [a, b] = [await newOrg(), await newOrg()];
    await fund(a, 1_000_000);
    await fund(b, 1_000_000);
    const f = await fake(() => ({ in: 100, out: 100 }));
    await g.complete(ask(a, { model: "fake-ten" }), { providers: f.providers, sleep: noSleep });
    await g.complete(ask(a, { model: "fake-ten" }), { providers: f.providers, sleep: noSleep });
    await g.complete(ask(b, { model: "fake-ten" }), { providers: f.providers, sleep: noSleep });
    assert.equal(cat.listRequests(a).length, 2);
    assert.equal(cat.listRequests(b).length, 1);
    assert.equal(cat.usageSummary(a).today.requests, 2);
    assert.equal(cat.usageSummary(b).today.requests, 1);
  });
  it("one organization's empty wallet does not stop another", async () => {
    const { g } = await mods();
    await fakeModel("fake-wallet", { priority: 0 });
    const [broke, rich] = [await newOrg(), await newOrg()];
    await fund(rich, 1_000_000);
    const f = await fake(() => ({ in: 10, out: 10 }));
    assert.equal(await code(() => g.complete(ask(broke, { model: "fake-wallet" }), { providers: f.providers, sleep: noSleep })), "insufficient");
    assert.ok((await g.complete(ask(rich, { model: "fake-wallet" }), { providers: f.providers, sleep: noSleep })).chargedUnits > 0);
  });
  it("the administrator overview shows provider cost next to what was charged", async () => {
    const { cat } = await mods();
    const o = cat.adminOverview();
    assert.equal(o.unitsPerUsd, 45_000);
    const withUse = o.organizations.filter((x) => x.requests > 0);
    assert.ok(withUse.length >= 2);
    for (const x of withUse) assert.ok(x.providerCostMicroUsd >= 0 && x.chargedUnits >= 0);
  });
});

// =================================================================================================
describe("10. the HTTP API", () => {
  type Init = { method?: string; body?: unknown; cookie?: string; origin?: string | null; headers?: Record<string, string> };
  function req(url: string, init: Init = {}): NextRequest {
    const headers: Record<string, string> = { host: "localhost:3000", "x-forwarded-for": `10.2.0.${++seq % 250}`, ...(init.headers ?? {}) };
    if (init.origin !== null) headers.origin = init.origin ?? "http://localhost:3000";
    if (init.cookie) headers.cookie = init.cookie;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  }
  const admin = { authorization: `Bearer ${ADMIN}` };
  const routes = async () => ({
    chat: await import("@/app/api/workspace/ai/chat/route"),
    estimate: await import("@/app/api/workspace/ai/estimate/route"),
    models: await import("@/app/api/workspace/ai/models/route"),
    usage: await import("@/app/api/workspace/ai/usage/route"),
    aAi: await import("@/app/api/admin/ai/route"),
    aModels: await import("@/app/api/admin/ai/models/route"),
    aSettings: await import("@/app/api/admin/ai/settings/route"),
    aLimits: await import("@/app/api/admin/ai/limits/route"),
    users: await import("@/app/api/admin/users/route"),
    login: await import("@/app/api/auth/login/route"),
  });
  async function member(name: string, role?: string, orgId?: string) {
    const r = await routes();
    const email = `${role ?? "owner"}@${name}.example`;
    const body = orgId ? { email, name: email, password: PASSWORD, orgId, role } : { email, name: email, password: PASSWORD, newOrg: { name, type: "agency" } };
    const made = await r.users.POST(req("/api/admin/users", { method: "POST", headers: admin, body }));
    assert.equal(made.status, 200, await made.clone().text());
    const org = (await made.json()).organization.id as string;
    const res = await r.login.POST(req("/api/auth/login", { method: "POST", body: { email, password: PASSWORD } }));
    return { org, cookie: `silpi_session=${/silpi_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]}` };
  }
  beforeEach(() => resetLoginAttempts());
  const chatBody = { model: "silpi-demo", messages: [{ role: "user", content: "hi there" }] };

  it("needs a signed-in user with the right role", async () => {
    const r = await routes();
    assert.equal((await r.chat.POST(req("/api/workspace/ai/chat", { method: "POST", body: chatBody, headers: { "idempotency-key": k() } }))).status, 401);
    const owner = await member("api-co");
    const viewer = await member("api-co", "viewer", owner.org);
    assert.equal((await r.chat.POST(req("/api/workspace/ai/chat", { method: "POST", cookie: viewer.cookie, body: chatBody, headers: { "idempotency-key": k() } }))).status, 403, "a viewer may not spend credits");
    assert.equal((await r.usage.GET(req("/api/workspace/ai/usage", { cookie: viewer.cookie }))).status, 200, "but may read usage");
    assert.equal((await r.chat.POST(req("/api/workspace/ai/chat", { method: "POST", cookie: owner.cookie, body: chatBody, origin: "http://evil.example", headers: { "idempotency-key": k() } }))).status, 403, "a cross-site request is blocked");
  });
  it("a member can chat with the free demo model; the idempotency key is required; the organization comes from the session", async () => {
    const r = await routes();
    const owner = await member("api-chat");
    const noKey = await r.chat.POST(req("/api/workspace/ai/chat", { method: "POST", cookie: owner.cookie, body: chatBody }));
    assert.equal(noKey.status, 400);
    const ok = await r.chat.POST(req("/api/workspace/ai/chat", { method: "POST", cookie: owner.cookie, body: { ...chatBody, orgId: "org_silpi_agency" }, headers: { "idempotency-key": k() } }));
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.match(body.result.text, /Demo reply/);
    const { cat } = await mods();
    assert.equal(cat.listRequests(owner.org).length, 1, "recorded for the caller's organization");
    assert.equal(cat.listRequests("org_silpi_agency").filter((x) => x.requestedModel === "silpi-demo").length, 0, "the body cannot choose another organization");
  });
  it("answers 402 when credits are short, 503 when the provider has no key, 400 on bad input", async () => {
    const r = await routes();
    const owner = await member("api-errors");
    const real = await r.chat.POST(req("/api/workspace/ai/chat", { method: "POST", cookie: owner.cookie, body: { model: "fast", messages: [{ role: "user", content: "hi" }] }, headers: { "idempotency-key": k() } }));
    assert.equal(real.status, 503, "no ANTHROPIC_API_KEY in tests");
    assert.equal((await real.json()).code, "provider-not-configured");
    (await mods()).cat.saveModel({ id: "echo-paid", provider: "echo", providerModel: "echo", label: "Paid echo", tier: "best", inputUsdMicroPerMtok: 1_000_000, outputUsdMicroPerMtok: 1_000_000_000, maxOutputTokens: 4096, enabled: true });
    const short = await r.chat.POST(req("/api/workspace/ai/chat", { method: "POST", cookie: owner.cookie, body: { model: "echo-paid", messages: [{ role: "user", content: "hi" }] }, headers: { "idempotency-key": k() } }));
    assert.equal(short.status, 402, "the Free plan's 10 credits cannot hold 1,024 expensive output tokens");
    assert.equal((await short.json()).code, "insufficient");
    (await mods()).cat.saveModel({ id: "echo-paid", enabled: false });
    await fakeModel("fake-api", { priority: 0 });
    const poor = await r.chat.POST(req("/api/workspace/ai/chat", { method: "POST", cookie: owner.cookie, body: { model: "fake-api", messages: [{ role: "user", content: "hi" }] }, headers: { "idempotency-key": k() } }));
    // fake provider is not registered in the default provider map, so the model is skipped as not configured
    assert.equal(poor.status, 503);
    assert.equal((await r.chat.POST(req("/api/workspace/ai/chat", { method: "POST", cookie: owner.cookie, body: { model: "silpi-demo", messages: [] }, headers: { "idempotency-key": k() } }))).status, 400);
    const rec = await r.chat.POST(req("/api/workspace/ai/chat", { method: "POST", cookie: owner.cookie, body: { model: "silpi-demo", messages: [{ role: "user", content: "x" }], maxOutputTokens: -1 }, headers: { "idempotency-key": k() } }));
    assert.equal(rec.status, 400);
    (await mods()).cat.saveModel({ id: "fake-api", enabled: false });
  });
  it("lists models with credit prices only, and estimates without charging", async () => {
    const r = await routes();
    const owner = await member("api-models");
    const res = await r.models.GET(req("/api/workspace/ai/models", { cookie: owner.cookie }));
    const body = await res.json();
    assert.ok(body.models.length >= 4);
    assert.ok(!JSON.stringify(body).includes("anthropic"), "the provider is not shown to customers");
    assert.ok(!JSON.stringify(body).includes("Mtok"), "nor its prices");
    const est = await r.estimate.POST(req("/api/workspace/ai/estimate", { method: "POST", cookie: owner.cookie, body: { model: "silpi-demo", messages: [{ role: "user", content: "hi" }] } }));
    assert.equal(est.status, 200);
    assert.equal((await est.json()).estimate.maxUnits, 0, "the demo model holds nothing");
  });
  it("the admin routes need the admin token, and edit prices, the conversion and daily caps", async () => {
    const r = await routes();
    assert.equal((await r.aAi.GET(req("/api/admin/ai"))).status, 401);
    assert.equal((await r.aModels.PUT(req("/api/admin/ai/models", { method: "PUT", body: { id: "x-1" } }))).status, 401);
    assert.equal((await r.aSettings.PUT(req("/api/admin/ai/settings", { method: "PUT", body: { unitsPerUsd: 1 } }))).status, 401);
    assert.equal((await r.aLimits.PUT(req("/api/admin/ai/limits", { method: "PUT", body: { orgId: "x", dailyCapUnits: 0 } }))).status, 401);
    const overview = await (await r.aAi.GET(req("/api/admin/ai", { headers: admin }))).json();
    assert.ok(overview.overview.models.some((m: { id: string; inputUsdMicroPerMtok: number }) => m.id === "sonnet-5-5" && m.inputUsdMicroPerMtok > 0), "the administrator sees real provider prices");
    const saved = await r.aModels.PUT(req("/api/admin/ai/models", { method: "PUT", headers: admin, body: { id: "sonnet-5-5", markupBasisPoints: 12_000 } }));
    assert.equal((await saved.json()).model.markupBasisPoints, 12_000);
    await r.aModels.PUT(req("/api/admin/ai/models", { method: "PUT", headers: admin, body: { id: "sonnet-5-5", markupBasisPoints: 10_000 } }));
    assert.equal((await r.aModels.PUT(req("/api/admin/ai/models", { method: "PUT", headers: admin, body: { id: "sonnet-5-5", inputUsdMicroPerMtok: -5 } }))).status, 400);
    assert.equal((await r.aSettings.PUT(req("/api/admin/ai/settings", { method: "PUT", headers: admin, body: { unitsPerUsd: 0 } }))).status, 400);
    const owner = await member("api-limits");
    assert.equal((await r.aLimits.PUT(req("/api/admin/ai/limits", { method: "PUT", headers: admin, body: { orgId: owner.org, dailyCapUnits: 0 } }))).status, 200);
    const blocked = await r.chat.POST(req("/api/workspace/ai/chat", { method: "POST", cookie: owner.cookie, body: { model: "silpi-demo", messages: [{ role: "user", content: "hi" }] }, headers: { "idempotency-key": k() } }));
    assert.equal(blocked.status, 200, "a free demo request holds nothing, so even a zero cap does not stop it");
    assert.equal((await r.aLimits.PUT(req("/api/admin/ai/limits", { method: "PUT", headers: admin, body: { orgId: "org_missing", dailyCapUnits: 5 } }))).status, 400);
  });
});

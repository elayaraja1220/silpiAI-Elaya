// AI metering: exact pricing maths, versioned prices, markup rules, cached tokens, missing usage, minimum charge, rounding, attempt log.
// Real SQLite; the AI provider is a fake the test controls. No network, no key, no cost.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { chargeUnits, usageCostMicroUsd, worstInputPrice, type ModelPrice } from "@/server/ai/pricing";
import { useFixedMetering } from "./fixtures/fixed-pricing";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-metering-"));
const ADMIN = "test-admin-token-0123456789abcdef";
let seq = 0;
const k = (p = "k") => `${p}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
const noSleep = async () => {};

const mods = async () => ({
  g: await import("@/server/ai/gateway"),
  cat: await import("@/server/ai/catalog"),
  prov: await import("@/server/ai/providers"),
  c: await import("@/server/credits"),
  t: await import("@/server/tenancy"),
  db: await import("@/lib/business/db"),
});
const newOrg = async () => (await mods()).t.createOrganization({ name: `Meter Org ${++seq}`, type: "business" }).id;
const fund = async (orgId: string, units: number) => (await mods()).c.addCredits({ orgId, units, kind: "grant", idempotencyKey: k("fund") });
const row = async (id: string) => (await mods()).db.getDb().prepare("SELECT * FROM ai_requests WHERE id = ?").get(id) as Record<string, string | number | null>;
const code = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as { code?: string }).code ?? "other"; } return "no-error"; };

type Out = { in?: number; out?: number; cr?: number; cw?: number; other?: number; missing?: boolean; raw?: Record<string, number>; text?: string };
async function fake(script: (n: number) => Out | Error) {
  const { prov } = await mods();
  const calls: number[] = [];
  const adapter: import("@/server/ai/providers").ProviderAdapter = {
    id: "fake",
    isConfigured: () => true,
    async complete() {
      calls.push(calls.length + 1);
      const r = script(calls.length);
      if (r instanceof Error) throw r;
      return { text: r.text ?? "an answer", inputTokens: r.in ?? 0, outputTokens: r.out ?? 0, cacheReadTokens: r.cr, cacheWriteTokens: r.cw, otherChargesMicroUsd: r.other, usageMissing: r.missing, raw: r.raw, providerRequestId: "pr" };
    },
  };
  return { calls, deps: { providers: { fake: adapter, echo: prov.echoAdapter }, sleep: noSleep } };
}
/** One live fake model: $3 in, $15 out per million, cache read $0.30, cache write $3.75, markup x1. Any earlier fake model is switched off. */
async function liveModel(id = "meter-a", over: Record<string, unknown> = {}) {
  const { cat } = await mods();
  for (const m of cat.listModels()) if (m.provider === "fake" && m.enabled && m.id !== id) cat.saveModel({ id: m.id, enabled: false });
  return cat.saveModel({ id, provider: "fake", providerModel: `${id}-v1`, label: id, tier: "balanced", inputUsdMicroPerMtok: 3_000_000, outputUsdMicroPerMtok: 15_000_000, cacheReadUsdMicroPerMtok: 300_000, cacheWriteUsdMicroPerMtok: 3_750_000, maxOutputTokens: 4096, priority: 0, enabled: true, ...over } as never);
}
const ask = (orgId: string, model: string, over: Record<string, unknown> = {}) => ({ orgId, model, messages: [{ role: "user", content: "hello" }], maxOutputTokens: 100, idempotencyKey: k("req"), ...over });
const clearRules = async () => (await mods()).db.getDb().prepare("DELETE FROM markup_rules").run();

before(async () => { process.env.SILPI_DB_PATH = path.join(dir, "metering.db"); process.env.SILPI_ADMIN_TOKEN = ADMIN; delete process.env.ANTHROPIC_API_KEY; await useFixedMetering({ models: false }); });
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

// =================================================================================================
describe("1. the cost of what a request used", () => {
  const price: ModelPrice = { inputUsdMicroPerMtok: 3_000_000, outputUsdMicroPerMtok: 15_000_000, markupBasisPoints: 10_000, cacheReadUsdMicroPerMtok: 300_000, cacheWriteUsdMicroPerMtok: 3_750_000 };
  it("prices input, output, cache reads and cache writes each at its own rate, exactly", () => {
    // 1000 in x $3 + 500 out x $15 + 10,000 cache read x $0.30 + 2,000 cache write x $3.75 = $0.021 = 21,000 micro-USD
    assert.equal(usageCostMicroUsd(price, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 10_000, cacheWriteTokens: 2000 }), 21_000);
  });
  it("adds other billable charges (a tool call, for example) as they are", () => {
    assert.equal(usageCostMicroUsd(price, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 10_000, cacheWriteTokens: 2000, otherChargesMicroUsd: 500 }), 21_500);
  });
  it("bills cached tokens at the ordinary input price when the model has no cache price", () => {
    const plain = { ...price, cacheReadUsdMicroPerMtok: null, cacheWriteUsdMicroPerMtok: null };
    assert.equal(usageCostMicroUsd(plain, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 10_000, cacheWriteTokens: 2000 }), 3000 + 7500 + 30_000 + 6000);
  });
  it("rounds the token part up to a whole micro-dollar, never down", () => {
    assert.equal(usageCostMicroUsd({ inputUsdMicroPerMtok: 100_000, outputUsdMicroPerMtok: 500_000, markupBasisPoints: 10_000 }, { inputTokens: 1, outputTokens: 0 }), 1);
  });
  it("refuses counts that cannot be real", () => {
    for (const bad of [-1, 1.5, Number.NaN]) assert.throws(() => usageCostMicroUsd(price, { inputTokens: bad, outputTokens: 0 }), /whole number/);
    assert.throws(() => usageCostMicroUsd(price, { inputTokens: 1, outputTokens: 1, otherChargesMicroUsd: -5 }), /whole number/);
  });
  it("the worst-case input price is the dearest the model has, so a hold never undercounts a cache write", () => {
    assert.equal(worstInputPrice(price), 3_750_000);
    assert.equal(worstInputPrice({ inputUsdMicroPerMtok: 100, outputUsdMicroPerMtok: 1, markupBasisPoints: 1 }), 100);
  });
});

describe("2. from cost to credits", () => {
  it("rounds up by default and to the nearest on request", () => {
    // cost 3411 micro-USD x 45,000 units a dollar = 153.495 units
    assert.deepEqual(chargeUnits(3411, 10_000, 45_000, { rounding: "up", minChargeUnits: 0 }), { units: 154, minApplied: false });
    assert.deepEqual(chargeUnits(3411, 10_000, 45_000, { rounding: "nearest", minChargeUnits: 0 }), { units: 153, minApplied: false });
    assert.equal(chargeUnits(3500, 10_000, 45_000, { rounding: "nearest", minChargeUnits: 0 }).units, 158, "157.5 rounds half up");
    assert.equal(chargeUnits(3400, 10_000, 45_000, { rounding: "up", minChargeUnits: 0 }).units, 153, "an exact figure is not rounded up");
  });
  it("applies the minimum charge, says so, and never charges a request that cost the provider nothing", () => {
    assert.deepEqual(chargeUnits(60, 10_000, 45_000, { rounding: "up", minChargeUnits: 10 }), { units: 10, minApplied: true });
    assert.deepEqual(chargeUnits(3500, 10_000, 45_000, { rounding: "up", minChargeUnits: 10 }), { units: 158, minApplied: false });
    assert.deepEqual(chargeUnits(0, 10_000, 45_000, { rounding: "up", minChargeUnits: 10 }), { units: 0, minApplied: false });
  });
  it("can express the brief's own example: $0.40 of provider cost, markup 2.5, one credit = $0.01, is 100 credits", () => {
    // 100 credits per customer dollar = 100,000 units (1 credit = 1,000 units); markup 2.5 = 25,000 basis points
    assert.equal(chargeUnits(400_000, 25_000, 100_000).units, 100_000, "100,000 units = 100 credits");
    assert.equal(chargeUnits(1_000_000, 25_000, 100_000).units, 250_000, "$1 of provider cost is 250 credits");
  });
  it("is exact on very large figures", () => {
    assert.equal(chargeUnits(1_000_000_000_000, 100_000, 10_000_000).units, 100_000_000_000_000);
  });
});

// =================================================================================================
describe("3. price versions", () => {
  it("every model started with version 1 as priced before versioning began, then moved to version 2 when a credit became USD 0.01 (markup 2.5)", async () => {
    const { cat } = await mods();
    const history = cat.listPriceHistory("sonnet-5-5");
    assert.deepEqual(history.map((v) => [v.version, v.markupBasisPoints, v.changedBy]), [[2, 25_000, "migration"], [1, 10_000, "migration"]]);
    assert.equal(history[1]!.inputUsdMicroPerMtok, 2_000_000, "the provider price did not move, only the markup");
    assert.equal(history[0]!.inputUsdMicroPerMtok, 2_000_000);
    assert.equal(cat.getModel("sonnet-5-5")!.priceVersion, 2);
  });
  it("a price change writes a new version with who and why; other edits do not", async () => {
    const { cat } = await mods();
    await liveModel("ver-a");
    assert.equal(cat.getModel("ver-a")!.priceVersion, 1, "a new model starts at version 1");
    cat.saveModel({ id: "ver-a", priority: 7, label: "Renamed" });
    assert.equal(cat.getModel("ver-a")!.priceVersion, 1, "priority and label are not prices");
    cat.saveModel({ id: "ver-a", outputUsdMicroPerMtok: 16_000_000, note: "provider raised output", changedBy: "admin" });
    cat.saveModel({ id: "ver-a", markupBasisPoints: 12_000, note: "margin", changedBy: "admin" });
    cat.saveModel({ id: "ver-a", cacheReadUsdMicroPerMtok: null });
    assert.equal(cat.getModel("ver-a")!.priceVersion, 4);
    const h = cat.listPriceHistory("ver-a");
    assert.deepEqual(h.map((v) => v.version), [4, 3, 2, 1]);
    assert.deepEqual([h[2]!.outputUsdMicroPerMtok, h[2]!.note, h[2]!.changedBy], [16_000_000, "provider raised output", "admin"]);
    assert.equal(h[3]!.outputUsdMicroPerMtok, 15_000_000, "the first price is still there");
    assert.equal(cat.getPriceVersion("ver-a", 3)!.markupBasisPoints, 12_000);
  });
  it("saving the same price again does not make a new version", async () => {
    const { cat } = await mods();
    await liveModel("ver-b");
    cat.saveModel({ id: "ver-b", inputUsdMicroPerMtok: 3_000_000 });
    assert.equal(cat.getModel("ver-b")!.priceVersion, 1);
  });
  it("the history can never be edited or deleted, and a bad price is refused without a trace", async () => {
    const { cat, db } = await mods();
    await liveModel("ver-c");
    assert.throws(() => db.getDb().prepare("UPDATE model_prices SET input_usd_micro_per_mtok = 1").run(), /append-only/);
    assert.throws(() => db.getDb().prepare("DELETE FROM model_prices").run(), /append-only/);
    assert.throws(() => cat.saveModel({ id: "ver-c", inputUsdMicroPerMtok: -1 }), /whole number/);
    assert.throws(() => cat.saveModel({ id: "ver-c", cacheWriteUsdMicroPerMtok: 1.5 }), /whole number/);
    assert.equal(cat.getModel("ver-c")!.priceVersion, 1);
    assert.equal(cat.listPriceHistory("ver-c").length, 1, "the failed edits left no history");
  });
  it("a request records the version it was charged at; a later price change does not touch it, and it can be re-priced exactly", async () => {
    const { g, cat } = await mods();
    const org = await newOrg();
    await fund(org, 100_000_000);
    await liveModel("ver-d");
    const f = await fake(() => ({ in: 2000, out: 800 }));
    const first = await g.complete(ask(org, "ver-d"), f.deps);
    assert.equal(first.priceVersion, 1);
    cat.saveModel({ id: "ver-d", inputUsdMicroPerMtok: 6_000_000, note: "doubled", changedBy: "admin" });
    const second = await g.complete(ask(org, "ver-d"), f.deps);
    assert.equal(second.priceVersion, 2);
    assert.ok(second.chargedUnits > first.chargedUnits, "the dearer price charges more for the same use");
    // The first request, re-priced from its recorded version, reproduces what it was charged.
    const r = await row(first.requestId);
    const v = cat.getPriceVersion("ver-d", r.price_version as number)!;
    assert.equal(usageCostMicroUsd({ ...v }, { inputTokens: r.input_tokens as number, outputTokens: r.output_tokens as number }), r.provider_cost_micro_usd);
    assert.equal((await row(second.requestId)).price_version, 2);
  });
  it("a price changed while a request is running does not change what that request is charged", async () => {
    const { g, cat } = await mods();
    const org = await newOrg();
    await fund(org, 100_000_000);
    await liveModel("ver-e");
    const f = await fake(() => { cat.saveModel({ id: "ver-e", inputUsdMicroPerMtok: 9_000_000, outputUsdMicroPerMtok: 45_000_000, changedBy: "admin" }); return { in: 1000, out: 500 }; });
    const r = await g.complete(ask(org, "ver-e"), f.deps);
    assert.equal(r.priceVersion, 1, "charged at the price in force when it began");
    assert.equal((await row(r.requestId)).provider_cost_micro_usd, 10_500, "1000 x $3 + 500 x $15");
    assert.equal(cat.getModel("ver-e")!.priceVersion, 2);
  });
});

// =================================================================================================
describe("4. markup rules", () => {
  const model = (id: string, provider: string, markup = 10_000) => ({ id, provider, markupBasisPoints: markup });
  it("with no rule the model's own markup applies", async () => {
    const { cat } = await mods();
    await clearRules();
    assert.deepEqual(cat.resolveMarkup(model("sonnet-5-5", "anthropic", 12_345), "chat"), { basisPoints: 12_345, source: "price" });
  });
  it("the most specific matching rule wins: model with task, then model, then task, then provider", async () => {
    const { cat } = await mods();
    await clearRules();
    const byProvider = cat.saveMarkupRule({ provider: "anthropic", markupBasisPoints: 20_000 });
    const byTask = cat.saveMarkupRule({ taskType: "code_generation", markupBasisPoints: 30_000 });
    const byModel = cat.saveMarkupRule({ modelId: "sonnet-5-5", markupBasisPoints: 25_000 });
    const byBoth = cat.saveMarkupRule({ modelId: "sonnet-5-5", taskType: "code_generation", markupBasisPoints: 40_000 });
    const at = (id: string, task: string) => cat.resolveMarkup(model(id, "anthropic"), task);
    assert.deepEqual(at("sonnet-5-5", "code_generation"), { basisPoints: 40_000, source: `rule:${byBoth.id}` });
    assert.deepEqual(at("sonnet-5-5", "chat"), { basisPoints: 25_000, source: `rule:${byModel.id}` });
    assert.deepEqual(at("haiku-5-5", "code_generation"), { basisPoints: 30_000, source: `rule:${byTask.id}` });
    assert.deepEqual(at("haiku-5-5", "chat"), { basisPoints: 20_000, source: `rule:${byProvider.id}` });
    assert.deepEqual(cat.resolveMarkup(model("other-model", "other-provider", 11_111), "chat"), { basisPoints: 11_111, source: "price" }, "no rule matches another provider");
    await clearRules();
  });
  it("a disabled rule is ignored, and of two equally specific rules the newest wins", async () => {
    const { cat } = await mods();
    await clearRules();
    const old = cat.saveMarkupRule({ taskType: "bug_fixing", markupBasisPoints: 15_000 });
    const newer = cat.saveMarkupRule({ taskType: "bug_fixing", markupBasisPoints: 16_000 });
    assert.equal(cat.resolveMarkup(model("m", "p"), "bug_fixing").basisPoints, 16_000);
    cat.saveMarkupRule({ id: newer.id, taskType: "bug_fixing", markupBasisPoints: 16_000, enabled: false });
    assert.deepEqual(cat.resolveMarkup(model("m", "p"), "bug_fixing"), { basisPoints: 15_000, source: `rule:${old.id}` });
    await clearRules();
  });
  it("refuses a rule with nothing to match, an unknown model or task, or an absurd markup", async () => {
    const { cat } = await mods();
    assert.throws(() => cat.saveMarkupRule({ markupBasisPoints: 10_000 }), /needs a provider/);
    assert.throws(() => cat.saveMarkupRule({ modelId: "no-such-model", markupBasisPoints: 10_000 }), /does not exist/);
    assert.throws(() => cat.saveMarkupRule({ taskType: "dancing", markupBasisPoints: 10_000 }), /taskType must be/);
    assert.throws(() => cat.saveMarkupRule({ taskType: "chat", markupBasisPoints: -1 }), /whole number/);
    assert.throws(() => cat.saveMarkupRule({ taskType: "chat", markupBasisPoints: 1_000_001 }), /whole number/);
    assert.throws(() => cat.deleteMarkupRule(999_999), /does not exist/);
  });
  it("a request is charged at the rule for its task, the hold uses the same rule, and the row records which rule", async () => {
    const { g, cat } = await mods();
    await clearRules();
    const org = await newOrg();
    await fund(org, 100_000_000);
    await liveModel("rule-a");
    const f = await fake(() => ({ in: 1000, out: 500 }));
    const plain = await g.complete(ask(org, "rule-a", { taskType: "code_generation" }), f.deps);
    const rule = cat.saveMarkupRule({ taskType: "code_generation", markupBasisPoints: 30_000, note: "code costs more" });
    const estimateAfter = g.estimate({ model: "rule-a", messages: [{ role: "user", content: "hello" }], maxOutputTokens: 100, taskType: "code_generation" });
    const dear = await g.complete(ask(org, "rule-a", { taskType: "code_generation" }), f.deps);
    const chat = await g.complete(ask(org, "rule-a", { taskType: "chat" }), f.deps);
    assert.equal(dear.chargedUnits, 1418, "10,500 micro-USD x 3.0 x 45,000 / 1e6 = 1,417.5, rounded up");
    assert.equal(plain.chargedUnits, 473, "and 472.5 up without the rule");
    assert.equal(chat.chargedUnits, 473, "another task type is unaffected");
    const r = await row(dear.requestId);
    assert.deepEqual([r.markup_basis_points, r.markup_source, r.task_type], [30_000, `rule:${rule.id}`, "code_generation"]);
    assert.equal((await row(plain.requestId)).markup_source, "price");
    assert.ok(estimateAfter.maxUnits > 0);
    await clearRules();
  });
  it("the hold follows the rule: a dearer markup holds more", async () => {
    const { g, cat } = await mods();
    await clearRules();
    await liveModel("rule-b");
    const before = g.estimate({ model: "rule-b", messages: [{ role: "user", content: "hello" }], maxOutputTokens: 1000, taskType: "code_review" }).maxUnits;
    cat.saveMarkupRule({ taskType: "code_review", markupBasisPoints: 20_000 });
    const after = g.estimate({ model: "rule-b", messages: [{ role: "user", content: "hello" }], maxOutputTokens: 1000, taskType: "code_review" }).maxUnits;
    assert.ok(Math.abs(after - before * 2) <= 1, `${before} -> ${after}`);
    await clearRules();
  });
  it("an unknown task type is refused before anything is held", async () => {
    const { g, c } = await mods();
    const org = await newOrg();
    await fund(org, 1_000_000);
    await liveModel("rule-c");
    const f = await fake(() => ({ in: 1, out: 1 }));
    assert.equal(await code(() => g.complete(ask(org, "rule-c", { taskType: "dancing" }), f.deps)), "invalid");
    assert.equal(f.calls.length, 0);
    assert.equal(c.getWallet(org).reservedUnits, 0);
  });
});

// =================================================================================================
describe("5. what the provider reports", () => {
  it("charges cached tokens at their own prices and records every count", async () => {
    const { g, c } = await mods();
    const org = await newOrg();
    await fund(org, 100_000_000);
    await liveModel("use-a");
    const f = await fake(() => ({ in: 1000, out: 500, cr: 10_000, cw: 2000, other: 500, raw: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 10_000 } }));
    const r = await g.complete(ask(org, "use-a"), f.deps);
    const saved = await row(r.requestId);
    assert.equal(saved.provider_cost_micro_usd, 21_500, "21,000 for the tokens plus 500 of other charges");
    assert.deepEqual([saved.input_tokens, saved.output_tokens, saved.cache_read_tokens, saved.cache_write_tokens, saved.other_charge_micro_usd], [1000, 500, 10_000, 2000, 500]);
    assert.equal(saved.usage_source, "provider");
    assert.deepEqual(JSON.parse(String(saved.usage_raw)), { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 10_000 }, "the provider's own counts are kept");
    assert.equal(r.usage.cacheReadTokens, 10_000);
    assert.equal(r.usageEstimated, false);
    assert.equal(c.getWallet(org).reservedUnits, 0);
    assert.deepEqual(c.auditWallets(), []);
    assert.deepEqual(c.auditBuckets(), []);
  });
  it("the hold counts a possible cache write at its dearer price, so the real charge fits inside it", async () => {
    const { g } = await mods();
    const org = await newOrg();
    await fund(org, 100_000_000);
    await liveModel("use-b", { cacheWriteUsdMicroPerMtok: 30_000_000 }); // a cache write ten times the input price
    const f = await fake(() => ({ in: 0, out: 100, cw: 300 }));
    const r = await g.complete(ask(org, "use-b", { messages: [{ role: "user", content: "x".repeat(900) }] }), f.deps);
    assert.equal(r.uncollectedUnits, 0, "nothing was left uncollected because the hold was too small");
  });
  it("if the provider reports no usage, the work is still charged from the gateway's own estimate and flagged", async () => {
    const { g, c } = await mods();
    const org = await newOrg();
    await fund(org, 100_000_000);
    await liveModel("use-c");
    const f = await fake(() => ({ missing: true, text: "y".repeat(400) }));
    const r = await g.complete(ask(org, "use-c", { messages: [{ role: "user", content: "x".repeat(800) }] }), f.deps);
    assert.equal(r.usageEstimated, true);
    assert.deepEqual([r.usage.inputTokens, r.usage.outputTokens], [200, 100], "800 characters in and 400 out, at 4 characters a token");
    assert.ok(r.chargedUnits > 0, "a request the provider billed us for is not given away");
    const saved = await row(r.requestId);
    assert.equal(saved.usage_source, "estimated");
    assert.equal(saved.status, "completed");
    assert.equal(c.getWallet(org).reservedUnits, 0);
  });
  it("counts that cannot be real (negative, fractional) are treated as missing, not trusted", async () => {
    const { g } = await mods();
    const org = await newOrg();
    await fund(org, 100_000_000);
    await liveModel("use-d");
    const f = await fake(() => ({ in: -500, out: 1.5 }));
    const r = await g.complete(ask(org, "use-d"), f.deps);
    assert.equal(r.usageEstimated, true);
    assert.ok(r.usage.inputTokens >= 0 && Number.isInteger(r.usage.outputTokens));
  });
  it("a model that costs nothing is never charged, whatever the minimum charge is", async () => {
    const { g, cat, prov } = await mods();
    const org = await newOrg();
    cat.setMeteringPolicy({ minChargeUnits: 50 });
    try {
      const r = await g.complete(ask(org, "silpi-demo"), { providers: prov.defaultProviders(), sleep: noSleep });
      assert.equal(r.chargedUnits, 0);
    } finally {
      cat.setMeteringPolicy({ minChargeUnits: 0 });
    }
  });
});

// =================================================================================================
describe("6. minimum charge and rounding", () => {
  it("the minimum charge lifts a tiny request, and the row says it was applied", async () => {
    const { g, cat } = await mods();
    const org = await newOrg();
    await fund(org, 100_000_000);
    await liveModel("pol-a");
    const f = await fake(() => ({ in: 10, out: 5 })); // 105 micro-USD x 45 = 4.7 -> 5 units
    cat.setMeteringPolicy({ minChargeUnits: 25 });
    try {
      const r = await g.complete(ask(org, "pol-a"), f.deps);
      assert.equal(r.chargedUnits, 25);
      assert.equal((await row(r.requestId)).min_charge_applied, 1);
      cat.setMeteringPolicy({ minChargeUnits: 0 });
      const plain = await g.complete(ask(org, "pol-a"), f.deps);
      assert.equal(plain.chargedUnits, 5);
      assert.equal((await row(plain.requestId)).min_charge_applied, 0);
    } finally {
      cat.setMeteringPolicy({ minChargeUnits: 0 });
    }
  });
  it("rounding to the nearest can be chosen, and the policy refuses nonsense", async () => {
    const { g, cat } = await mods();
    const org = await newOrg();
    await fund(org, 100_000_000);
    await liveModel("pol-b");
    const f = await fake(() => ({ in: 10, out: 5 })); // 4.725 units
    cat.setMeteringPolicy({ rounding: "nearest" });
    try {
      assert.equal((await g.complete(ask(org, "pol-b"), f.deps)).chargedUnits, 5, "4.725 rounds to 5");
      const g2 = await fake(() => ({ in: 10, out: 1 })); // 45 micro = 2.025 units
      assert.equal((await g.complete(ask(org, "pol-b"), g2.deps)).chargedUnits, 2, "2.025 rounds down to 2 on nearest, where up would give 3");
    } finally {
      cat.setMeteringPolicy({ rounding: "up" });
    }
    assert.throws(() => cat.setMeteringPolicy({ rounding: "down" }), /"up" or "nearest"/);
    assert.throws(() => cat.setMeteringPolicy({ minChargeUnits: -1 }), /whole number/);
    assert.deepEqual(cat.getMeteringPolicy(), { rounding: "up", minChargeUnits: 0 });
  });
});

// =================================================================================================
describe("7. the attempt log", () => {
  it("records every try, retries and a fallback included, with the outcome of each", async () => {
    const { g, cat, prov, db } = await mods();
    const org = await newOrg();
    await fund(org, 100_000_000);
    await liveModel("att-a", { priority: 0 });
    cat.saveModel({ id: "att-b", provider: "fake", providerModel: "att-b-v1", label: "att-b", tier: "balanced", inputUsdMicroPerMtok: 3_000_000, outputUsdMicroPerMtok: 15_000_000, maxOutputTokens: 4096, priority: 1, enabled: true });
    const seen: string[] = [];
    const f = await fake((n) => { seen.push(String(n)); return n <= 2 ? new prov.ProviderError("overloaded", true, 529) : { in: 100, out: 50 }; });
    const r = await g.complete(ask(org, "balanced"), f.deps);
    assert.equal(r.attempts, 3);
    const log = db.getDb().prepare("SELECT attempt_no, model_id, outcome, input_tokens FROM ai_request_attempts WHERE request_id = ? ORDER BY attempt_no").all(r.requestId) as { attempt_no: number; model_id: string; outcome: string; input_tokens: number }[];
    assert.deepEqual(log.map((x) => [x.attempt_no, x.model_id, x.outcome]), [[1, "att-a", "retryable-error"], [2, "att-a", "retryable-error"], [3, "att-b", "success"]]);
    assert.equal(log[2]!.input_tokens, 100);
    cat.saveModel({ id: "att-b", enabled: false });
  });
  it("a failed request still shows what was tried, and a non-retryable error is marked as one", async () => {
    const { g, prov, db } = await mods();
    const org = await newOrg();
    await fund(org, 100_000_000);
    await liveModel("att-c");
    const f = await fake(() => new prov.ProviderError("invalid request", false, 400));
    const key = k("fail");
    assert.equal(await code(() => g.complete(ask(org, "att-c", { idempotencyKey: key }), f.deps)), "provider-failed");
    const id = (db.getDb().prepare("SELECT id FROM ai_requests WHERE org_id = ? AND idempotency_key = ?").get(org, key) as { id: string }).id;
    const log = db.getDb().prepare("SELECT outcome, error_message FROM ai_request_attempts WHERE request_id = ?").all(id) as { outcome: string; error_message: string }[];
    assert.deepEqual(log.map((x) => x.outcome), ["error"]);
    assert.match(log[0]!.error_message, /invalid request/);
  });
});

// =================================================================================================
describe("8. the builder tells the gateway what each step is", () => {
  it("planning, writing files and reviewing are recorded as their own task types", async () => {
    const o = await import("@/server/ai/orchestrator");
    const { prov, db } = await mods();
    const org = await newOrg();
    const deps = { providers: prov.defaultProviders(), sleep: noSleep };
    const job = o.createJob({ orgId: org, brief: "A landing page for a bakery", quality: "demo", review: true });
    await o.runJob(job.id, deps);
    o.approveJob(org, job.id);
    await o.runJob(job.id, deps);
    const types = (db.getDb().prepare("SELECT task_type, COUNT(*) AS n FROM ai_requests WHERE org_id = ? GROUP BY task_type ORDER BY task_type").all(org) as { task_type: string; n: number }[]).map((r) => [r.task_type, r.n]);
    assert.deepEqual(types, [["architecture_planning", 1], ["code_generation", 3], ["code_review", 1]]);
  });
});

// =================================================================================================
describe("9. the administrator's tools", () => {
  function req(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): NextRequest {
    const headers: Record<string, string> = { host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-for": `10.5.0.${++seq % 250}`, ...(init.headers ?? {}) };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  }
  const admin = { authorization: `Bearer ${ADMIN}` };
  const routes = async () => ({
    models: await import("@/app/api/admin/ai/models/route"),
    prices: await import("@/app/api/admin/ai/prices/route"),
    markups: await import("@/app/api/admin/ai/markups/route"),
    settings: await import("@/app/api/admin/ai/settings/route"),
    overview: await import("@/app/api/admin/ai/route"),
  });

  it("every one of them needs the administrator token", async () => {
    const r = await routes();
    assert.equal((await r.prices.GET(req("/api/admin/ai/prices?modelId=sonnet-5-5"))).status, 401);
    assert.equal((await r.markups.GET(req("/api/admin/ai/markups"))).status, 401);
    assert.equal((await r.markups.PUT(req("/api/admin/ai/markups", { method: "PUT", body: { taskType: "chat", markupBasisPoints: 1 } }))).status, 401);
    assert.equal((await r.markups.DELETE(req("/api/admin/ai/markups?id=1", { method: "DELETE" }))).status, 401);
    assert.equal((await r.settings.GET(req("/api/admin/ai/settings"))).status, 401);
    assert.equal((await r.settings.PUT(req("/api/admin/ai/settings", { method: "PUT", body: { rounding: "up" } }))).status, 401);
  });
  it("a price edit through the API is versioned and attributed", async () => {
    const r = await routes();
    await liveModel("adm-a");
    const put = await r.models.PUT(req("/api/admin/ai/models", { method: "PUT", headers: admin, body: { id: "adm-a", outputUsdMicroPerMtok: 18_000_000, note: "provider announcement" } }));
    assert.equal(put.status, 200);
    assert.equal((await put.json()).model.priceVersion, 2);
    const hist = await (await r.prices.GET(req("/api/admin/ai/prices?modelId=adm-a", { headers: admin }))).json();
    assert.deepEqual(hist.versions.map((v: { version: number }) => v.version), [2, 1]);
    assert.deepEqual([hist.versions[0].note, hist.versions[0].changedBy], ["provider announcement", "admin"]);
    assert.equal((await r.prices.GET(req("/api/admin/ai/prices?modelId=nope", { headers: admin }))).status, 400);
    assert.equal((await r.prices.GET(req("/api/admin/ai/prices", { headers: admin }))).status, 400);
  });
  it("markup rules can be created, changed, listed and removed", async () => {
    const r = await routes();
    await clearRules();
    const made = await (await r.markups.PUT(req("/api/admin/ai/markups", { method: "PUT", headers: admin, body: { provider: "fake", taskType: "chat", markupBasisPoints: 22_000, note: "chat on fake" } }))).json();
    assert.equal(made.rule.markupBasisPoints, 22_000);
    const changed = await (await r.markups.PUT(req("/api/admin/ai/markups", { method: "PUT", headers: admin, body: { id: made.rule.id, provider: "fake", taskType: "chat", markupBasisPoints: 23_000, enabled: false } }))).json();
    assert.deepEqual([changed.rule.markupBasisPoints, changed.rule.enabled], [23_000, false]);
    assert.equal((await (await r.markups.GET(req("/api/admin/ai/markups", { headers: admin }))).json()).rules.length, 1);
    assert.equal((await r.markups.PUT(req("/api/admin/ai/markups", { method: "PUT", headers: admin, body: { markupBasisPoints: 10_000 } }))).status, 400, "a rule must match something");
    assert.equal((await r.markups.DELETE(req(`/api/admin/ai/markups?id=${made.rule.id}`, { method: "DELETE", headers: admin }))).status, 200);
    assert.equal((await r.markups.DELETE(req(`/api/admin/ai/markups?id=${made.rule.id}`, { method: "DELETE", headers: admin }))).status, 400, "already gone");
    assert.equal((await r.markups.DELETE(req("/api/admin/ai/markups", { method: "DELETE", headers: admin }))).status, 400);
  });
  it("the settings change together or not at all", async () => {
    const r = await routes();
    const before = await (await r.settings.GET(req("/api/admin/ai/settings", { headers: admin }))).json();
    const bad = await r.settings.PUT(req("/api/admin/ai/settings", { method: "PUT", headers: admin, body: { unitsPerUsd: 99_000, rounding: "sideways" } }));
    assert.equal(bad.status, 400);
    const after = await (await r.settings.GET(req("/api/admin/ai/settings", { headers: admin }))).json();
    assert.equal(after.unitsPerUsd, before.unitsPerUsd, "the valid half was not applied");
    const ok = await (await r.settings.PUT(req("/api/admin/ai/settings", { method: "PUT", headers: admin, body: { minChargeUnits: 3, rounding: "nearest" } }))).json();
    assert.deepEqual([ok.minChargeUnits, ok.rounding, ok.unitsPerUsd], [3, "nearest", before.unitsPerUsd]);
    await r.settings.PUT(req("/api/admin/ai/settings", { method: "PUT", headers: admin, body: { minChargeUnits: 0, rounding: "up" } }));
  });
  it("the overview shows the metering policy, the markup rules and each model's price version", async () => {
    const r = await routes();
    const o = (await (await r.overview.GET(req("/api/admin/ai", { headers: admin }))).json()).overview;
    assert.deepEqual(o.policy, { rounding: "up", minChargeUnits: 0 });
    assert.ok(Array.isArray(o.markupRules));
    assert.ok(o.models.every((m: { priceVersion: number }) => m.priceVersion >= 1));
  });
});

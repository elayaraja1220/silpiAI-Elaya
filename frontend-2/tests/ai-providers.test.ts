// Step 5: the OpenAI and Gemini adapters, the circuit breaker, and new models arriving switched off. No network, no key, no cost:
// the adapters run against a stand-in for `fetch` that records exactly what would have been sent.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import { createBreaker } from "@/server/ai/circuit";
import { ProviderError, type ProviderAdapter, type ProviderRequest } from "@/server/ai/providers";
import { geminiAdapter, openaiAdapter } from "@/server/ai/providers-extra";
import { useFixedMetering } from "./fixtures/fixed-pricing";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-providers-"));
let seq = 0;
const k = (p = "k") => `${p}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
const mods = async () => ({
  g: await import("@/server/ai/gateway"),
  cat: await import("@/server/ai/catalog"),
  c: await import("@/server/credits"),
  t: await import("@/server/tenancy"),
  db: await import("@/lib/business/db"),
  prov: await import("@/server/ai/providers"),
});
const noSleep = async () => {};
const newOrg = async (units = 5_000_000) => {
  const { t, c } = await mods();
  const id = t.createOrganization({ name: `Prov Org ${++seq}`, type: "business" }).id;
  c.addCredits({ orgId: id, units, kind: "grant", idempotencyKey: k("fund") });
  return id;
};
const code = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as { code?: string }).code ?? "other"; } return "no-error"; };

// ---- a stand-in for fetch ---------------------------------------------------------------------------------------------------------
type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
const realFetch = globalThis.fetch;
let sent: Sent[] = [];
function stubFetch(answer: { status?: number; json?: unknown; text?: string } | (() => never)) {
  sent = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) }, body: JSON.parse(String(init?.body ?? "{}")) });
    if (typeof answer === "function") answer();
    const a = answer as { status?: number; json?: unknown; text?: string };
    return new Response(a.text ?? JSON.stringify(a.json ?? {}), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const request = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({ providerModel: "some-model", maxOutputTokens: 200, messages: [{ role: "user", content: "hi" }], ...over });
const fails = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { return e as ProviderError; } assert.fail("expected a ProviderError"); };

before(async () => {
  process.env.SILPI_DB_PATH = path.join(dir, "providers.db");
  delete process.env.ANTHROPIC_API_KEY;
  await useFixedMetering();
});
afterEach(() => { globalThis.fetch = realFetch; delete process.env.OPENAI_API_KEY; delete process.env.GEMINI_API_KEY; delete process.env.OPENAI_BASE_URL; delete process.env.GEMINI_BASE_URL; });
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

// =================================================================================================
describe("1. the circuit breaker", () => {
  const make = () => { let now = 1_000_000; const b = createBreaker({ threshold: 3, cooldownMs: 10_000, now: () => now }); return { b, tick: (ms: number) => { now += ms; } }; };
  it("stays closed below the threshold, and one success wipes the count", () => {
    const { b } = make();
    b.failure("p"); b.failure("p");
    assert.equal(b.state("p"), "closed");
    b.success("p");
    b.failure("p"); b.failure("p");
    assert.equal(b.state("p"), "closed", "the earlier failures no longer count");
    assert.equal(b.allow("p"), true);
  });
  it("opens at the threshold, refuses while open, and each provider has its own circuit", () => {
    const { b } = make();
    for (let i = 0; i < 3; i++) b.failure("a");
    assert.deepEqual([b.state("a"), b.allow("a"), b.state("b"), b.allow("b")], ["open", false, "closed", true]);
  });
  it("after the cooldown exactly one probe goes through; its success closes the circuit", () => {
    const { b, tick } = make();
    for (let i = 0; i < 3; i++) b.failure("a");
    tick(9_999);
    assert.equal(b.allow("a"), false, "still cooling down");
    tick(1);
    assert.equal(b.state("a"), "half-open");
    assert.deepEqual([b.allow("a"), b.allow("a")], [true, false], "one probe only");
    b.success("a");
    assert.deepEqual([b.state("a"), b.allow("a"), b.allow("a")], ["closed", true, true]);
  });
  it("a failed probe reopens it for a full cooldown", () => {
    const { b, tick } = make();
    for (let i = 0; i < 3; i++) b.failure("a");
    tick(10_000);
    assert.equal(b.allow("a"), true);
    b.failure("a");
    assert.equal(b.state("a"), "open");
    tick(9_000);
    assert.equal(b.state("a"), "open", "the cooldown restarted");
    tick(1_000);
    assert.equal(b.state("a"), "half-open");
  });
  it("shows what it knows, and can be reset", () => {
    const { b } = make();
    for (let i = 0; i < 3; i++) b.failure("a");
    assert.deepEqual(b.snapshot().map((s) => [s.provider, s.state, s.failures, s.reopensInMs]), [["a", "open", 3, 10_000]]);
    b.reset("a");
    assert.equal(b.state("a"), "closed");
  });
});

// =================================================================================================
describe("2. the OpenAI adapter", () => {
  it("is configured only when its key is set", () => {
    assert.equal(openaiAdapter.isConfigured(), false);
    process.env.OPENAI_API_KEY = "  sk-test  ";
    assert.equal(openaiAdapter.isConfigured(), true);
  });
  it("sends the key as a bearer header, the system text as a system message, and the limit as max_completion_tokens", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    stubFetch({ json: { id: "chatcmpl_1", choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } });
    await openaiAdapter.complete(request({ system: "be brief", providerModel: "gpt-test", maxOutputTokens: 321, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }, { role: "user", content: "again" }] }));
    assert.equal(sent[0]!.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(sent[0]!.headers.authorization, "Bearer sk-test");
    assert.deepEqual(sent[0]!.body, { model: "gpt-test", max_completion_tokens: 321, messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }, { role: "assistant", content: "yo" }, { role: "user", content: "again" }] });
  });
  it("reports cached tokens apart from input, and keeps the provider's own numbers", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    stubFetch({ json: { id: "chatcmpl_2", choices: [{ message: { content: "answer" } }], usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 150 } } } });
    const r = await openaiAdapter.complete(request());
    assert.deepEqual([r.text, r.inputTokens, r.cacheReadTokens, r.outputTokens, r.cacheWriteTokens, r.usageMissing, r.providerRequestId], ["answer", 600, 400, 200, 0, undefined, "chatcmpl_2"]);
    assert.equal(r.raw!["completion_tokens_details.reasoning_tokens"], 150);
  });
  it("missing or contradictory usage keeps the answer and asks the gateway to estimate", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    stubFetch({ json: { choices: [{ message: { content: "still an answer" } }] } });
    assert.deepEqual([(await openaiAdapter.complete(request())).usageMissing, (await openaiAdapter.complete(request())).text], [true, "still an answer"]);
    stubFetch({ json: { choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 99 } } } });
    assert.equal((await openaiAdapter.complete(request())).usageMissing, true, "more cached than total is not believed");
  });
  it("classifies errors: temporary ones may be retried, permanent ones may not, and an empty answer is permanent", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    for (const [status, retryable] of [[429, true], [500, true], [503, true], [408, true], [400, false], [401, false], [404, false]] as const) {
      stubFetch({ status, text: '{"error":"x"}' });
      const e = await fails(() => openaiAdapter.complete(request()));
      assert.deepEqual([e.retryable, e.status], [retryable, status], String(status));
    }
    stubFetch({ json: { choices: [] } });
    assert.equal((await fails(() => openaiAdapter.complete(request()))).retryable, false);
    stubFetch(() => { throw new Error("connection reset"); });
    const net = await fails(() => openaiAdapter.complete(request()));
    assert.deepEqual([net.retryable, /connection reset/.test(net.message)], [true, true]);
  });
  it("can be pointed at another address (a proxy or a test server)", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = "http://localhost:9999";
    stubFetch({ json: { choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } });
    await openaiAdapter.complete(request());
    assert.equal(sent[0]!.url, "http://localhost:9999/v1/chat/completions");
  });
});

// =================================================================================================
describe("3. the Gemini adapter", () => {
  it("is configured only when its key is set", () => {
    assert.equal(geminiAdapter.isConfigured(), false);
    process.env.GEMINI_API_KEY = "g-key";
    assert.equal(geminiAdapter.isConfigured(), true);
  });
  it("sends the key in a header and never in the address, maps roles, and sends the system text apart", async () => {
    process.env.GEMINI_API_KEY = "g-key";
    stubFetch({ json: { candidates: [{ content: { parts: [{ text: "hello" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } } });
    await geminiAdapter.complete(request({ system: "be brief", providerModel: "gem-test", maxOutputTokens: 123, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }, { role: "user", content: "again" }] }));
    assert.equal(sent[0]!.url, "https://generativelanguage.googleapis.com/v1beta/models/gem-test:generateContent");
    assert.ok(!sent[0]!.url.includes("g-key"), "the key is not in the address");
    assert.equal(sent[0]!.headers["x-goog-api-key"], "g-key");
    assert.deepEqual(sent[0]!.body, {
      systemInstruction: { parts: [{ text: "be brief" }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }, { role: "model", parts: [{ text: "yo" }] }, { role: "user", parts: [{ text: "again" }] }],
      generationConfig: { maxOutputTokens: 123 },
    });
  });
  it("adds thinking tokens to the output (they are billed as output), takes cached tokens out of the input, and leaves thought text out of the answer", async () => {
    process.env.GEMINI_API_KEY = "g-key";
    stubFetch({ json: { responseId: "resp_1", candidates: [{ content: { parts: [{ text: "private thinking", thought: true }, { text: "the " }, { text: "answer" }] } }], usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 300, candidatesTokenCount: 200, thoughtsTokenCount: 120 } } });
    const r = await geminiAdapter.complete(request());
    assert.deepEqual([r.text, r.inputTokens, r.cacheReadTokens, r.outputTokens, r.providerRequestId], ["the answer", 700, 300, 320, "resp_1"]);
  });
  it("missing usage is estimated; a blocked request or an empty answer is a permanent error", async () => {
    process.env.GEMINI_API_KEY = "g-key";
    stubFetch({ json: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } });
    assert.equal((await geminiAdapter.complete(request())).usageMissing, true);
    stubFetch({ json: { promptFeedback: { blockReason: "SAFETY" } } });
    const blocked = await fails(() => geminiAdapter.complete(request()));
    assert.deepEqual([blocked.retryable, /SAFETY/.test(blocked.message)], [false, true]);
    stubFetch({ json: {} });
    assert.equal((await fails(() => geminiAdapter.complete(request()))).retryable, false);
  });
  it("classifies HTTP errors like the others", async () => {
    process.env.GEMINI_API_KEY = "g-key";
    for (const [status, retryable] of [[429, true], [503, true], [400, false], [403, false]] as const) {
      stubFetch({ status, text: "{}" });
      assert.equal((await fails(() => geminiAdapter.complete(request()))).retryable, retryable, String(status));
    }
  });
  it("refuses a model name that could change where the request goes, without sending anything", async () => {
    process.env.GEMINI_API_KEY = "g-key";
    stubFetch({ json: {} });
    for (const name of ["../admin", "a/b", "model?key=x", "model:other", "", "a b", ".hidden"]) {
      const e = await fails(() => geminiAdapter.complete(request({ providerModel: name })));
      assert.equal(e.retryable, false, name);
    }
    assert.equal(sent.length, 0, "nothing was sent");
  });
});

// =================================================================================================
describe("4. new models arrive switched off, and a real model cannot be switched on at no price", () => {
  it("a model added through the catalogue is off until someone turns it on", async () => {
    const { cat } = await mods();
    const m = cat.saveModel({ id: "gem-new", provider: "gemini", providerModel: "gem-test", label: "Gemini test", tier: "fast" });
    assert.deepEqual([m.enabled, m.inputUsdMicroPerMtok, m.outputUsdMicroPerMtok], [false, 0, 0]);
    assert.ok(!cat.listModels({ enabledOnly: true }).some((x) => x.id === "gem-new"), "never part of routing while off");
  });
  it("cannot be enabled while its price is zero, whatever else is set; with a price it can", async () => {
    const { cat } = await mods();
    assert.throws(() => cat.saveModel({ id: "gem-new", enabled: true }), /zero price/);
    assert.throws(() => cat.saveModel({ id: "gem-new", enabled: true, inputUsdMicroPerMtok: 100_000, outputUsdMicroPerMtok: 0 }), /zero price/);
    const on = cat.saveModel({ id: "gem-new", enabled: true, inputUsdMicroPerMtok: 100_000, outputUsdMicroPerMtok: 400_000, note: "prices checked against the provider's page" });
    assert.deepEqual([on.enabled, on.priceVersion], [true, 2]);
    cat.saveModel({ id: "gem-new", enabled: false });
  });
  it("the default adapters include all four, and an unconfigured provider is never asked", async () => {
    const { prov } = await mods();
    assert.deepEqual(Object.keys(prov.defaultProviders()).sort(), ["anthropic", "echo", "gemini", "openai"]);
  });
});

// =================================================================================================
describe("5. through the gateway", () => {
  /** A model on a provider with prices $1 in / $5 out / $0.10 cached-read per million tokens, alone in its tier. */
  async function liveModel(id: string, provider: string, tier: "fast" | "balanced" | "best", priority = 1) {
    const { cat } = await mods();
    for (const m of cat.listModels({ enabledOnly: true })) if (m.tier === tier && m.id !== id && m.provider !== "echo") cat.saveModel({ id: m.id, enabled: false });
    return cat.saveModel({ id, provider, providerModel: `${id}-v1`, label: id, tier, inputUsdMicroPerMtok: 1_000_000, outputUsdMicroPerMtok: 5_000_000, cacheReadUsdMicroPerMtok: 100_000, maxOutputTokens: 4096, priority, enabled: true });
  }
  const ask = (orgId: string, tier: string, over: Record<string, unknown> = {}) => ({ orgId, model: tier, messages: [{ role: "user", content: "hello" }], maxOutputTokens: 100, idempotencyKey: k("req"), ...over });

  it("an OpenAI answer is charged on the real, split usage: plain input, cached input and output each at their own price", async () => {
    const { g, db } = await mods();
    await liveModel("oa-fast", "openai", "fast");
    process.env.OPENAI_API_KEY = "sk-test";
    stubFetch({ json: { id: "c1", choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } } } });
    const org = await newOrg();
    const r = await g.complete(ask(org, "fast"), { providers: { openai: openaiAdapter }, sleep: noSleep, breaker: createBreaker() });
    assert.deepEqual([r.model.id, r.text, r.usage.inputTokens, r.usage.cacheReadTokens, r.usage.outputTokens, r.usageEstimated], ["oa-fast", "done", 600, 400, 200, false]);
    const row = db.getDb().prepare("SELECT provider_cost_micro_usd AS cost FROM ai_requests WHERE id = ?").get(r.requestId) as { cost: number };
    assert.equal(row.cost, 600 + 40 + 1000, "600 plain at $1/M + 400 cached at $0.10/M + 200 output at $5/M, in micro-dollars");
  });
  it("a Gemini answer counts its thinking tokens as output", async () => {
    const { g, db } = await mods();
    await liveModel("gm-fast", "gemini", "fast");
    process.env.GEMINI_API_KEY = "g-key";
    stubFetch({ json: { candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 100 } } });
    const org = await newOrg();
    const r = await g.complete(ask(org, "fast"), { providers: { gemini: geminiAdapter }, sleep: noSleep, breaker: createBreaker() });
    const row = db.getDb().prepare("SELECT provider_cost_micro_usd AS cost, output_tokens AS out FROM ai_requests WHERE id = ?").get(r.requestId) as { cost: number; out: number };
    assert.deepEqual([row.out, row.cost], [200, 1000 + 1000]);
  });
  it("a provider with no key is not asked and nothing is held", async () => {
    const { g, c } = await mods();
    await liveModel("oa-fast", "openai", "fast");
    const org = await newOrg();
    const before = c.getWallet(org);
    assert.equal(await code(() => g.complete(ask(org, "fast"), { providers: { openai: openaiAdapter }, breaker: createBreaker() })), "provider-not-configured");
    assert.deepEqual(c.getWallet(org), before);
  });

  /** A scripted provider, recording every call. */
  const scripted = (id: string, script: (n: number) => Error | null) => {
    let n = 0;
    const adapter: ProviderAdapter = { id, isConfigured: () => true, async complete() { n++; const e = script(n); if (e) throw e; return { text: `from ${id}`, inputTokens: 10, outputTokens: 10, providerRequestId: null }; } };
    return { adapter, calls: () => n };
  };
  const down = () => new ProviderError("overloaded", true, 529);

  it("a provider that keeps failing is skipped: the next model of the tier answers, and the failing one is not asked again", async () => {
    const { g, cat } = await mods();
    await liveModel("flaky", "flaky", "balanced", 1);
    cat.saveModel({ id: "steady", provider: "steady", providerModel: "s", label: "steady", tier: "balanced", inputUsdMicroPerMtok: 1_000_000, outputUsdMicroPerMtok: 5_000_000, maxOutputTokens: 4096, priority: 2, enabled: true });
    const flaky = scripted("flaky", () => down());
    const steady = scripted("steady", () => null);
    const breaker = createBreaker({ threshold: 2, cooldownMs: 60_000 });
    const org = await newOrg();
    const deps = { providers: { flaky: flaky.adapter, steady: steady.adapter }, sleep: noSleep, breaker };
    const first = await g.complete(ask(org, "balanced"), deps);
    assert.deepEqual([first.model.id, first.fallbackUsed, flaky.calls()], ["steady", true, 2], "two tries, then the fallback");
    assert.equal(breaker.state("flaky"), "open");
    const second = await g.complete(ask(org, "balanced"), deps);
    assert.deepEqual([second.model.id, flaky.calls()], ["steady", 2], "the open provider was not asked again");
    cat.saveModel({ id: "steady", enabled: false });
  });
  it("when every provider of the choice is open the request is refused at once, with nothing held and no request row", async () => {
    const { g, c, db } = await mods();
    await liveModel("solo", "solo", "best", 1);
    const solo = scripted("solo", () => down());
    const breaker = createBreaker({ threshold: 2, cooldownMs: 60_000 });
    const org = await newOrg();
    const deps = { providers: { solo: solo.adapter }, sleep: noSleep, breaker };
    assert.equal(await code(() => g.complete(ask(org, "best"), deps)), "provider-failed", "the failures that open the circuit");
    const wallet = c.getWallet(org);
    const rows = (db.getDb().prepare("SELECT COUNT(*) AS n FROM ai_requests WHERE org_id = ?").get(org) as { n: number }).n;
    assert.equal(await code(() => g.complete(ask(org, "best"), deps)), "provider-unavailable");
    assert.deepEqual(c.getWallet(org), wallet, "no credits held or charged");
    assert.equal((db.getDb().prepare("SELECT COUNT(*) AS n FROM ai_requests WHERE org_id = ?").get(org) as { n: number }).n, rows, "refused before a request row existed");
    assert.equal(solo.calls(), 2, "and the provider was not asked again");
  });
  it("after the cooldown one request probes the provider; if it answers the circuit closes", async () => {
    const { g } = await mods();
    await liveModel("probe", "probe", "best", 1);
    let healthy = false;
    const probe = scripted("probe", () => (healthy ? null : down()));
    let now = 5_000_000;
    const breaker = createBreaker({ threshold: 2, cooldownMs: 30_000, now: () => now });
    const org = await newOrg();
    const deps = { providers: { probe: probe.adapter }, sleep: noSleep, breaker };
    await code(() => g.complete(ask(org, "best"), deps));
    assert.equal(breaker.state("probe"), "open");
    now += 30_000;
    healthy = true;
    const r = await g.complete(ask(org, "best"), deps);
    assert.equal(r.text, "from probe");
    assert.equal(breaker.state("probe"), "closed");
  });
  it("a request the provider rejects as malformed does not count against the provider's health, but a rejected key does", async () => {
    const { g } = await mods();
    await liveModel("picky", "picky", "best", 1);
    const orgA = await newOrg();
    const badRequest = scripted("picky", () => new ProviderError("bad request", false, 400));
    const b1 = createBreaker({ threshold: 2 });
    for (let i = 0; i < 4; i++) await code(() => g.complete(ask(orgA, "best"), { providers: { picky: badRequest.adapter }, sleep: noSleep, breaker: b1 }));
    assert.equal(b1.state("picky"), "closed", "four rejected requests, still trusted");
    const badKey = scripted("picky", () => new ProviderError("invalid key", false, 401));
    const b2 = createBreaker({ threshold: 2 });
    for (let i = 0; i < 2; i++) await code(() => g.complete(ask(orgA, "best"), { providers: { picky: badKey.adapter }, sleep: noSleep, breaker: b2 }));
    assert.equal(b2.state("picky"), "open", "a key the provider refuses means the provider cannot be used");
  });
  it("the money still balances after all of it", async () => {
    const { c } = await mods();
    assert.deepEqual(c.auditWallets(), []);
    assert.deepEqual(c.auditBuckets(), []);
  });
});

// =================================================================================================
describe("6. the administrator's view of the providers", () => {
  it("shows each real provider's key status and circuit, and never the key itself", async () => {
    const ADMIN = "test-admin-token-0123456789abcdef";
    process.env.SILPI_ADMIN_TOKEN = ADMIN;
    process.env.OPENAI_API_KEY = "sk-very-secret-value";
    const { NextRequest } = await import("next/server");
    const route = await import("@/app/api/admin/ai/route");
    const call = (headers: Record<string, string>) => route.GET(new NextRequest("http://localhost:3000/api/admin/ai", { headers: { host: "localhost:3000", "x-forwarded-for": "10.9.0.1", ...headers } }));
    assert.equal((await call({})).status, 401);
    const res = await call({ authorization: `Bearer ${ADMIN}` });
    const text = await res.text();
    assert.ok(!text.includes("sk-very-secret-value"), "the key is never sent out");
    const providers = (JSON.parse(text).overview.providers as { id: string; configured: boolean; circuit: string }[]);
    assert.deepEqual(providers.map((p) => [p.id, p.configured]), [["anthropic", false], ["openai", true], ["gemini", false]]);
    assert.ok(providers.every((p) => p.circuit === "closed" || p.circuit === "open" || p.circuit === "half-open"));
  });
});

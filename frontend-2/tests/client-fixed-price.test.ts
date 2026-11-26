// A client's own fixed-price request: the studio's quotation engine, run for the client's workspace, with nothing of the studio's private figures in what the client gets.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import { clientRateCard } from "@/lib/business/client-rate-card";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-client-fixed-"));
const GOOD = "a-correct-horse-battery";
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
let seq = 0;
const mods = async () => ({
  s: await import("@/lib/business/store"),
  cf: await import("@/server/client-fixed-price"),
  acc: await import("@/server/client-accounts"),
  rl: await import("@/server/rate-limit"),
  auth: await import("@/lib/admin-auth"),
  db: await import("@/lib/business/db"),
  analyzeCache: await import("@/lib/business/analysis-cache"),
  sample: await import("@/lib/business/analyze-sample"),
});
const routes = async () => ({
  rateCard: await import("@/app/api/workspace/fixed-price/rate-card/route"),
  fx: await import("@/app/api/workspace/fixed-price/exchange-rates/route"),
  analyze: await import("@/app/api/workspace/fixed-price/analyze/route"),
  leads: await import("@/app/api/workspace/fixed-price/leads/route"),
  workspaceLeads: await import("@/app/api/workspace/leads/route"),
  signup: await import("@/app/api/auth/signup/route"),
  adminAnalyze: await import("@/app/api/business/analyze/route"),
});
const req = (url: string, init: { method?: string; body?: object | FormData; cookie?: string } = {}) => {
  const headers: Record<string, string> = { host: "localhost:3000", origin: "http://localhost:3000", "x-forwarded-for": `10.8.0.${++seq % 250}` };
  if (init.cookie) headers.cookie = init.cookie;
  const isForm = init.body instanceof FormData;
  if (init.body && !isForm) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers, body: init.body ? (isForm ? (init.body as FormData) : JSON.stringify(init.body)) : undefined });
};
const SIX = ["Home", "About Us", "Services", "Products / Portfolio", "Gallery", "Contact Us"];
const requirement = (over: Record<string, unknown> = {}) => ({ title: "My shop", summary: "A website for my small shop with six pages and a contact form.", scope: "full", projectType: "business-website", pages: SIX, modules: ["contact-form"], design: "ai", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 }, hosting: { needed: false, choice: "self", plan: "static", years: 1 }, ...over });
const person = (state = "Tamil Nadu") => ({ name: "Asha Client", email: "asha@example.com", phone: "+91 98765 43210", company: "", gstin: "", address: "", state });
const quietFetch = () => { (globalThis as { fetch: unknown }).fetch = async () => { throw new Error("no network in tests"); }; };

async function newClient(email: string) {
  const r = await routes();
  const res = await r.signup.POST(req("/api/auth/signup", { method: "POST", body: { name: "Test Client", email, password: GOOD, acceptTerms: true } }));
  const cookie = `silpi_session=${/silpi_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]}`;
  const body = await res.json();
  return { cookie, orgId: body.organization.id as string, userId: body.user.id as string };
}

const realFetch = globalThis.fetch;
before(() => {
  process.env.SILPI_DB_PATH = path.join(dir, "cfp.db");
  process.env.SILPI_ADMIN_TOKEN = "client-fixed-test-token-0123456789";
  quietFetch();
});
beforeEach(async () => {
  const { rl, auth } = await mods();
  rl.resetRates();
  auth.resetLoginAttempts();
});
after(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("1. what a client's copy of the rate card holds", () => {
  it("keeps the prices the form needs and drops the studio's payment details, contact details and discount room", () => {
    const card = { ...DEFAULT_RATE_CARD, maxDiscountPercent: 15, business: { ...DEFAULT_RATE_CARD.business, upiId: "owner@upi", bankDetails: "ACC 000111222", email: "owner@studio.example", phone: "+91 90000 00000", address: "1 Studio Street", gstin: "33ABCDE1234F1Z5" } };
    const c = clientRateCard(card);
    assert.equal(c.maxDiscountPercent, 0);
    assert.deepEqual([c.business.upiId, c.business.bankDetails, c.business.email, c.business.phone, c.business.address, c.business.gstin], [undefined, undefined, "", "", "", ""]);
    assert.equal(c.business.state, card.business.state, "the state decides CGST or IGST");
    assert.deepEqual([c.hourlyRate, c.gstRate, c.advancePercent, c.modules, c.page], [card.hourlyRate, card.gstRate, card.advancePercent, card.modules, card.page], "every price is still there");
    assert.equal(card.maxDiscountPercent, 15, "the real card is untouched");
    assert.ok(!JSON.stringify(c).includes("owner@upi") && !JSON.stringify(c).includes("ACC 000111222"));
  });
});

describe("2. the doors need a signed-in client", () => {
  it("refuse a visitor, an administrator's token, and give the right answer to a client", async () => {
    const r = await routes();
    const { s } = await mods();
    s.saveRateCard({ ...DEFAULT_RATE_CARD, maxDiscountPercent: 15, business: { ...DEFAULT_RATE_CARD.business, upiId: "owner@upi", bankDetails: "ACC 000111222" } });
    for (const call of [() => r.rateCard.GET(req("/api/workspace/fixed-price/rate-card")), () => r.fx.GET(req("/api/workspace/fixed-price/exchange-rates")), () => r.leads.POST(req("/api/workspace/fixed-price/leads", { method: "POST", body: {} })), () => r.analyze.POST(req("/api/workspace/fixed-price/analyze", { method: "POST", body: new FormData() }))]) {
      assert.equal((await call()).status, 401);
    }
    const bearer = { host: "localhost:3000", authorization: "Bearer client-fixed-test-token-0123456789" };
    assert.equal((await r.rateCard.GET(new NextRequest("http://localhost:3000/api/workspace/fixed-price/rate-card", { headers: bearer }))).status, 401, "an administrator token is not a client sign-in");
    const { cookie } = await newClient("doors@example.com");
    const res = await r.rateCard.GET(req("/api/workspace/fixed-price/rate-card", { cookie }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.rateCard.maxDiscountPercent, 0);
    assert.ok(!JSON.stringify(body).includes("owner@upi") && !JSON.stringify(body).includes("ACC 000111222"), "no payment details in what a client downloads");
    assert.equal(body.rateCard.hourlyRate, DEFAULT_RATE_CARD.hourlyRate);
    assert.equal((await r.fx.GET(req("/api/workspace/fixed-price/exchange-rates", { cookie }))).status, 200);
    s.saveRateCard(DEFAULT_RATE_CARD);
  });
});

describe("3. making a request", () => {
  it("belongs to the client's own workspace, is priced by the studio's engine exactly as the studio would, and returns only what the client needs to open it", async () => {
    const r = await routes();
    const { s, db } = await mods();
    const { cookie, orgId } = await newClient("owner1@example.com");
    const res = await r.leads.POST(req("/api/workspace/fixed-price/leads", { method: "POST", cookie, body: { client: person(), requirement: requirement(), tier: "standard" } }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ["request", "success"]);
    assert.deepEqual(Object.keys(body.request).sort(), ["leadId", "quotationNumber", "token"]);
    assert.match(body.request.quotationNumber, /^SQ-/);
    const row = db.getDb().prepare("SELECT org_id AS orgId, stage FROM leads WHERE id = ?").get(body.request.leadId) as { orgId: string; stage: string };
    assert.deepEqual({ ...row }, { orgId, stage: "quoted" });
    const studio = s.createLead(s.getLead(body.request.leadId)!.client, s.getLead(body.request.leadId)!.requirement, "standard");
    assert.equal(s.getLead(body.request.leadId)!.quotation!.grandTotal, studio.quotation!.grandTotal, "the price is the studio's, not the browser's");
    assert.equal(s.getLead(studio.id)!.stage, "quoted");
    const viaToken = s.getLeadByToken(body.request.token);
    assert.equal(viaToken?.id, body.request.leadId);
  });
  it("cannot set a price, a market basis, an hourly engagement or someone else's workspace", async () => {
    const r = await routes();
    const { s, db } = await mods();
    const a = await newClient("cheat@example.com");
    const b = await newClient("victim@example.com");
    const honest = await (await r.leads.POST(req("/api/workspace/fixed-price/leads", { method: "POST", cookie: a.cookie, body: { client: person(), requirement: requirement() } }))).json();
    const cheat = await (await r.leads.POST(req("/api/workspace/fixed-price/leads", { method: "POST", cookie: a.cookie, body: { client: person(), orgId: b.orgId, org_id: b.orgId, discount: 90, grandTotal: 1, requirement: requirement({ fixedBasis: { roleId: "full-stack", levelId: "mid", country: "GB", market: { billedMinor: 1 } }, grandTotal: 1, hourlyRate: 1, discount: 90 }) } }))).json();
    assert.equal(cheat.success, true);
    const lead = s.getLead(cheat.request.leadId)!;
    assert.equal(lead.requirement.fixedBasis, undefined, "the studio chooses the basis, not the client");
    assert.equal(lead.quotation!.grandTotal, s.getLead(honest.request.leadId)!.quotation!.grandTotal, "the same requirement costs the same whatever else was sent");
    assert.equal(lead.quotation!.discount, 0);
    assert.equal((db.getDb().prepare("SELECT org_id AS o FROM leads WHERE id = ?").get(cheat.request.leadId) as { o: string }).o, a.orgId, "the workspace comes from the session");
    const hourly = await r.leads.POST(req("/api/workspace/fixed-price/leads", { method: "POST", cookie: a.cookie, body: { client: person(), requirement: requirement({ billing: "hourly", hourly: { role: "x", rate: 1, estimatedHours: 5 } }) } }));
    assert.equal(hourly.status, 400);
    assert.match((await hourly.json()).error, /fixed-price/);
  });
  it("refuses a bad request in plain words and creates nothing", async () => {
    const r = await routes();
    const { db } = await mods();
    const { cookie } = await newClient("bad@example.com");
    const before = (db.getDb().prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number }).n;
    for (const body of [{}, { client: person(), requirement: { ...requirement(), summary: "short" } }, { client: { ...person(), email: "nope" }, requirement: requirement() }, { client: person(), requirement: null }]) {
      const res = await r.leads.POST(req("/api/workspace/fixed-price/leads", { method: "POST", cookie, body }));
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    }
    assert.equal((db.getDb().prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number }).n, before);
  });
  it("is limited per workspace: too many an hour, and too many open at once", async () => {
    const r = await routes();
    const { cf } = await mods();
    const a = await newClient("limit1@example.com");
    let last = 0;
    for (let i = 0; i < 13; i++) last = (await r.leads.POST(req("/api/workspace/fixed-price/leads", { method: "POST", cookie: a.cookie, body: { client: person(), requirement: requirement({ title: `Shop ${i}` }) } }))).status;
    assert.equal(last, 429);
    const b = await newClient("limit2@example.com");
    for (let i = 0; i < cf.MAX_OPEN_REQUESTS; i++) await cf.createClientRequest({ user: { id: b.userId, email: "x" }, orgId: b.orgId }, { client: person(), requirement: requirement({ title: `Open ${i}` }) });
    await assert.rejects(() => cf.createClientRequest({ user: { id: b.userId, email: "x" }, orgId: b.orgId }, { client: person(), requirement: requirement() }), /already have \d+ requests waiting/);
  });
});

describe("4. clients cannot see each other's requests", () => {
  it("each client's list holds only their own, and a client's session opens nothing of the studio", async () => {
    const r = await routes();
    const mw = await import("@/middleware");
    const a = await newClient("iso1@example.com");
    const b = await newClient("iso2@example.com");
    const made = await (await r.leads.POST(req("/api/workspace/fixed-price/leads", { method: "POST", cookie: a.cookie, body: { client: person(), requirement: requirement() } }))).json();
    const la = await (await r.workspaceLeads.GET(req("/api/workspace/leads", { cookie: a.cookie }))).json();
    const lb = await (await r.workspaceLeads.GET(req("/api/workspace/leads", { cookie: b.cookie }))).json();
    assert.deepEqual(la.leads.map((l: { id: string }) => l.id), [made.request.leadId]);
    assert.deepEqual(lb.leads, []);
    assert.ok(!JSON.stringify(la).match(/cost|profit|margin|internal/i), "the list carries no internal figure");
    for (const p of [`/api/business/leads/${made.request.leadId}`, "/api/business/leads", "/api/business/rate-card", "/api/business/cost-config"]) assert.equal(mw.middleware(req(p, { cookie: a.cookie })).status, 401, p);
  });
});

describe("5. reading a document", () => {
  it("is limited per workspace and needs something to read; it never reaches the AI for an empty request", async () => {
    const r = await routes();
    const { cookie } = await newClient("analyze@example.com");
    const empty = () => r.analyze.POST(req("/api/workspace/fixed-price/analyze", { method: "POST", cookie, body: new FormData() }));
    const first = await empty();
    assert.equal(first.status, 400);
    assert.match((await first.json()).error, /Upload a document or type/);
    for (let i = 0; i < 5; i++) await empty();
    assert.equal((await empty()).status, 429);
  });
  it("gives the client the draft but not the AI's model or cost, and cannot force a fresh reading; the studio still gets both", async () => {
    const r = await routes();
    const { analyzeCache, sample } = await mods();
    const { cookie } = await newClient("analyze2@example.com");
    const key = analyzeCache.analysisKey([], sample.composeNotes("A small shop website", ""));
    analyzeCache.saveAnalysis(key, { draft: { title: "From notes" } as never, model: "claude-secret-model", costUsd: 0.4321, runs: 3 });
    const form = () => { const f = new FormData(); f.append("notes", "A small shop website"); return f; };
    const client = await (await r.analyze.POST(req("/api/workspace/fixed-price/analyze", { method: "POST", cookie, body: form() }))).json();
    assert.deepEqual([client.success, client.draft.title, client.model, client.costUsd, client.cached], [true, "From notes", "", 0, true]);
    const fresh = form();
    fresh.append("fresh", "1");
    const forced = await (await r.analyze.POST(req("/api/workspace/fixed-price/analyze", { method: "POST", cookie, body: fresh }))).json();
    assert.equal(forced.cached, true, "asking for a fresh reading does not make the studio's AI run again");
    const studio = await (await r.adminAnalyze.POST(new NextRequest("http://localhost:3000/api/business/analyze", { method: "POST", headers: { host: "localhost:3000" }, body: form() }))).json();
    assert.equal(studio.model, "claude-secret-model", "the studio sees the model");
  });
});

describe("6. the form itself", () => {
  const w = () => read("src/components/business/requirement-wizard.tsx");
  it("in client mode it talks only to the client's doors, and everything the studio keeps private is left out", () => {
    const t = w();
    assert.match(t, /const apiBase = isClient \? "\/api\/workspace\/fixed-price" : "\/api\/business";/);
    for (const call of ["`${apiBase}/rate-card`", "`${apiBase}/exchange-rates`", "`${apiBase}/analyze`", "`${apiBase}/leads`"]) assert.ok(t.includes(call), call);
    const leadPost = t.indexOf('"/api/business/leads"');
    assert.ok(leadPost > t.indexOf("if (isClient) {") && leadPost > t.indexOf("onClientCreated?.(request);"), "the studio's leads door is only reached after the client branch has returned");
    const catalog = t.indexOf('"/api/business/tech-catalog"');
    assert.ok(catalog > t.indexOf("if (isClient) return;"), "no studio-only fetch is made in client mode");
    assert.ok(t.indexOf('"/api/projects"') > t.indexOf("if (isClient) return;"));
    for (const hidden of ["{!isClient && <FixedBasisPicker", "{!isClient && (<>", "{!isClient && <details"]) assert.ok(t.includes(hidden), hidden);
    assert.match(t, /clientMode \? null :/, "the cost of reading the document is not shown to a client");
  });
  it("the studio's form is the default and keeps its own wording", () => {
    const t = w();
    assert.match(t, /mode = "studio"/);
    assert.match(t, /isClient \? "Get my quotation" : "Save & create quotation"/);
    assert.match(read("src/components/pages/clients.tsx"), /<RequirementWizard onCancel=\{cancel\} onCreated=\{created\} \/>/, "the studio page passes nothing new");
  });
  it("the client page opens the form in client mode and goes to the client's quotation page afterwards", () => {
    const c = read("src/components/client/client-fixed-price.tsx");
    assert.match(c, /mode="client"/);
    assert.match(c, /router\.push\(`\/q\/\$\{r\.token\}`\)/);
    assert.match(read("src/app/(client)/clients/new/fixed-price/page.tsx"), /ClientFixedPrice/);
    assert.ok(!/not open for your account yet/.test(read("src/app/(client)/clients/new/fixed-price/page.tsx")));
  });
});

describe("7. the studio's payment details stay out of a client's quotation until it is approved", () => {
  it("the link's answer carries no UPI or bank details while the quotation is open, and the 'how to pay' block appears once it is approved", async () => {
    const r = await routes();
    const { s } = await mods();
    s.saveRateCard({ ...DEFAULT_RATE_CARD, business: { ...DEFAULT_RATE_CARD.business, upiId: "studio-secret@upi", bankDetails: "ACCOUNT-SECRET-123" } });
    try {
      const { cookie } = await newClient("pay@example.com");
      const made = await (await r.leads.POST(req("/api/workspace/fixed-price/leads", { method: "POST", cookie, body: { client: person(), requirement: requirement() } }))).json();
      const { clientView } = await import("@/lib/business/client-view");
      const open = clientView(s.getLead(made.request.leadId)!, s.getRateCard().business)!;
      assert.ok(!JSON.stringify(open).includes("studio-secret") && !JSON.stringify(open).includes("ACCOUNT-SECRET"), "nothing about how to pay while it is open");
      assert.equal(open.payment, undefined);
      assert.equal(open.quotation.business.name, DEFAULT_RATE_CARD.business.name, "the studio's name is still on the quotation");
      s.respondAsClient(made.request.token, { action: "approved", name: "Pat", message: "ok", acknowledgeDeferred: true });
      const approved = clientView(s.getLead(made.request.leadId)!, s.getRateCard().business)!;
      assert.deepEqual([approved.payment?.upiId, approved.payment?.bankDetails], ["studio-secret@upi", "ACCOUNT-SECRET-123"]);
    } finally { s.saveRateCard(DEFAULT_RATE_CARD); }
  });
});

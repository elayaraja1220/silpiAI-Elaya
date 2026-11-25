// Phase 2: the billing API, through the real route handlers and a real database.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { resetLoginAttempts } from "@/lib/admin-auth";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-billing-"));
const ADMIN = "test-admin-token-0123456789abcdef";
const PASSWORD = "a-long-test-password";
let seq = 0;

type Init = { method?: string; body?: unknown; cookie?: string; origin?: string | null; headers?: Record<string, string> };
function req(url: string, init: Init = {}): NextRequest {
  const headers: Record<string, string> = { host: "localhost:3000", "x-forwarded-for": `10.1.0.${++seq % 250}`, ...(init.headers ?? {}) };
  if (init.origin !== null) headers.origin = init.origin ?? "http://localhost:3000";
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
const admin = { authorization: `Bearer ${ADMIN}` };
const mods = async () => ({
  plans: await import("@/app/api/plans/route"),
  billing: await import("@/app/api/workspace/billing/route"),
  planChange: await import("@/app/api/workspace/billing/plan/route"),
  cancel: await import("@/app/api/workspace/billing/cancel/route"),
  adminPlans: await import("@/app/api/admin/plans/route"),
  adminCredits: await import("@/app/api/admin/credits/route"),
  adminInvoices: await import("@/app/api/admin/invoices/route"),
  adminProcess: await import("@/app/api/admin/billing/process/route"),
  adminUsers: await import("@/app/api/admin/users/route"),
  login: await import("@/app/api/auth/login/route"),
  t: await import("@/server/tenancy"),
  c: await import("@/server/credits"),
});

async function signIn(email: string): Promise<string> {
  const { login } = await mods();
  const res = await login.POST(req("/api/auth/login", { method: "POST", body: { email, password: PASSWORD } }));
  assert.equal(res.status, 200, email);
  return `silpi_session=${/silpi_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]}`;
}
/** A customer organization created the way the administrator does it, with an owner and an optional extra member. */
async function customer(name: string, extra?: { email: string; role: string }) {
  const { adminUsers } = await mods();
  const res = await adminUsers.POST(req("/api/admin/users", { method: "POST", headers: admin, body: { email: `owner@${name}.example`, name: `Owner ${name}`, password: PASSWORD, newOrg: { name, type: "agency" } } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  if (extra) assert.equal((await adminUsers.POST(req("/api/admin/users", { method: "POST", headers: admin, body: { email: extra.email, name: extra.email, password: PASSWORD, orgId: body.organization.id, role: extra.role } }))).status, 200);
  return body.organization.id as string;
}

before(() => {
  process.env.SILPI_DB_PATH = path.join(dir, "billing.db");
  process.env.SILPI_ADMIN_TOKEN = ADMIN;
});
beforeEach(() => resetLoginAttempts());
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  delete process.env.SILPI_ADMIN_TOKEN;
  rmSync(dir, { recursive: true, force: true });
});

// =================================================================================================
describe("1. the public price list", () => {
  it("anyone can read the active plans, and the route cannot change anything", async () => {
    const { plans } = await mods();
    const res = await plans.GET();
    const body = await res.json();
    assert.deepEqual(body.plans.map((p: { id: string }) => p.id), ["free", "starter", "pro", "professional", "enterprise"]);
    assert.deepEqual(Object.keys(plans).filter((k) => ["POST", "PUT", "PATCH", "DELETE"].includes(k)), []);
  });
});

// =================================================================================================
describe("2. a new customer organization", () => {
  it("starts on Free with its credits, and its members can see that", async () => {
    await customer("alpha");
    const { billing } = await mods();
    const res = await billing.GET(req("/api/workspace/billing", { cookie: await signIn("owner@alpha.example") }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual([body.billing.running.planId, body.billing.running.status, body.billing.wallet.balanceUnits, body.canManage], ["free", "active", 10_000, true]);
    assert.deepEqual(body.ledger.map((e: { kind: string }) => e.kind), ["grant"]);
  });
  it("needs a signed-in user, and a member without billing rights sees the plan and balance but not invoices or history", async () => {
    await customer("beta", { email: "viewer@beta.example", role: "viewer" });
    const { billing } = await mods();
    assert.equal((await billing.GET(req("/api/workspace/billing"))).status, 401);
    const body = await (await billing.GET(req("/api/workspace/billing", { cookie: await signIn("viewer@beta.example") }))).json();
    assert.deepEqual([body.canManage, body.billing.wallet.balanceUnits, "invoices" in body, "ledger" in body], [false, 10_000, false, false]);
  });
  it("each organization sees only its own wallet", async () => {
    const [a, b] = [await customer("gamma"), await customer("delta")];
    const { adminCredits, billing } = await mods();
    await adminCredits.POST(req("/api/admin/credits", { method: "POST", headers: admin, body: { orgId: a, action: "grant", units: 5000, idempotencyKey: "gamma-bonus-1", note: "welcome bonus" } }));
    const ga = await (await billing.GET(req("/api/workspace/billing", { cookie: await signIn("owner@gamma.example") }))).json();
    const gb = await (await billing.GET(req("/api/workspace/billing", { cookie: await signIn("owner@delta.example") }))).json();
    assert.deepEqual([ga.organizationId, ga.billing.wallet.balanceUnits, gb.organizationId, gb.billing.wallet.balanceUnits], [a, 15_000, b, 10_000]);
  });
});

// =================================================================================================
describe("3. changing plan through the API", () => {
  it("an owner asks for Pro, gets an open invoice; the administrator records payment; the plan and credits arrive", async () => {
    await customer("epsilon");
    const { planChange, billing, adminInvoices } = await mods();
    const cookie = await signIn("owner@epsilon.example");
    const asked = await (await planChange.POST(req("/api/workspace/billing/plan", { method: "POST", cookie, body: { planId: "pro" } }))).json();
    assert.deepEqual([asked.result.kind, asked.result.invoice.status, asked.result.invoice.totalPaise], ["upgrade", "open", 176_882]);
    assert.equal(asked.billing.running.planId, "free", "nothing changes until it is paid");
    assert.equal(asked.billing.wallet.balanceUnits, 10_000, "no credits before payment");

    const paid = await adminInvoices.POST(req("/api/admin/invoices", { method: "POST", headers: admin, body: { invoiceId: asked.result.invoice.id, providerRef: "UPI-EPS0001" } }));
    assert.equal(paid.status, 200);
    const again = await adminInvoices.POST(req("/api/admin/invoices", { method: "POST", headers: admin, body: { invoiceId: asked.result.invoice.id, providerRef: "UPI-EPS0001" } }));
    assert.equal(again.status, 200, "a retried confirmation is harmless");

    const after = await (await billing.GET(req("/api/workspace/billing", { cookie }))).json();
    assert.deepEqual([after.billing.running.planId, after.billing.wallet.balanceUnits, after.invoices[0].status], ["pro", 410_000, "paid"]);
  });
  it("a viewer or a plain member cannot change the plan; a cross-site request is blocked", async () => {
    await customer("zeta", { email: "member@zeta.example", role: "member" });
    const { planChange, cancel } = await mods();
    const member = await signIn("member@zeta.example");
    assert.equal((await planChange.POST(req("/api/workspace/billing/plan", { method: "POST", cookie: member, body: { planId: "pro" } }))).status, 403);
    assert.equal((await cancel.POST(req("/api/workspace/billing/cancel", { method: "POST", cookie: member, body: { action: "cancel" } }))).status, 403);
    const owner = await signIn("owner@zeta.example");
    assert.equal((await planChange.POST(req("/api/workspace/billing/plan", { method: "POST", cookie: owner, origin: "http://evil.example", body: { planId: "pro" } }))).status, 403);
    assert.equal((await planChange.POST(req("/api/workspace/billing/plan", { method: "POST", body: { planId: "pro" } }))).status, 401);
  });
  it("bad requests are 400s with a reason, and leave nothing behind", async () => {
    await customer("eta");
    const { planChange, billing } = await mods();
    const cookie = await signIn("owner@eta.example");
    for (const body of [{}, { planId: 5 }, { planId: "ghost" }, { planId: "enterprise" }, { planId: "free" }, { planId: "pro", period: "weekly" }]) {
      const res = await planChange.POST(req("/api/workspace/billing/plan", { method: "POST", cookie, body }));
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(typeof (await res.json()).error, "string");
    }
    const state = await (await billing.GET(req("/api/workspace/billing", { cookie }))).json();
    assert.deepEqual([state.billing.pending, state.invoices.length], [null, 0]);
  });
  it("cancel and keep work for an owner on a paid plan, and the Free plan has nothing to cancel", async () => {
    await customer("theta");
    const { planChange, cancel, adminInvoices } = await mods();
    const cookie = await signIn("owner@theta.example");
    assert.equal((await cancel.POST(req("/api/workspace/billing/cancel", { method: "POST", cookie, body: { action: "cancel" } }))).status, 400, "Free");
    const asked = await (await planChange.POST(req("/api/workspace/billing/plan", { method: "POST", cookie, body: { planId: "starter" } }))).json();
    await adminInvoices.POST(req("/api/admin/invoices", { method: "POST", headers: admin, body: { invoiceId: asked.result.invoice.id, providerRef: "UPI-THE001" } }));
    const cancelled = await (await cancel.POST(req("/api/workspace/billing/cancel", { method: "POST", cookie, body: { action: "cancel" } }))).json();
    assert.equal(cancelled.billing.running.cancelAtPeriodEnd, true);
    const kept = await (await cancel.POST(req("/api/workspace/billing/cancel", { method: "POST", cookie, body: { action: "keep" } }))).json();
    assert.equal(kept.billing.running.cancelAtPeriodEnd, false);
    assert.equal((await cancel.POST(req("/api/workspace/billing/cancel", { method: "POST", cookie, body: { action: "explode" } }))).status, 400);
  });
});

// =================================================================================================
describe("4. the administrator's tools", () => {
  it("every admin billing route needs the admin token", async () => {
    const { adminPlans, adminCredits, adminInvoices, adminProcess } = await mods();
    const calls = [
      () => adminPlans.GET(req("/api/admin/plans")),
      () => adminPlans.PUT(req("/api/admin/plans", { method: "PUT", body: { id: "pro", name: "Hacked" } })),
      () => adminCredits.GET(req("/api/admin/credits?orgId=x")),
      () => adminCredits.POST(req("/api/admin/credits", { method: "POST", body: { orgId: "x", action: "grant", units: 1 } })),
      () => adminInvoices.GET(req("/api/admin/invoices?orgId=x")),
      () => adminInvoices.POST(req("/api/admin/invoices", { method: "POST", body: { invoiceId: "x", providerRef: "abc" } })),
      () => adminProcess.POST(req("/api/admin/billing/process", { method: "POST" })),
    ];
    for (const call of calls) assert.equal((await call()).status, 401);
    const { c } = await mods();
    assert.deepEqual(c.auditWallets(), []);
  });
  it("plan edits go through the API and are validated", async () => {
    const { adminPlans } = await mods();
    const ok = await adminPlans.PUT(req("/api/admin/plans", { method: "PUT", headers: admin, body: { id: "starter", description: "Edited description." } }));
    assert.equal((await ok.json()).plan.description, "Edited description.");
    assert.equal((await adminPlans.PUT(req("/api/admin/plans", { method: "PUT", headers: admin, body: { id: "starter", monthlyPricePaise: -5 } }))).status, 400);
    assert.equal((await adminPlans.PUT(req("/api/admin/plans", { method: "PUT", headers: admin, body: { name: "no id" } }))).status, 400);
    assert.equal((await (await adminPlans.GET(req("/api/admin/plans", { headers: admin }))).json()).plans.length, 5);
  });
  it("credits: a grant needs a note-free key, an adjustment needs a reason; mistakes are clear errors; repeats are harmless", async () => {
    const org = await customer("iota");
    const { adminCredits } = await mods();
    const post = (body: unknown) => adminCredits.POST(req("/api/admin/credits", { method: "POST", headers: admin, body }));
    const first = await (await post({ orgId: org, action: "grant", units: 2500, idempotencyKey: "iota-grant-001", note: "goodwill" })).json();
    assert.equal(first.wallet.balanceUnits, 12_500);
    assert.equal((await (await post({ orgId: org, action: "grant", units: 2500, idempotencyKey: "iota-grant-001", note: "goodwill" })).json()).wallet.balanceUnits, 12_500, "repeat: once");
    assert.equal((await post({ orgId: org, action: "grant", units: 9999, idempotencyKey: "iota-grant-001" })).status, 409, "same key, different request");
    assert.equal((await post({ orgId: org, action: "adjust", deltaUnits: -50, idempotencyKey: "iota-adj-0001", note: "" })).status, 400, "no reason");
    const tooMuch = await post({ orgId: org, action: "adjust", deltaUnits: -999_999, idempotencyKey: "iota-adj-0002", note: "too much" });
    assert.deepEqual([tooMuch.status, (await tooMuch.json()).code], [402, "insufficient"]);
    assert.equal((await post({ orgId: "org_missing", action: "grant", units: 5, idempotencyKey: "missing-org-1" })).status, 404);
    assert.equal((await post({ orgId: org, action: "mint", units: 5, idempotencyKey: "iota-mint-001" })).status, 400);
    const view = await (await adminCredits.GET(req(`/api/admin/credits?orgId=${org}`, { headers: admin }))).json();
    assert.equal(view.wallet.balanceUnits, 12_500);
    assert.deepEqual(view.ledger.map((e: { kind: string }) => e.kind), ["grant", "grant"]);
  });
  it("the process route runs and can be repeated", async () => {
    const { adminProcess, c } = await mods();
    for (let i = 0; i < 2; i++) {
      const res = await adminProcess.POST(req("/api/admin/billing/process", { method: "POST", headers: admin }));
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys((await res.json()).processed).sort(), ["cancelled", "downgraded", "lapsedToFree", "pastDue", "renewalInvoices", "renewed"]);
    }
    assert.deepEqual(c.auditWallets(), []);
  });
});

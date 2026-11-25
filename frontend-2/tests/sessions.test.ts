// Phase 1b: user sign-in sessions, through the real route handlers and a real database.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { resetLoginAttempts } from "@/lib/admin-auth";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import { parseRequirement } from "@/lib/business/validate";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-sessions-"));
const ADMIN = "test-admin-token-0123456789abcdef";
const PASSWORD = "a-long-test-password";
let seq = 0;

type Init = { method?: string; body?: unknown; cookie?: string; origin?: string | null; headers?: Record<string, string> };
/** A request as the browser would send it; each gets its own client address so the sign-in throttle never mixes tests. */
function req(url: string, init: Init = {}): NextRequest {
  const headers: Record<string, string> = { host: "localhost:3000", "x-forwarded-for": `10.0.0.${++seq % 250}`, ...(init.headers ?? {}) };
  if (init.origin !== null) headers.origin = init.origin ?? "http://localhost:3000";
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
const tokenOf = (res: Response) => /silpi_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
const asCookie = (token: string) => `silpi_session=${token}`;

const mods = async () => ({
  db: await import("@/lib/business/db"),
  t: await import("@/server/tenancy"),
  s: await import("@/server/sessions"),
  store: await import("@/lib/business/store"),
  login: await import("@/app/api/auth/login/route"),
  logout: await import("@/app/api/auth/logout/route"),
  me: await import("@/app/api/auth/me/route"),
  leads: await import("@/app/api/workspace/leads/route"),
  users: await import("@/app/api/admin/users/route"),
});

const ids = { orgA: "", orgB: "", leadA: "", leadB: "", owner: "", viewer: "", other: "" };

async function leadIn(orgId: string, title: string): Promise<string> {
  const { store, db } = await mods();
  const requirement = parseRequirement(
    { title, summary: "Two page responsive informational website built with HTML, CSS and JavaScript.", scope: "full", existingProject: "", version: "", projectType: "business-website", complexity: "basic", pages: ["Home", "Contact Us"], modules: [], design: "ai", references: "", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 }, hosting: { needed: false, choice: "self", plan: "static", years: 1 }, deadlineWeeks: 0, budget: 0 },
    DEFAULT_RATE_CARD,
  );
  const lead = store.createLead({ name: `Client of ${title}`, email: "c@example.com", phone: "9876543210", company: "", gstin: "", state: "Tamil Nadu", address: "" }, requirement, "basic");
  db.getDb().prepare("UPDATE leads SET org_id = ? WHERE id = ?").run(orgId, lead.id);
  return lead.id;
}

async function signIn(email: string, password = PASSWORD): Promise<string> {
  const { login } = await mods();
  const res = await login.POST(req("/api/auth/login", { method: "POST", body: { email, password } }));
  assert.equal(res.status, 200, `sign-in as ${email}`);
  return tokenOf(res);
}

before(async () => {
  process.env.SILPI_DB_PATH = path.join(dir, "sessions.db");
  process.env.SILPI_ADMIN_TOKEN = ADMIN;
  const { t } = await mods();
  const a = t.createOrganization({ name: "Studio A", type: "agency" });
  const b = t.createOrganization({ name: "Freelancer B", type: "freelancer" });
  const owner = await t.createUser({ email: "owner@a.example", name: "Owner A", password: PASSWORD });
  const viewer = await t.createUser({ email: "viewer@a.example", name: "Viewer A", password: PASSWORD });
  const other = await t.createUser({ email: "other@b.example", name: "Other B", password: PASSWORD });
  t.addMember(a.id, owner.id, "owner");
  t.addMember(a.id, viewer.id, "viewer");
  t.addMember(b.id, other.id, "owner");
  Object.assign(ids, { orgA: a.id, orgB: b.id, owner: owner.id, viewer: viewer.id, other: other.id });
  ids.leadA = await leadIn(a.id, "Site for A");
  ids.leadB = await leadIn(b.id, "Site for B");
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
describe("1. signing in", () => {
  it("a right password starts a session: HttpOnly, SameSite=Strict cookie, no hash or password in the answer", async () => {
    const { login } = await mods();
    const res = await login.POST(req("/api/auth/login", { method: "POST", body: { email: "OWNER@a.example", password: PASSWORD } }));
    assert.equal(res.status, 200);
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, /silpi_session=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=strict/i);
    const text = await res.text();
    assert.ok(!/hash|scrypt|password/i.test(text), "nothing secret in the body");
    const body = JSON.parse(text);
    assert.deepEqual([body.user.email, body.organization.name], ["owner@a.example", "Studio A"]);
  });
  it("a wrong password, an unknown email and a missing body are refused with the same message, and set no cookie", async () => {
    const { login } = await mods();
    const wrong = await login.POST(req("/api/auth/login", { method: "POST", body: { email: "owner@a.example", password: "not-the-password" } }));
    const unknown = await login.POST(req("/api/auth/login", { method: "POST", body: { email: "nobody@example.com", password: PASSWORD } }));
    assert.deepEqual([wrong.status, unknown.status], [401, 401]);
    assert.equal((await wrong.json()).error, (await unknown.json()).error, "it never says which part was wrong");
    assert.equal(tokenOf(wrong) + tokenOf(unknown), "");
    const empty = await login.POST(req("/api/auth/login", { method: "POST", body: {} }));
    assert.equal(empty.status, 401);
  });
  it("a sign-in that does not come from this site is blocked", async () => {
    const { login } = await mods();
    for (const origin of ["http://evil.example", null]) {
      const res = await login.POST(req("/api/auth/login", { method: "POST", body: { email: "owner@a.example", password: PASSWORD }, origin }));
      assert.equal(res.status, 403, String(origin));
      assert.equal(tokenOf(res), "");
    }
  });
  it("too many attempts are throttled", async () => {
    const { login } = await mods();
    const attempt = () => login.POST(req("/api/auth/login", { method: "POST", body: { email: "throttle@a.example", password: "wrong-password" }, headers: { "x-forwarded-for": "203.0.113.9" } }));
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await attempt()).status);
    assert.deepEqual([statuses[0], statuses[9]], [401, 429]);
  });
  it("a disabled account cannot sign in", async () => {
    const { login, db } = await mods();
    db.getDb().prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(ids.other);
    try {
      const res = await login.POST(req("/api/auth/login", { method: "POST", body: { email: "other@b.example", password: PASSWORD } }));
      assert.equal(res.status, 401);
    } finally {
      db.getDb().prepare("UPDATE users SET status = 'active' WHERE id = ?").run(ids.other);
    }
  });
});

// =================================================================================================
describe("2. who am I, and what may I see", () => {
  it("/api/auth/me needs a session; it names the user, the organization and the role", async () => {
    const { me } = await mods();
    assert.equal((await me.GET(req("/api/auth/me"))).status, 401);
    assert.equal((await me.GET(req("/api/auth/me", { cookie: asCookie("garbage-token-that-is-long-enough") }))).status, 401);
    const token = await signIn("owner@a.example");
    const res = await me.GET(req("/api/auth/me", { cookie: asCookie(token) }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual([body.user.email, body.organization.id, body.role], ["owner@a.example", ids.orgA, "owner"]);
  });
  it("each organization sees only its own leads, through HTTP", async () => {
    const { leads } = await mods();
    const a = await (await leads.GET(req("/api/workspace/leads", { cookie: asCookie(await signIn("owner@a.example")) }))).json();
    const b = await (await leads.GET(req("/api/workspace/leads", { cookie: asCookie(await signIn("other@b.example")) }))).json();
    assert.deepEqual(a.leads.map((l: { id: string }) => l.id), [ids.leadA]);
    assert.deepEqual(b.leads.map((l: { id: string }) => l.id), [ids.leadB]);
    assert.equal(a.organizationId, ids.orgA);
  });
  it("the organization comes from the session: asking for another one changes nothing", async () => {
    const { leads } = await mods();
    const cookie = asCookie(await signIn("owner@a.example"));
    for (const extra of [`?orgId=${ids.orgB}`, `?org=${ids.orgB}&id=${ids.leadB}`]) {
      const body = await (await leads.GET(req(`/api/workspace/leads${extra}`, { cookie, headers: { "x-silpi-org": ids.orgB } }))).json();
      assert.deepEqual(body.leads.map((l: { id: string }) => l.id), [ids.leadA], extra);
    }
  });
  it("the list is a summary: no internal costs, provider prices or notes", async () => {
    const { leads } = await mods();
    const text = await (await leads.GET(req("/api/workspace/leads", { cookie: asCookie(await signIn("owner@a.example")) }))).text();
    assert.deepEqual(Object.keys(JSON.parse(text).leads[0]).sort(), ["client", "id", "quotationNumber", "stage", "title", "total", "updatedAt"]);
    assert.ok(!/providerCost|suggestedPrice|internalNotes|markup|password/i.test(text));
  });
  it("a viewer reads but may not write; the permission is checked from the role", async () => {
    const { leads } = await mods();
    const { requireSession } = await import("@/server/session-auth");
    const cookie = asCookie(await signIn("viewer@a.example"));
    assert.equal((await leads.GET(req("/api/workspace/leads", { cookie }))).status, 200);
    const denied = requireSession(req("/x", { cookie }), "lead:write");
    assert.ok("denied" in denied && denied.denied.status === 403);
    const allowed = requireSession(req("/x", { cookie }), "lead:read");
    assert.ok("ctx" in allowed && allowed.ctx.role === "viewer");
  });
  it("a change-making request must come from this site", async () => {
    const { requireSession } = await import("@/server/session-auth");
    const cookie = asCookie(await signIn("owner@a.example"));
    const cross = requireSession(req("/x", { method: "POST", cookie, origin: "http://evil.example" }));
    assert.ok("denied" in cross && cross.denied.status === 403);
    assert.ok("ctx" in requireSession(req("/x", { method: "POST", cookie })));
  });
});

// =================================================================================================
describe("3. ending a session, and a session that stops being valid", () => {
  it("sign-out ends it on the server: the old cookie is useless afterwards", async () => {
    const { logout, me } = await mods();
    const token = await signIn("owner@a.example");
    assert.equal((await me.GET(req("/api/auth/me", { cookie: asCookie(token) }))).status, 200);
    const res = await logout.POST(req("/api/auth/logout", { method: "POST", cookie: asCookie(token) }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("set-cookie") ?? "", /Max-Age=0|Expires=/i, "the browser cookie is cleared too");
    assert.equal((await me.GET(req("/api/auth/me", { cookie: asCookie(token) }))).status, 401, "replaying the old cookie fails");
    assert.equal((await logout.POST(req("/api/auth/logout", { method: "POST" }))).status, 200, "signing out when signed out is harmless");
    assert.equal((await logout.POST(req("/api/auth/logout", { method: "POST", origin: "http://evil.example" }))).status, 403);
  });
  it("an expired session stops working and is removed", async () => {
    const { s, me, db } = await mods();
    const old = s.createSession(ids.owner, Date.now() - (s.SESSION_DAYS + 1) * 86_400_000);
    assert.equal((await me.GET(req("/api/auth/me", { cookie: asCookie(old.token) }))).status, 401);
    const left = db.getDb().prepare("SELECT COUNT(*) AS n FROM sessions WHERE expires_at < ?").get(new Date().toISOString()) as { n: number };
    assert.equal(left.n, 0);
  });
  it("disabling the user ends their sessions at once", async () => {
    const { me, db } = await mods();
    const token = await signIn("other@b.example");
    assert.equal((await me.GET(req("/api/auth/me", { cookie: asCookie(token) }))).status, 200);
    db.getDb().prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(ids.other);
    try {
      assert.equal((await me.GET(req("/api/auth/me", { cookie: asCookie(token) }))).status, 401);
    } finally {
      db.getDb().prepare("UPDATE users SET status = 'active' WHERE id = ?").run(ids.other);
    }
  });
  it("removing someone from the organization, or suspending it, takes effect on the next request", async () => {
    const { me, leads, db, t } = await mods();
    const extra = await t.createUser({ email: "temp@a.example", name: "Temp", password: PASSWORD });
    t.addMember(ids.orgA, extra.id, "member");
    const token = await signIn("temp@a.example");
    assert.equal((await leads.GET(req("/api/workspace/leads", { cookie: asCookie(token) }))).status, 200);
    db.getDb().prepare("UPDATE organizations SET status = 'suspended' WHERE id = ?").run(ids.orgA);
    assert.equal((await leads.GET(req("/api/workspace/leads", { cookie: asCookie(token) }))).status, 403, "suspended organization");
    db.getDb().prepare("UPDATE organizations SET status = 'active' WHERE id = ?").run(ids.orgA);
    assert.equal((await leads.GET(req("/api/workspace/leads", { cookie: asCookie(token) }))).status, 200);
    db.getDb().prepare("DELETE FROM memberships WHERE user_id = ?").run(extra.id);
    assert.equal((await me.GET(req("/api/auth/me", { cookie: asCookie(token) }))).status, 403, "no longer a member");
  });
  it("destroySessionsOfUser ends them all", async () => {
    const { s, me } = await mods();
    const one = await signIn("viewer@a.example");
    const two = await signIn("viewer@a.example");
    assert.equal(s.destroySessionsOfUser(ids.viewer) >= 2, true);
    for (const token of [one, two]) assert.equal((await me.GET(req("/api/auth/me", { cookie: asCookie(token) }))).status, 401);
  });
  it("the database keeps only a hash of the token, so a copy of it cannot sign anyone in", async () => {
    const { db, me } = await mods();
    const token = await signIn("owner@a.example");
    const rows = db.getDb().prepare("SELECT id FROM sessions").all() as { id: string }[];
    assert.ok(rows.length > 0 && rows.every((r) => /^[0-9a-f]{64}$/.test(r.id)));
    assert.ok(!rows.some((r) => r.id === token));
    assert.equal((await me.GET(req("/api/auth/me", { cookie: asCookie(rows[0].id) }))).status, 401, "the stored value is not a valid cookie");
  });
});

// =================================================================================================
describe("4. the administrator creates accounts", () => {
  const admin = { authorization: `Bearer ${ADMIN}` };
  const post = async (body: unknown, headers: Record<string, string> = admin) => (await mods()).users.POST(req("/api/admin/users", { method: "POST", body, headers }));

  it("needs the admin token", async () => {
    const { users } = await mods();
    assert.equal((await users.GET(req("/api/admin/users"))).status, 401);
    assert.equal((await post({ email: "x@x.example", name: "X", password: PASSWORD, newOrg: { name: "X", type: "agency" } }, { authorization: "Bearer wrong" })).status, 401);
  });
  it("creates a user as the owner of a new organization, who can then sign in and see an empty workspace", async () => {
    const res = await post({ email: "New.Person@c.example", name: "New Person", password: PASSWORD, newOrg: { name: "New Co", type: "freelancer" } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual([body.user.email, body.organization.name, body.role], ["new.person@c.example", "New Co", "owner"]);
    assert.ok(!JSON.stringify(body).includes("scrypt"));
    const { leads } = await mods();
    const out = await (await leads.GET(req("/api/workspace/leads", { cookie: asCookie(await signIn("new.person@c.example")) }))).json();
    assert.deepEqual(out.leads, []);
  });
  it("can add a member to an existing organization with a role", async () => {
    const res = await post({ email: "member@a.example", name: "Member", password: PASSWORD, orgId: ids.orgA, role: "member" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).role, "member");
  });
  it("a bad request leaves nothing behind: no user without an organization", async () => {
    const { db } = await mods();
    const before = (db.getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    const bad: unknown[] = [
      { email: "p1@c.example", name: "P", password: PASSWORD },                                           // neither orgId nor newOrg
      { email: "p2@c.example", name: "P", password: PASSWORD, orgId: ids.orgA, newOrg: { name: "X", type: "agency" } }, // both
      { email: "p3@c.example", name: "P", password: PASSWORD, orgId: "org_missing" },
      { email: "p4@c.example", name: "P", password: PASSWORD, newOrg: { name: "X", type: "internal" } },   // customers are never internal
      { email: "p5@c.example", name: "P", password: PASSWORD, newOrg: { name: " ", type: "agency" } },
      { email: "p6@c.example", name: "P", password: PASSWORD, orgId: ids.orgA, role: "emperor" },
      { email: "p7@c.example", name: "P", password: "short", newOrg: { name: "X", type: "agency" } },
    ];
    for (const body of bad) assert.equal((await post(body)).status, 400, JSON.stringify(body));
    assert.equal((db.getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n, before);
  });
  it("a duplicate email is refused, and the list never shows a hash", async () => {
    assert.equal((await post({ email: "OWNER@a.example", name: "Dup", password: PASSWORD, orgId: ids.orgA })).status, 400);
    const { users } = await mods();
    const text = await (await users.GET(req("/api/admin/users", { headers: admin }))).text();
    assert.ok(text.includes("owner@a.example") && !/scrypt|password_hash/i.test(text));
  });
});

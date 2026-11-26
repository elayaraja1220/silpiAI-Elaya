// The client's own pages: dashboard, projects, updates and account. A client sees their own projects and nothing of the studio's private figures.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { nextStepFor, PROGRESS_STEPS, progressIndex, stepLabel } from "@/lib/client-progress";
import { STAGES, type Stage } from "@/lib/business/types";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-client-dash-"));
const GOOD = "a-correct-horse-battery";
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
let seq = 0;
const mods = async () => ({
  s: await import("@/lib/business/store"),
  cf: await import("@/server/client-fixed-price"),
  cp: await import("@/server/client-projects"),
  acct: await import("@/server/account"),
  ses: await import("@/server/sessions"),
  ten: await import("@/server/tenancy"),
  oauth: await import("@/server/oauth"),
  auth: await import("@/lib/admin-auth"),
  db: await import("@/lib/business/db"),
  rl: await import("@/server/rate-limit"),
});
const routes = async () => ({
  signup: await import("@/app/api/auth/signup/route"),
  login: await import("@/app/api/auth/login/route"),
  me: await import("@/app/api/auth/me/route"),
  account: await import("@/app/api/account/route"),
  password: await import("@/app/api/account/password/route"),
  everywhere: await import("@/app/api/account/sign-out-everywhere/route"),
  unlink: await import("@/app/api/account/identities/[provider]/route"),
});
const req = (url: string, init: { method?: string; body?: object; cookie?: string; origin?: string | null } = {}) => {
  const headers: Record<string, string> = { host: "localhost:3000", "x-forwarded-for": `10.7.0.${++seq % 250}` };
  if (init.origin !== null) headers.origin = init.origin ?? "http://localhost:3000";
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers, body: init.body ? JSON.stringify(init.body) : undefined });
};
const SIX = ["Home", "About Us", "Services", "Products / Portfolio", "Gallery", "Contact Us"];
const requirement = (title: string) => ({ title, summary: "A website for my small shop with six pages and a contact form.", scope: "full", projectType: "business-website", pages: SIX, modules: ["contact-form"], design: "ai", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 }, hosting: { needed: false, choice: "self", plan: "static", years: 1 } });
const person = (state = "Tamil Nadu") => ({ name: "Asha Client", email: "asha@example.com", phone: "+91 98765 43210", company: "", gstin: "", address: "", state });
const tokenOf = (res: Response) => `silpi_session=${/silpi_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]}`;
const rawToken = (cookie: string) => cookie.replace("silpi_session=", "");

async function newClient(email: string) {
  const r = await routes();
  const res = await r.signup.POST(req("/api/auth/signup", { method: "POST", body: { name: "Test Client", email, password: GOOD, acceptTerms: true } }));
  const body = await res.json();
  return { cookie: tokenOf(res), orgId: body.organization.id as string, userId: body.user.id as string, email };
}
async function request(c: { orgId: string; userId: string }, title: string, state = "Tamil Nadu") {
  const { cf } = await mods();
  return cf.createClientRequest({ user: { id: c.userId, email: "x" }, orgId: c.orgId }, { client: person(state), requirement: requirement(title), tier: "standard" });
}
const fails = async (fn: () => unknown, pattern: RegExp) => { try { await fn(); } catch (e) { assert.match((e as Error).message, pattern); return; } assert.fail(`expected an error matching ${pattern}`); };

before(() => {
  process.env.SILPI_DB_PATH = path.join(dir, "cd.db");
  process.env.SILPI_ADMIN_TOKEN = "client-dash-test-token-0123456789";
});
beforeEach(async () => {
  const { auth, rl } = await mods();
  auth.resetLoginAttempts();
  rl.resetRates();
});
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("1. how progress is shown", () => {
  it("has nine steps in order, an index for every stage but a closed one, and a plain label for each", () => {
    assert.deepEqual(PROGRESS_STEPS.map((s) => s.stage), ["requirement", "quoted", "approved", "advance_paid", "in_development", "testing", "demo_ready", "final_paid", "delivered"]);
    STAGES.filter((s) => s !== "lost").forEach((s, i) => assert.equal(progressIndex(s), i, s));
    assert.equal(progressIndex("lost"), -1);
    assert.equal(stepLabel("requirement"), "Request received");
    assert.equal(stepLabel("lost"), "Closed");
    assert.equal(stepLabel("final_paid"), "Fully paid");
  });
  it("says what to do next at every stage, and points at review, payment or the demo only where that is the next thing", () => {
    const action = (s: Stage) => nextStepFor(s).action;
    assert.deepEqual([action("quoted"), action("approved"), action("demo_ready")], ["review", "pay", "demo"]);
    for (const s of ["requirement", "advance_paid", "in_development", "testing", "final_paid", "delivered", "lost"] as Stage[]) assert.equal(action(s), null, s);
    for (const s of STAGES) assert.ok(nextStepFor(s).text.length > 15, s);
  });
});

describe("2. a client's projects", () => {
  it("each client sees only their own, and another client's project is simply not found", async () => {
    const { cp } = await mods();
    const a = await newClient("own1@example.com");
    const b = await newClient("own2@example.com");
    const mine = await request(a, "Asha shop");
    const theirs = await request(b, "Other shop");
    assert.deepEqual(cp.listClientProjects(a.orgId).map((p) => p.id), [mine.leadId]);
    assert.deepEqual(cp.listClientProjects(b.orgId).map((p) => p.id), [theirs.leadId]);
    assert.ok(cp.getClientProject(a.orgId, mine.leadId));
    assert.equal(cp.getClientProject(a.orgId, theirs.leadId), null);
    assert.equal(cp.getClientProject(a.orgId, "no-such-project"), null);
    assert.equal(cp.getClientProject(b.orgId, mine.leadId), null);
  });
  it("shows only what the client is meant to see: no cost, margin, hours, work log, notes or analysis, however the lead grows", async () => {
    const { cp, s } = await mods();
    const a = await newClient("fields@example.com");
    const made = await request(a, "Fields shop");
    s.setStage(made.leadId, "approved", "INTERNAL-NOTE-do-not-show");
    s.addWorkEntry(made.leadId, { item: "INTERNAL-WORKLOG-ITEM", hours: 7, note: "secret", loggedOn: "2026-11-01" });
    const p = cp.getClientProject(a.orgId, made.leadId)!;
    assert.deepEqual(Object.keys(p).sort(), ["demo", "history", "id", "next", "pages", "payment", "payments", "quotationLink", "quotationNumber", "stage", "stageLabel", "step", "summary", "title", "total", "updatedAt", "validUntil"]);
    const dump = JSON.stringify([p, cp.listClientProjects(a.orgId), cp.clientUpdates(a.orgId)]);
    for (const secret of ["INTERNAL-NOTE", "INTERNAL-WORKLOG", "totalHours", "profit", "margin", "insights", "workLog", "costUsd"]) assert.ok(!dump.includes(secret), secret);
  });
  it("follows the project: the stage, the quotation link, what is due, what has been paid", async () => {
    const { cp, s } = await mods();
    const a = await newClient("flow@example.com");
    const made = await request(a, "Flow shop");
    let p = cp.getClientProject(a.orgId, made.leadId)!;
    assert.deepEqual([p.stage, p.step, p.next.action, p.payment, p.payments.length], ["quoted", 1, "review", null, 0]);
    assert.equal(p.quotationLink, `/q/${made.token}`);
    assert.match(p.total!, /₹/);
    s.setStage(made.leadId, "approved", "ok");
    p = cp.getClientProject(a.orgId, made.leadId)!;
    assert.deepEqual([p.stage, p.next.action], ["approved", "pay"]);
    assert.ok(p.payment && /₹/.test(p.payment.advanceDue) && p.payment.advancePaid === "₹0.00");
    s.recordPayment(made.leadId, { kind: "advance", amount: 1000, mode: "upi", reference: "UPI-REF-1", receivedOn: "2026-11-20" });
    p = cp.getClientProject(a.orgId, made.leadId)!;
    assert.deepEqual(p.payments.map((x) => [x.kind, x.amount, x.mode, x.reference]), [["Advance", "₹1,000.00", "upi", "UPI-REF-1"]]);
    assert.equal(p.payment!.advancePaid, "₹1,000.00");
    assert.equal(p.demo, null, "no demo before the demo stage");
  });
  it("lists the changes as updates, newest first, without repeating a re-pricing as a change, and counts the projects for the dashboard", async () => {
    const { cp, s } = await mods();
    const a = await newClient("updates@example.com");
    assert.deepEqual([cp.clientUpdates(a.orgId), cp.projectCounts(a.orgId)], [[], { total: 0, waitingForYou: 0, inProgress: 0, delivered: 0 }]);
    const made = await request(a, "Updates shop");
    s.requote(made.leadId, 0);
    s.requote(made.leadId, 0);
    assert.deepEqual(cp.clientUpdates(a.orgId).map((u) => u.label), ["Quotation ready", "Request received"], "two re-pricings add no update");
    s.setStage(made.leadId, "approved", "ok");
    assert.equal(cp.clientUpdates(a.orgId)[0]!.label, "Approved");
    assert.deepEqual(cp.projectCounts(a.orgId), { total: 1, waitingForYou: 1, inProgress: 0, delivered: 0 });
    s.setStage(made.leadId, "quoted", "reopened");
    s.setStage(made.leadId, "lost", "no budget");
    assert.equal(cp.listClientProjects(a.orgId)[0]!.stageLabel, "Closed");
    assert.equal(cp.listClientProjects(a.orgId)[0]!.step, -1);
    assert.deepEqual(cp.getClientProject(a.orgId, made.leadId)!.history.map((h) => h.label), ["Request received", "Quotation ready", "Approved", "Quotation ready"], "re-pricings and the closing are not steps in the history");
  });
  it("shows a client abroad their own currency", async () => {
    const { cp, s } = await mods();
    s.saveRateCard({ ...(await import("@/lib/business/rate-card")).DEFAULT_RATE_CARD, countryPricing: { GBP: { hourlyRate: 25, inrPerUnit: 120, auto: false } } });
    try {
      const a = await newClient("uk@example.com");
      const { cf } = await mods();
      const made = await cf.createClientRequest({ user: { id: a.userId, email: "x" }, orgId: a.orgId }, { client: { ...person("Outside India"), country: "GB", currency: "GBP" }, requirement: requirement("UK shop") });
      assert.match(cp.getClientProject(a.orgId, made.leadId)!.total!, /£/);
    } finally { s.saveRateCard((await import("@/lib/business/rate-card")).DEFAULT_RATE_CARD); }
  });
});

describe("2b. the studio's own leads are never a client's", () => {
  it("a lead the studio made (the agency's own workspace) is not in any client's list and cannot be opened by a client", async () => {
    const { cp, s } = await mods();
    const a = await newClient("agency-check@example.com");
    const studio = s.createLead(person() as never, (await import("@/lib/business/validate")).parseRequirement(requirement("Studio project"), s.getRateCard()));
    assert.ok(!cp.listClientProjects(a.orgId).some((p) => p.id === studio.id));
    assert.equal(cp.getClientProject(a.orgId, studio.id), null);
  });
  it("a balance payment is named as such", async () => {
    const { cp, s, db } = await mods();
    const a = await newClient("balance@example.com");
    const made = await request(a, "Balance shop");
    s.setStage(made.leadId, "approved", "ok");
    db.getDb().prepare("INSERT INTO payments (id, lead_id, kind, amount, mode, reference, received_on, recorded_at) VALUES ('pay-bal-1', ?, 'balance', 500, 'bank', 'NEFT-9', '2026-11-25', '2026-11-25T00:00:00Z')").run(made.leadId);
    assert.deepEqual(cp.getClientProject(a.orgId, made.leadId)!.payments.map((p) => [p.kind, p.mode]), [["Balance", "bank"]]);
  });
});

describe("3. the account", () => {
  it("shows the person's details, terms acceptance and connected methods; names are checked", async () => {
    const { acct } = await mods();
    const a = await newClient("acct@example.com");
    const p = acct.getProfile(a.userId);
    assert.deepEqual([p.email, p.hasPassword, p.termsVersion, p.identities], ["acct@example.com", true, "2026-11", []]);
    assert.equal(acct.updateName(a.userId, "  New   Name "), "New Name");
    assert.equal(acct.getProfile(a.userId).name, "New Name");
    for (const bad of ["", "A", "x".repeat(81), "<b>"]) await fails(() => acct.updateName(a.userId, bad), /name/i);
  });
  it("changes the password only with the right current one, signs out every other session, and keeps the one in use", async () => {
    const { acct, ses, ten } = await mods();
    const a = await newClient("pw@example.com");
    const other = ses.createSession(a.userId).token;
    const keep = rawToken(a.cookie);
    await fails(() => acct.changePassword(a.userId, "wrong-current-pw", "a-brand-new-phrase-1", keep), /current password is not correct/);
    await fails(() => acct.changePassword(a.userId, GOOD, "short", keep), /at least 10/);
    await fails(() => acct.changePassword(a.userId, GOOD, GOOD, keep), /different/);
    assert.ok(ses.resolveSession(other), "nothing changed after refusals");
    await acct.changePassword(a.userId, GOOD, "a-brand-new-phrase-1", keep);
    assert.equal(ses.resolveSession(other), null, "the other session is gone");
    assert.ok(ses.resolveSession(keep), "this one stays");
    assert.equal(await ten.authenticate("pw@example.com", GOOD), null);
    assert.ok(await ten.authenticate("pw@example.com", "a-brand-new-phrase-1"));
  });
  it("an account with no password cannot change one, and is told how to set one", async () => {
    const { acct, oauth } = await mods();
    const r = oauth.signInWithProfile("google", { subject: "g-dash-1", email: "social@example.com", emailVerified: true, name: "Social Person" }, null, "/");
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(acct.getProfile(r.userId).hasPassword, false);
    await fails(() => acct.changePassword(r.userId, "anything-at-all", "a-brand-new-phrase-1", undefined), /Forgot password/);
  });
  it("lets a connected method be removed unless it is the only way in", async () => {
    const { acct, oauth } = await mods();
    const a = await newClient("unlink@example.com");
    const linked = oauth.signInWithProfile("google", { subject: "g-dash-2", email: "elsewhere@example.com", emailVerified: true, name: "x" }, a.userId, "/");
    assert.ok(linked.ok);
    assert.deepEqual(acct.listIdentities(a.userId).map((i) => i.provider), ["google"]);
    await fails(() => acct.unlinkIdentity(a.userId, "facebook"), /not connected/);
    await fails(() => acct.unlinkIdentity(a.userId, "twitter"), /Unknown/);
    acct.unlinkIdentity(a.userId, "google");
    assert.deepEqual(acct.listIdentities(a.userId), []);
    const social = oauth.signInWithProfile("google", { subject: "g-dash-3", email: "only@example.com", emailVerified: true, name: "Only Way" }, null, "/");
    assert.ok(social.ok);
    if (social.ok) await fails(() => acct.unlinkIdentity(social.userId, "google"), /only way to sign in/);
  });
  it("signing out everywhere ends every session", async () => {
    const { acct, ses } = await mods();
    const a = await newClient("everywhere@example.com");
    const second = ses.createSession(a.userId).token;
    assert.ok(acct.signOutEverywhere(a.userId) >= 2);
    assert.equal(ses.resolveSession(second), null);
    assert.equal(ses.resolveSession(rawToken(a.cookie)), null);
  });
});

describe("4. the account doors", () => {
  it("need a signed-in person, and a request from this site", async () => {
    const r = await routes();
    const a = await newClient("doors1@example.com");
    assert.equal((await r.account.GET(req("/api/account"))).status, 401);
    assert.equal((await r.password.POST(req("/api/account/password", { method: "POST", body: { current: GOOD, password: "x" } }))).status, 401);
    assert.equal((await r.everywhere.POST(req("/api/account/sign-out-everywhere", { method: "POST" }))).status, 401);
    assert.equal((await r.unlink.DELETE(req("/api/account/identities/google", { method: "DELETE" }), { params: Promise.resolve({ provider: "google" }) })).status, 401);
    const ok = await (await r.account.GET(req("/api/account", { cookie: a.cookie }))).json();
    assert.deepEqual([ok.success, ok.profile.email, typeof ok.providers.google], [true, "doors1@example.com", "boolean"]);
    assert.ok(!JSON.stringify(ok).includes("password_hash") && !JSON.stringify(ok).includes("scrypt"));
    assert.equal((await r.account.PUT(req("/api/account", { method: "PUT", cookie: a.cookie, origin: "https://evil.example", body: { name: "Evil Name" } }))).status, 403);
    assert.equal((await r.password.POST(req("/api/account/password", { method: "POST", cookie: a.cookie, origin: "https://evil.example", body: { current: GOOD, password: "a-brand-new-phrase-1" } }))).status, 403);
    assert.equal((await r.everywhere.POST(req("/api/account/sign-out-everywhere", { method: "POST", cookie: a.cookie, origin: "https://evil.example" }))).status, 403);
    assert.equal((await r.me.GET(req("/api/auth/me", { cookie: a.cookie }))).status, 200, "and the refused attempts changed nothing");
  });
  it("change the name, change the password with the old one, and end every session", async () => {
    const r = await routes();
    const a = await newClient("doors2@example.com");
    const put = await r.account.PUT(req("/api/account", { method: "PUT", cookie: a.cookie, body: { name: "Door Two" } }));
    assert.deepEqual(await put.json(), { success: true, name: "Door Two" });
    const wrong = await r.password.POST(req("/api/account/password", { method: "POST", cookie: a.cookie, body: { current: "nope-nope-nope", password: "a-brand-new-phrase-1" } }));
    assert.equal(wrong.status, 400);
    const good = await r.password.POST(req("/api/account/password", { method: "POST", cookie: a.cookie, body: { current: GOOD, password: "a-brand-new-phrase-1" } }));
    assert.equal(good.status, 200);
    assert.equal((await r.me.GET(req("/api/auth/me", { cookie: a.cookie }))).status, 200, "the session that changed it stays signed in");
    const out = await r.everywhere.POST(req("/api/account/sign-out-everywhere", { method: "POST", cookie: a.cookie }));
    assert.equal(out.status, 200);
    assert.match(out.headers.get("set-cookie") ?? "", /silpi_session=;|Max-Age=0/i);
    assert.equal((await r.me.GET(req("/api/auth/me", { cookie: a.cookie }))).status, 401);
  });
  it("limits guessing the current password", async () => {
    const r = await routes();
    const a = await newClient("doors3@example.com");
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await r.password.POST(req("/api/account/password", { method: "POST", cookie: a.cookie, body: { current: `wrong-guess-${i}-xxxx`, password: "a-brand-new-phrase-1" } }))).status;
    assert.equal(last, 429);
  });
});

describe("5. the pages and the way around", () => {
  it("every client page needs a client sign-in and sends everyone else to sign in and back", () => {
    for (const [file, next] of [["dashboard/page.tsx", '"/dashboard"'], ["my-projects/page.tsx", '"/my-projects"'], ["notifications/page.tsx", '"/notifications"'], ["profile/page.tsx", '"/profile"'], ["my-projects/[id]/page.tsx", "`/my-projects/${id}`"]] as const) {
      assert.ok(existsSync(path.join(process.cwd(), "src/app/(client)", file)), file);
      assert.ok(read(`src/app/(client)/${file}`).includes(`requireClient(${next})`), file);
    }
    assert.match(read("src/app/(client)/my-projects/[id]/page.tsx"), /if \(!p\) notFound\(\)/);
  });
  it("none of these addresses is a studio page, so the administrator guard does not catch them (and a studio page is not shadowed by one)", async () => {
    const mw = await import("@/middleware");
    for (const p of ["/dashboard", "/my-projects", "/my-projects/abc", "/notifications", "/profile"]) {
      assert.ok(!mw.config.matcher.some((m) => m === p || (m.endsWith("/:path*") && p.startsWith(m.slice(0, -6)))), p);
    }
    for (const studio of ["/projects", "/settings", "/clients", "/recurring-income"]) assert.ok(mw.config.matcher.includes(studio), `${studio} is still the studio's`);
  });
  it("the client header holds the five places the brief names, a New project button and updates, and nothing of the studio", () => {
    const shell = read("src/components/client/client-shell.tsx");
    const block = /const NAV = \[([\s\S]*?)\];/.exec(shell)![1]!;
    const items = [...block.matchAll(/href: "([^"]+)", label: "([^"]+)"/g)].map((m) => [m[2], m[1]]);
    assert.deepEqual(items, [["Dashboard", "/dashboard"], ["My Projects", "/my-projects"], ["AI Workspace", "/ai/builder"], ["Billing", "/ai/billing"], ["Profile", "/profile"]]);
    assert.match(shell, /href="\/clients\/new"/);
    assert.match(shell, /href="\/notifications"/);
    assert.ok(!/\/ai\/admin|recurring|\/clients\/quote|\/pricing|\/activity|\/settings/i.test(shell));
  });
  it("the AI workspace leads back to the dashboard and sends a visitor to the one sign-in page and back", () => {
    const ai = read("src/components/ai/ai-shell.tsx");
    assert.match(ai, /href: "\/dashboard", label: "Dashboard"/);
    assert.match(ai, /window\.location\.assign\(`\/sign-in\?next=\$\{encodeURIComponent\(pathname\)\}`\)/);
    assert.ok(!/import \{ SignIn \}/.test(ai));
  });
  it("the project page offers review, payment and the demo only at the right stage", () => {
    const t = read("src/app/(client)/my-projects/[id]/page.tsx");
    assert.match(t, /p\.next\.action === "review" && p\.quotationLink/);
    assert.match(t, /p\.next\.action === "pay" && p\.quotationLink/);
    assert.match(t, /p\.next\.action === "demo" && p\.demo/);
  });
});

describe("6. the administrator and client code are kept apart, under names that say so", () => {
  it("the studio's screens, its frame and the administrator console have meaningful names, the old names are gone, and nothing imports them", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    for (const p of ["src/components/studio/clients.tsx", "src/components/studio/dashboard.tsx", "src/components/layout/studio-shell.tsx", "src/components/ai/admin-dashboard.tsx", "src/components/client/client-shell.tsx"]) assert.ok(existsSync(path.join(process.cwd(), p)), p);
    for (const p of ["src/components/pages", "src/components/layout/app-shell.tsx", "src/components/ai/admin.tsx", "src/components/ai/sign-in.tsx"]) assert.ok(!existsSync(path.join(process.cwd(), p)), `${p} should be gone`);
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = path.join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(n) && /components\/pages\/|layout\/app-shell|@\/components\/ai\/admin"|\bAppShell\b|\bAiAdmin\b/.test(readFileSync(p, "utf8"))) offenders.push(path.relative(process.cwd(), p));
      }
    };
    walk(path.join(process.cwd(), "src"));
    assert.deepEqual(offenders, []);
  });
  it("the client's code never imports the studio's screens or the administrator console", async () => {
    const { readdirSync } = await import("node:fs");
    const clientFiles = readdirSync(path.join(process.cwd(), "src/components/client")).map((n) => `src/components/client/${n}`);
    for (const f of clientFiles) assert.ok(!/@\/components\/studio\/|components\/ai\/admin|layout\/studio-shell/.test(read(f)), f);
  });
});

// Client accounts: e-mail sign-up, sign-in, forgot password and reset, on a real database. No e-mail is really sent: the transport is replaced.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { looksLikeResetToken, TERMS_VERSION, validateEmail, validateName, validatePassword } from "@/lib/client-auth";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-client-accounts-"));
const GOOD = "a-correct-horse-battery";
let seq = 0;
type Sent = { to: string; subject: string; text: string; from: string };
const sent: Sent[] = [];
const mods = async () => ({
  acc: await import("@/server/client-accounts"),
  mail: await import("@/server/mailer"),
  auth: await import("@/lib/admin-auth"),
  ten: await import("@/server/tenancy"),
  db: await import("@/lib/business/db"),
  http: await import("@/server/auth-http"),
});
const routes = async () => ({
  signup: await import("@/app/api/auth/signup/route"),
  login: await import("@/app/api/auth/login/route"),
  forgot: await import("@/app/api/auth/forgot/route"),
  reset: await import("@/app/api/auth/reset/route"),
  me: await import("@/app/api/auth/me/route"),
  leads: await import("@/app/api/workspace/leads/route"),
});
function req(url: string, init: { method?: string; body?: object; cookie?: string; headers?: Record<string, string>; origin?: string | null } = {}): NextRequest {
  const headers: Record<string, string> = { host: "localhost:3000", "x-forwarded-for": `10.9.0.${++seq % 250}`, ...(init.headers ?? {}) };
  if (init.origin !== null) headers.origin = init.origin ?? "http://localhost:3000";
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers, body: init.body ? JSON.stringify(init.body) : undefined });
}
const cookieOf = (res: Response) => `silpi_session=${/silpi_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
const fails = async (fn: () => unknown, pattern: RegExp) => { try { await fn(); } catch (e) { assert.match((e as Error).message, pattern); return; } assert.fail(`expected an error matching ${pattern}`); };
const tokenIn = (m: Sent) => /reset-password\?token=([A-Za-z0-9_-]+)/.exec(m.text)![1]!;
const wait = () => new Promise((r) => setTimeout(r, 40));

before(async () => {
  process.env.SILPI_DB_PATH = path.join(dir, "ca.db");
  process.env.SILPI_ADMIN_TOKEN = "client-accounts-test-token-0123456789";
  const { mail } = await mods();
  mail.setMailTransport(async (m) => { sent.push(m); });
});
beforeEach(async () => {
  const { auth } = await mods();
  auth.resetLoginAttempts();
  sent.length = 0;
});
after(async () => {
  const { mail } = await mods();
  mail.setMailTransport(null);
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("1. the rules", () => {
  it("accepts an ordinary email address, stores it lower case, and refuses the rest in plain words", () => {
    assert.equal(validateEmail("  Asha.K+shop@Example.CO.in "), "asha.k+shop@example.co.in");
    for (const bad of ["", "no-at-sign", "a@b", "a@b.c", "a b@example.com", "a@@example.com", "a..b@example.com", ".a@example.com", "a.@example.com", "a@exa mple.com", `${"a".repeat(65)}@example.com`, `a@${"b".repeat(250)}.com`, null, undefined, 5, {}]) {
      assert.throws(() => validateEmail(bad), /valid email/, String(bad).slice(0, 30));
    }
  });
  it("needs a real name", () => {
    assert.equal(validateName("  Asha   Kumar "), "Asha Kumar");
    for (const bad of ["", "A", "x".repeat(81), "<script>", "a\u0007b", null, 7]) assert.throws(() => validateName(bad), /name/i, String(bad).slice(0, 20));
  });
  it("needs a password of 10 to 200 characters that is not obvious, not repeated, and not the email", () => {
    assert.equal(validatePassword(GOOD), GOOD);
    assert.throws(() => validatePassword("short"), /at least 10/);
    assert.throws(() => validatePassword("x".repeat(201)), /at most 200/);
    assert.throws(() => validatePassword("aaaaaaaaaaaa"), /repeated/);
    assert.throws(() => validatePassword("Password12345"), /too easy/);
    assert.throws(() => validatePassword("ashakumar-2026!", { email: "ashakumar@example.com" }), /email/);
    assert.throws(() => validatePassword("ashakumar@example.com", { email: "ashakumar@example.com" }), /email/);
    assert.throws(() => validatePassword(undefined), /at least/);
  });
  it("recognises the shape of a reset token and nothing else", () => {
    assert.ok(looksLikeResetToken("a".repeat(43)));
    for (const bad of ["", "short", "a".repeat(100), `${"a".repeat(42)}!`, `${"a".repeat(42)} `, null, 5, "../../etc/passwd".padEnd(43, "a")]) assert.equal(looksLikeResetToken(bad), false, String(bad).slice(0, 20));
  });
});

describe("2. sign-up", () => {
  it("creates the account, a personal workspace the person owns, and records the terms they accepted; the password is stored only as a salted hash", async () => {
    const { acc, ten, db } = await mods();
    const { user, organization } = await acc.signUp({ name: "Asha Kumar", email: "Asha@Example.com", password: GOOD, acceptTerms: true });
    assert.deepEqual([user.email, organization.type, ten.roleOf(organization.id, user.id)], ["asha@example.com", "individual", "owner"]);
    assert.notEqual(organization.id, ten.AGENCY_ORG_ID, "never inside the agency's own organization");
    const row = db.getDb().prepare("SELECT password_hash AS h, terms_version AS v, terms_accepted_at AS at FROM users WHERE id = ?").get(user.id) as { h: string; v: string; at: string };
    assert.match(row.h, /^scrypt\$/);
    assert.ok(!row.h.includes(GOOD));
    assert.deepEqual(row.v, TERMS_VERSION);
    assert.match(row.at, /^\d{4}-\d\d-\d\dT/);
    assert.ok(await ten.authenticate("asha@example.com", GOOD), "and the password works");
    assert.equal(await ten.authenticate("asha@example.com", `${GOOD}x`), null);
  });
  it("refuses a second account for the same email in any letter case, and the first one is untouched", async () => {
    const { acc, db } = await mods();
    await acc.signUp({ name: "Ben", email: "ben@example.com", password: GOOD, acceptTerms: true });
    await fails(() => acc.signUp({ name: "Ben Two", email: "BEN@EXAMPLE.COM", password: "a-different-long-phrase", acceptTerms: true }), /already exists/);
    assert.equal((db.getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'ben@example.com'").get() as { n: number }).n, 1);
    assert.equal((db.getDb().prepare("SELECT COUNT(*) AS n FROM organizations WHERE name LIKE 'Ben%'").get() as { n: number }).n, 1, "no stray workspace from the refused attempt");
  });
  it("needs the terms accepted, a valid email, a name and a good password, and creates nothing otherwise", async () => {
    const { acc, db } = await mods();
    const before = (db.getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    for (const [input, pattern] of [
      [{ name: "C", email: "c@example.com", password: GOOD, acceptTerms: true }, /name/i],
      [{ name: "Cara", email: "bad", password: GOOD, acceptTerms: true }, /valid email/],
      [{ name: "Cara", email: "cara@example.com", password: "short", acceptTerms: true }, /at least 10/],
      [{ name: "Cara", email: "cara@example.com", password: GOOD, acceptTerms: false }, /accept the Terms/],
      [{ name: "Cara", email: "cara@example.com", password: GOOD, acceptTerms: "true" }, /accept the Terms/],
      [{ name: "Cara", email: "cara@example.com", password: GOOD }, /accept the Terms/],
    ] as const) await fails(() => acc.signUp(input as never), pattern);
    assert.equal((db.getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n, before);
  });
});

describe("3. the sign-up and sign-in doors", () => {
  it("sign-up signs the person in, /me knows them, and sign-in works again later", async () => {
    const r = await routes();
    const res = await r.signup.POST(req("/api/auth/signup", { method: "POST", body: { name: "Dev Patel", email: "dev@example.com", password: GOOD, acceptTerms: true } }));
    assert.equal(res.status, 201);
    const cookie = cookieOf(res);
    assert.match(res.headers.get("set-cookie") ?? "", /HttpOnly/i);
    assert.match(res.headers.get("set-cookie") ?? "", /SameSite=strict/i);
    const me = await (await r.me.GET(req("/api/auth/me", { cookie }))).json();
    assert.deepEqual([me.user.email, me.organization.type, me.role], ["dev@example.com", "individual", "owner"]);
    const again = await r.login.POST(req("/api/auth/login", { method: "POST", body: { email: "dev@example.com", password: GOOD } }));
    assert.equal(again.status, 200);
  });
  it("answers plainly: duplicate, missing terms, bad body, wrong site, and too many tries", async () => {
    const r = await routes();
    const body = { name: "Eve", email: "eve@example.com", password: GOOD, acceptTerms: true };
    assert.equal((await r.signup.POST(req("/api/auth/signup", { method: "POST", body }))).status, 201);
    const dup = await r.signup.POST(req("/api/auth/signup", { method: "POST", body }));
    assert.equal(dup.status, 400);
    assert.match((await dup.json()).error, /already exists/);
    assert.equal((await r.signup.POST(req("/api/auth/signup", { method: "POST", body: { ...body, email: "eve2@example.com", acceptTerms: false } }))).status, 400);
    assert.equal((await r.signup.POST(req("/api/auth/signup", { method: "POST", body: { ...body, email: "eve3@example.com" }, origin: "https://evil.example" }))).status, 403, "another website cannot sign someone up");
    assert.equal((await r.signup.POST(req("/api/auth/signup", { method: "POST", origin: null, body }))).status, 403);
    const notJson = new NextRequest("http://localhost:3000/api/auth/signup", { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" }, body: "{oops" });
    assert.equal((await r.signup.POST(notJson)).status, 400);
    const arrayBody = await r.signup.POST(req("/api/auth/signup", { method: "POST", body: [1, 2] as unknown as object }));
    assert.equal(arrayBody.status, 400);
  });
  it("limits repeated sign-ups from one address and for one email", async () => {
    const r = await routes();
    const same = { host: "localhost:3000", "x-forwarded-for": "10.77.0.1" };
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await r.signup.POST(req("/api/auth/signup", { method: "POST", headers: same, body: { name: "Flood", email: `flood${i}@example.com`, password: "short", acceptTerms: true } }))).status;
    assert.equal(last, 429, "one address cannot keep trying");
    const { auth } = await mods();
    auth.resetLoginAttempts();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await r.signup.POST(req("/api/auth/signup", { method: "POST", body: { name: "Same", email: "same@example.com", password: "short", acceptTerms: true } }))).status);
    assert.ok(codes.includes(429), codes.join(","));
  });
  it("a client's session cannot open any administrator door", async () => {
    const r = await routes();
    const mw = await import("@/middleware");
    const res = await r.signup.POST(req("/api/auth/signup", { method: "POST", body: { name: "Gus", email: "gus@example.com", password: GOOD, acceptTerms: true } }));
    const cookie = cookieOf(res);
    for (const p of ["/api/business/leads", "/api/business/recurring-income", "/api/projects"]) assert.equal(mw.middleware(req(p, { cookie })).status, 401, p);
    assert.equal(mw.middleware(req("/recurring-income", { cookie })).status, 307, "and the studio pages send them to the administrator sign-in");
    const admin = await import("@/app/api/admin/session/route");
    const who = await (await admin.GET(req("/api/admin/session", { cookie }))).json();
    assert.equal(who.authenticated, false);
  });
  it("two clients each see only their own workspace", async () => {
    const r = await routes();
    const a = await r.signup.POST(req("/api/auth/signup", { method: "POST", body: { name: "Hal", email: "hal@example.com", password: GOOD, acceptTerms: true } }));
    const b = await r.signup.POST(req("/api/auth/signup", { method: "POST", body: { name: "Ivy", email: "ivy@example.com", password: GOOD, acceptTerms: true } }));
    const la = await (await r.leads.GET(req("/api/workspace/leads", { cookie: cookieOf(a) }))).json();
    const lb = await (await r.leads.GET(req("/api/workspace/leads", { cookie: cookieOf(b) }))).json();
    assert.notEqual(la.organizationId, lb.organizationId);
    assert.deepEqual([la.leads, lb.leads], [[], []]);
    assert.equal((await r.leads.GET(req("/api/workspace/leads"))).status, 401);
  });
});

describe("4. forgot password", () => {
  it("answers the same whether or not the address has an account, and only sends a message to a real account", async () => {
    const { acc } = await mods();
    const r = await routes();
    await acc.signUp({ name: "Jo", email: "jo@example.com", password: GOOD, acceptTerms: true });
    const real = await r.forgot.POST(req("/api/auth/forgot", { method: "POST", body: { email: "jo@example.com" } }));
    const none = await r.forgot.POST(req("/api/auth/forgot", { method: "POST", body: { email: "nobody@example.com" } }));
    const junk = await r.forgot.POST(req("/api/auth/forgot", { method: "POST", body: { email: "not an email" } }));
    await wait();
    assert.deepEqual([real.status, none.status, junk.status], [200, 200, 200]);
    const [bodyReal, bodyNone, bodyJunk] = [await real.json(), await none.json(), await junk.json()];
    assert.deepEqual(bodyReal, bodyNone);
    assert.deepEqual(bodyNone, bodyJunk);
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0]!.to, sent[0]!.subject], ["jo@example.com", "Reset your SILPI AI password"]);
    assert.match(sent[0]!.text, /http:\/\/localhost:3000\/reset-password\?token=[A-Za-z0-9_-]{43}/);
    assert.match(sent[0]!.text, /60 minutes/);
  });
  it("keeps only a fingerprint of the token, and a newer request cancels the older link", async () => {
    const { acc, db } = await mods();
    const r = await routes();
    await acc.signUp({ name: "Kai", email: "kai@example.com", password: GOOD, acceptTerms: true });
    await r.forgot.POST(req("/api/auth/forgot", { method: "POST", body: { email: "kai@example.com" } }));
    await wait();
    const first = tokenIn(sent[0]!);
    assert.equal((db.getDb().prepare("SELECT COUNT(*) AS n FROM password_resets WHERE token_hash = ?").get(first) as { n: number }).n, 0, "the raw token is not in the database");
    const stored = (db.getDb().prepare("SELECT token_hash AS h FROM password_resets").all() as { h: string }[]).map((x) => x.h);
    assert.ok(stored.every((h) => /^[0-9a-f]{64}$/.test(h)));
    await r.forgot.POST(req("/api/auth/forgot", { method: "POST", body: { email: "kai@example.com" } }));
    await wait();
    const second = tokenIn(sent[1]!);
    assert.notEqual(first, second);
    await fails(() => acc.resetPassword(first, "a-brand-new-phrase-1"), /expired or was already used/);
    await acc.resetPassword(second, "a-brand-new-phrase-1");
  });
  it("does not send to a disabled account, and limits how often one address can ask", async () => {
    const { acc, db } = await mods();
    const r = await routes();
    const { user } = await acc.signUp({ name: "Lee", email: "lee@example.com", password: GOOD, acceptTerms: true });
    db.getDb().prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(user.id);
    await r.forgot.POST(req("/api/auth/forgot", { method: "POST", body: { email: "lee@example.com" } }));
    await wait();
    assert.equal(sent.length, 0);
    db.getDb().prepare("UPDATE users SET status = 'active' WHERE id = ?").run(user.id);
    for (let i = 0; i < 6; i++) await r.forgot.POST(req("/api/auth/forgot", { method: "POST", body: { email: "lee@example.com" } }));
    await wait();
    assert.ok(sent.length <= 3, `at most 3 messages for one email, got ${sent.length}`);
  });
  it("a failing mail server does not change what the visitor sees", async () => {
    const { acc, mail } = await mods();
    const r = await routes();
    await acc.signUp({ name: "Mia", email: "mia@example.com", password: GOOD, acceptTerms: true });
    mail.setMailTransport(async () => { throw new Error("SMTP down"); });
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const res = await r.forgot.POST(req("/api/auth/forgot", { method: "POST", body: { email: "mia@example.com" } }));
      await wait();
      assert.equal(res.status, 200);
    } finally {
      console.error = quiet;
      mail.setMailTransport(async (m) => { sent.push(m); });
    }
  });
  it("the link points to SILPI_PUBLIC_URL when it is set, to this server on a development server, and nowhere on a production server without one", async () => {
    const { http } = await mods();
    const r = req("/api/auth/forgot", { headers: { host: "evil.example" } });
    assert.equal(http.publicBaseUrl(r, { NODE_ENV: "development" }), "http://localhost:3000");
    assert.equal(http.publicBaseUrl(r, { NODE_ENV: "production" }), null, "a Host header written by a visitor never decides where the link points");
    assert.equal(http.publicBaseUrl(r, { NODE_ENV: "production", SILPI_PUBLIC_URL: "https://app.silpi.example/" }), "https://app.silpi.example");
    assert.equal(http.publicBaseUrl(r, { NODE_ENV: "development", SILPI_PUBLIC_URL: "https://app.silpi.example" }), "https://app.silpi.example");
  });
});

describe("5. choosing a new password", () => {
  async function ask(email: string) {
    const r = await routes();
    sent.length = 0;
    await r.forgot.POST(req("/api/auth/forgot", { method: "POST", body: { email } }));
    await wait();
    return tokenIn(sent[0]!);
  }
  it("changes the password once, ends every session, and the old password stops working", async () => {
    const { acc, ten } = await mods();
    const r = await routes();
    await acc.signUp({ name: "Nia", email: "nia@example.com", password: GOOD, acceptTerms: true });
    const login = await r.login.POST(req("/api/auth/login", { method: "POST", body: { email: "nia@example.com", password: GOOD } }));
    const cookie = cookieOf(login);
    assert.equal((await r.me.GET(req("/api/auth/me", { cookie }))).status, 200);
    const token = await ask("nia@example.com");
    const done = await r.reset.POST(req("/api/auth/reset", { method: "POST", body: { token, password: "a-brand-new-phrase-1" } }));
    assert.equal(done.status, 200);
    assert.equal((await r.me.GET(req("/api/auth/me", { cookie }))).status, 401, "the old session is gone");
    assert.equal(await ten.authenticate("nia@example.com", GOOD), null);
    assert.ok(await ten.authenticate("nia@example.com", "a-brand-new-phrase-1"));
    const reuse = await r.reset.POST(req("/api/auth/reset", { method: "POST", body: { token, password: "yet-another-phrase-3" } }));
    assert.equal(reuse.status, 400);
    assert.match((await reuse.json()).error, /expired or was already used/);
    assert.equal(done.headers.get("set-cookie"), null, "it does not sign anyone in");
  });
  it("refuses a bad password without spending the link, and an expired, unknown or malformed link", async () => {
    const { acc, db } = await mods();
    const r = await routes();
    await acc.signUp({ name: "Oli", email: "oli@example.com", password: GOOD, acceptTerms: true });
    const token = await ask("oli@example.com");
    const weak = await r.reset.POST(req("/api/auth/reset", { method: "POST", body: { token, password: "short" } }));
    assert.equal(weak.status, 400);
    assert.equal((await r.reset.POST(req("/api/auth/reset", { method: "POST", body: { token, password: "a-brand-new-phrase-1" } }))).status, 200, "the link still worked after a weak password was refused");
    const t2 = await ask("oli@example.com");
    db.getDb().prepare("UPDATE password_resets SET expires_at = ? WHERE used_at IS NULL").run(new Date(Date.now() - 1000).toISOString());
    assert.equal((await r.reset.POST(req("/api/auth/reset", { method: "POST", body: { token: t2, password: "another-new-phrase-2" } }))).status, 400);
    for (const bad of ["", "x", "a".repeat(43), null, 5]) assert.equal((await r.reset.POST(req("/api/auth/reset", { method: "POST", body: { token: bad, password: "another-new-phrase-2" } }))).status, 400, String(bad));
  });
  it("two people using the same link at once cannot both succeed", async () => {
    const { acc, ten } = await mods();
    await acc.signUp({ name: "Pat", email: "pat@example.com", password: GOOD, acceptTerms: true });
    const token = await ask("pat@example.com");
    const results = await Promise.allSettled([acc.resetPassword(token, "first-new-phrase-1"), acc.resetPassword(token, "second-new-phrase-2")]);
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    const winner = results[0]!.status === "fulfilled" ? "first-new-phrase-1" : "second-new-phrase-2";
    assert.ok(await ten.authenticate("pat@example.com", winner));
  });
  it("an account disabled after the link was sent can no longer use it", async () => {
    const { acc, db, ten } = await mods();
    const { user } = await acc.signUp({ name: "Quin", email: "quin@example.com", password: GOOD, acceptTerms: true });
    const token = await ask("quin@example.com");
    db.getDb().prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(user.id);
    await fails(() => acc.resetPassword(token, "a-brand-new-phrase-1"), /expired or was already used/);
    db.getDb().prepare("UPDATE users SET status = 'active' WHERE id = ?").run(user.id);
    assert.ok(await ten.authenticate("quin@example.com", GOOD), "and the old password is unchanged");
  });
  it("is limited per address and must come from this site", async () => {
    const r = await routes();
    assert.equal((await r.reset.POST(req("/api/auth/reset", { method: "POST", origin: "https://evil.example", body: { token: "a".repeat(43), password: GOOD } }))).status, 403);
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await r.reset.POST(req("/api/auth/reset", { method: "POST", headers: { "x-forwarded-for": "10.88.0.1" }, body: { token: "a".repeat(43), password: GOOD } }))).status;
    assert.equal(last, 429);
  });
});

describe("6. sending mail", () => {
  it("prints the message instead of sending it, and says so, until SMTP is set up", async () => {
    const { mail } = await mods();
    mail.setMailTransport(null);
    const keep = { host: process.env.SILPI_SMTP_HOST, from: process.env.SILPI_SMTP_FROM };
    delete process.env.SILPI_SMTP_HOST;
    delete process.env.SILPI_SMTP_FROM;
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try {
      const result = await mail.sendMail({ to: "x@example.com", subject: "Hello", text: "Body line" });
      assert.deepEqual(result, { delivered: false, logged: true });
      assert.match(lines.join("\n"), /SMTP is not set up, so this was NOT sent[\s\S]*x@example\.com[\s\S]*Body line/);
    } finally {
      console.log = log;
      if (keep.host) process.env.SILPI_SMTP_HOST = keep.host;
      if (keep.from) process.env.SILPI_SMTP_FROM = keep.from;
      mail.setMailTransport(async (m) => { sent.push(m); });
    }
    assert.equal(mail.smtpConfigured({ SILPI_SMTP_HOST: "smtp.example.com", SILPI_SMTP_FROM: "SILPI <no-reply@example.com>" }), true);
    assert.equal(mail.smtpConfigured({ SILPI_SMTP_HOST: "smtp.example.com" }), false);
    assert.equal(mail.smtpConfigured({}), false);
  });
});

describe("7. the screens", () => {
  const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
  it("the sign-in screen offers sign-in, sign-up, forgot password and the terms, and keeps Google and Facebook visibly switched off until they are set up", () => {
    const s = read("src/components/client/client-auth.tsx");
    for (const text of ["Sign in", "Create account", "Forgot password?", "Continue with Google", "Continue with Facebook", "Terms of Service", "Privacy Policy"]) assert.ok(s.includes(text), text);
    assert.match(s, /disabled/);
    assert.match(s, /safeNext\(params\.get\("next"\), CLIENT_HOME\)/, "the intended destination is kept, and only a path on this site is accepted");
  });
  it("the reset page is not indexed and does not leak its link in a referrer; the terms and privacy pages exist and say plainly that the text is still to be written", () => {
    assert.match(read("src/app/reset-password/page.tsx"), /no-referrer/);
    assert.match(read("src/app/reset-password/page.tsx"), /index: false/);
    assert.match(read("src/components/client/legal-page.tsx"), /has not been added yet/);
    assert.match(read("src/app/terms/page.tsx"), /Terms of Service/);
    assert.match(read("src/app/privacy/page.tsx"), /Privacy Policy/);
  });
  it("the old member sign-in page now leads to the single sign-in page, keeping a safe destination", () => {
    const s = read("src/app/login/page.tsx");
    assert.match(s, /redirect\(/);
    assert.match(s, /safeNext\(/);
  });
});

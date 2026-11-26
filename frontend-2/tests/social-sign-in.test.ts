// Google and Facebook sign-in, against a stand-in for both providers (no network). Every refusal path is exercised: the real providers cannot be asked to misbehave.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { authorizeUrl, isOAuthError, OAUTH_ERRORS, providerCredentials, redirectUriFor } from "@/lib/oauth-providers";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-social-"));
const BASE = "http://localhost:3000";
const GOOD = "a-correct-horse-battery";
let seq = 0;

type Profile = Record<string, unknown>;
const people = new Map<string, { provider: "google" | "facebook"; profile: Profile }>();
const tokenCalls: { url: string; form: URLSearchParams }[] = [];
const userCalls: { url: string; auth: string | null }[] = [];
const fakeFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const isToken = /oauth2\.googleapis\.com\/token|graph\.facebook\.com\/v[\d.]+\/oauth\/access_token/.test(url);
  if (isToken) {
    const form = new URLSearchParams(String(init.body));
    tokenCalls.push({ url, form });
    const who = people.get(form.get("code") ?? "");
    return who ? json({ access_token: `tok-${form.get("code")}` }) : json({ error: "invalid_grant" }, 400);
  }
  const auth = new Headers(init.headers).get("authorization");
  userCalls.push({ url, auth });
  const who = people.get((auth ?? "").replace("Bearer tok-", ""));
  return who ? json(who.profile) : json({ error: "bad token" }, 401);
};

const mods = async () => ({ o: await import("@/server/oauth"), ten: await import("@/server/tenancy"), db: await import("@/lib/business/db"), auth: await import("@/lib/admin-auth"), acc: await import("@/server/client-accounts") });
const routes = async () => ({
  start: await import("@/app/api/auth/oauth/[provider]/start/route"),
  callback: await import("@/app/api/auth/oauth/[provider]/callback/route"),
  providers: await import("@/app/api/auth/providers/route"),
  me: await import("@/app/api/auth/me/route"),
  login: await import("@/app/api/auth/login/route"),
});
const req = (url: string, init: { cookie?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`${BASE}${url}`, { headers: { host: "localhost:3000", "x-forwarded-for": `10.5.0.${++seq % 250}`, ...(init.headers ?? {}), ...(init.cookie ? { cookie: init.cookie } : {}) } });
const ctx = (provider: string) => ({ params: Promise.resolve({ provider }) });
const cookieValue = (res: Response, name: string) => new RegExp(`${name}=([^;]*)`).exec(res.headers.get("set-cookie") ?? "")?.[1];

const google = (sub: string, email: string, over: Profile = {}): Profile => ({ sub, email, email_verified: true, name: "Gia Google", ...over });
const facebook = (id: string, email: string | undefined, over: Profile = {}): Profile => ({ id, ...(email ? { email } : {}), name: "Fay Facebook", ...over });

/** Runs the whole round trip for a person the stand-in knows under `code`. */
async function roundTrip(provider: "google" | "facebook", code: string, opts: { next?: string; cookie?: string; link?: boolean; mangle?: (s: { state: string }) => { state?: string; cookieState?: string } } = {}) {
  const r = await routes();
  const q = new URLSearchParams();
  if (opts.next) q.set("next", opts.next);
  if (opts.link) q.set("link", "1");
  const start = await r.start.GET(req(`/api/auth/oauth/${provider}/start?${q}`, { cookie: opts.cookie }), ctx(provider));
  const location = start.headers.get("location") ?? "";
  const state = new URL(location, BASE).searchParams.get("state") ?? "";
  const held = cookieValue(start, "silpi_oauth") ?? "";
  const m = opts.mangle?.({ state });
  const cb = await r.callback.GET(req(`/api/auth/oauth/${provider}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(m?.state ?? state)}`, { cookie: `silpi_oauth=${m?.cookieState ?? held}` }), ctx(provider));
  return { start, location, state, held, cb, to: new URL(cb.headers.get("location") ?? "", BASE), session: cookieValue(cb, "silpi_session") };
}
const errorOf = (x: { to: URL }) => x.to.searchParams.get("error");

before(() => {
  process.env.SILPI_DB_PATH = path.join(dir, "social.db");
  process.env.SILPI_ADMIN_TOKEN = "social-test-token-0123456789abcdef";
  process.env.SILPI_PUBLIC_URL = BASE;
  process.env.SILPI_GOOGLE_CLIENT_ID = "google-client-id-123";
  process.env.SILPI_GOOGLE_CLIENT_SECRET = "google-SECRET-do-not-leak-456";
  process.env.SILPI_FACEBOOK_APP_ID = "facebook-app-id-789";
  process.env.SILPI_FACEBOOK_APP_SECRET = "facebook-SECRET-do-not-leak-012";
});
beforeEach(async () => {
  const { o, auth } = await mods();
  o.setOAuthFetch(fakeFetch);
  auth.resetLoginAttempts();
  people.clear();
  tokenCalls.length = 0;
  userCalls.length = 0;
});
after(async () => {
  const { o } = await mods();
  o.setOAuthFetch(null);
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("1. what is configured", () => {
  it("a method is usable only when both its id and its secret are set, and the answer reveals only yes or no", async () => {
    assert.deepEqual(providerCredentials("google", { SILPI_GOOGLE_CLIENT_ID: "a", SILPI_GOOGLE_CLIENT_SECRET: "b" }), { id: "a", secret: "b" });
    assert.equal(providerCredentials("google", { SILPI_GOOGLE_CLIENT_ID: "a" }), null);
    assert.equal(providerCredentials("facebook", { SILPI_FACEBOOK_APP_SECRET: "b" }), null);
    assert.equal(providerCredentials("facebook", {}), null);
    const r = await routes();
    const body = await (await r.providers.GET(req("/api/auth/providers"))).json();
    assert.deepEqual(body, { success: true, google: true, facebook: true });
    assert.ok(!JSON.stringify(body).includes("SECRET") && !JSON.stringify(body).includes("client-id"));
  });
  it("nothing is usable on a production server that does not know its own public address", async () => {
    const r = await routes();
    const keep = { url: process.env.SILPI_PUBLIC_URL, env: process.env.NODE_ENV };
    delete process.env.SILPI_PUBLIC_URL;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      assert.deepEqual(await (await r.providers.GET(req("/api/auth/providers"))).json(), { success: true, google: false, facebook: false });
      const start = await r.start.GET(req("/api/auth/oauth/google/start"), ctx("google"));
      assert.equal(new URL(start.headers.get("location")!, BASE).searchParams.get("error"), "not-configured");
    } finally {
      process.env.SILPI_PUBLIC_URL = keep.url;
      (process.env as Record<string, string>).NODE_ENV = keep.env!;
    }
  });
  it("every failure has a plain message, and only known codes are accepted from an address", () => {
    for (const code of Object.keys(OAUTH_ERRORS)) assert.ok(isOAuthError(code) && OAUTH_ERRORS[code as keyof typeof OAUTH_ERRORS].length > 20, code);
    for (const bad of ["<script>", "constructor", "__proto__", "", null, undefined, 5, "toString"]) assert.equal(isOAuthError(bad), false, String(bad));
  });
});

describe("2. starting", () => {
  it("sends the person to Google with a one-time state, PKCE, our id and our exact return address, and keeps the state in a short-lived cookie of this browser", async () => {
    const x = await roundTrip("google", "never-used");
    const url = new URL(x.location);
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.deepEqual([url.searchParams.get("client_id"), url.searchParams.get("redirect_uri"), url.searchParams.get("response_type"), url.searchParams.get("scope"), url.searchParams.get("code_challenge_method")], ["google-client-id-123", `${BASE}/api/auth/oauth/google/callback`, "code", "openid email profile", "S256"]);
    assert.ok(url.searchParams.get("state")!.length >= 40 && url.searchParams.get("code_challenge")!.length >= 40);
    assert.ok(!x.location.includes("SECRET"), "the secret never reaches the browser");
    const set = x.start.headers.get("set-cookie") ?? "";
    assert.match(set, /silpi_oauth=/);
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=lax/i);
    assert.match(set, /Max-Age=600/i);
    assert.match(set, /Path=\/api\/auth\/oauth/i);
    assert.equal(x.held, x.state);
    assert.equal(x.start.headers.get("cache-control"), "no-store");
  });
  it("sends the person to Facebook with the right scope", async () => {
    const x = await roundTrip("facebook", "never-used");
    const url = new URL(x.location);
    assert.match(url.origin + url.pathname, /^https:\/\/www\.facebook\.com\/v[\d.]+\/dialog\/oauth$/);
    assert.deepEqual([url.searchParams.get("client_id"), url.searchParams.get("scope"), url.searchParams.get("redirect_uri")], ["facebook-app-id-789", "email,public_profile", `${BASE}/api/auth/oauth/facebook/callback`]);
    assert.equal(url.searchParams.get("code_challenge"), null);
  });
  it("gives every sign-in its own state, and refuses an unknown method", async () => {
    const a = await roundTrip("google", "x");
    const b = await roundTrip("google", "x");
    assert.notEqual(a.state, b.state);
    const r = await routes();
    assert.equal((await r.start.GET(req("/api/auth/oauth/twitter/start"), ctx("twitter"))).status, 404);
    assert.equal((await r.callback.GET(req("/api/auth/oauth/twitter/callback?code=a&state=b"), ctx("twitter"))).status, 404);
    assert.equal((await r.start.GET(req("/api/auth/oauth/..%2Fx/start"), ctx("../x"))).status, 404);
  });
  it("the redirect address is built from the studio's configured address, never from a header the visitor wrote", async () => {
    const r = await routes();
    const start = await r.start.GET(req("/api/auth/oauth/google/start", { headers: { host: "evil.example", "x-forwarded-host": "evil.example" } }), ctx("google"));
    assert.equal(new URL(start.headers.get("location")!).searchParams.get("redirect_uri"), `${BASE}/api/auth/oauth/google/callback`);
    assert.equal(redirectUriFor("facebook", "https://app.example.com/"), "https://app.example.com/api/auth/oauth/facebook/callback");
    assert.ok(authorizeUrl("google", { clientId: "i", redirectUri: "r", state: "s" }).includes("state=s"));
  });
});

describe("3. signing in", () => {
  it("a new Google person gets an account, their own workspace and a session, and goes where they were headed", async () => {
    const { ten, db } = await mods();
    people.set("code-gia", { provider: "google", profile: google("g-1", "Gia@Example.com") });
    const x = await roundTrip("google", "code-gia", { next: "/ai/billing" });
    assert.equal(x.cb.status, 302);
    assert.equal(x.to.pathname, "/ai/billing");
    assert.equal(x.to.searchParams.get("error"), null);
    assert.ok(x.session && x.session.length > 20, "a session was started");
    const r = await routes();
    const me = await (await r.me.GET(req("/api/auth/me", { cookie: `silpi_session=${x.session}` }))).json();
    assert.deepEqual([me.user.email, me.organization.type, me.role], ["gia@example.com", "individual", "owner"]);
    const user = db.getDb().prepare("SELECT password_hash AS h, terms_version AS v FROM users WHERE email = 'gia@example.com'").get() as { h: string; v: string };
    assert.deepEqual({ ...user }, { h: "oauth$none", v: "2026-11" });
    assert.equal(await ten.authenticate("gia@example.com", "oauth$none"), null, "there is no password to type");
    assert.equal(await ten.authenticate("gia@example.com", GOOD), null);
    const id = db.getDb().prepare("SELECT provider, subject, email_verified AS v FROM auth_identities").all() as { provider: string; subject: string; v: number }[];
    assert.deepEqual(id.map((x) => ({ ...x })), [{ provider: "google", subject: "g-1", v: 1 }]);
    assert.equal(x.cb.headers.get("cache-control"), "no-store");
    assert.match(x.cb.headers.get("set-cookie") ?? "", /silpi_oauth=;/, "the one-time cookie is cleared");
  });
  it("the same person signing in again is the same account: no second account, no second workspace", async () => {
    const { db } = await mods();
    people.set("c1", { provider: "google", profile: google("g-2", "same@example.com") });
    const a = await roundTrip("google", "c1");
    const b = await roundTrip("google", "c1");
    const r = await routes();
    const idA = (await (await r.me.GET(req("/api/auth/me", { cookie: `silpi_session=${a.session}` }))).json()).user.id;
    const idB = (await (await r.me.GET(req("/api/auth/me", { cookie: `silpi_session=${b.session}` }))).json()).user.id;
    assert.equal(idA, idB);
    assert.equal((db.getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'same@example.com'").get() as { n: number }).n, 1);
    assert.equal((db.getDb().prepare("SELECT COUNT(*) AS n FROM auth_identities WHERE subject = 'g-2'").get() as { n: number }).n, 1);
  });
  it("a person who changes their e-mail at Google still signs in to the same account: the provider's own id is what counts", async () => {
    people.set("c1", { provider: "google", profile: google("g-3", "old@example.com") });
    const a = await roundTrip("google", "c1");
    people.set("c2", { provider: "google", profile: google("g-3", "new@example.com") });
    const b = await roundTrip("google", "c2");
    const r = await routes();
    const idA = (await (await r.me.GET(req("/api/auth/me", { cookie: `silpi_session=${a.session}` }))).json()).user;
    const idB = (await (await r.me.GET(req("/api/auth/me", { cookie: `silpi_session=${b.session}` }))).json()).user;
    assert.equal(idA.id, idB.id);
    assert.equal(idB.email, "old@example.com");
  });
  it("a new Facebook person gets an account too, marked as not vouched for", async () => {
    const { db } = await mods();
    people.set("code-fay", { provider: "facebook", profile: facebook("f-1", "fay@example.com") });
    const x = await roundTrip("facebook", "code-fay");
    assert.ok(x.session);
    assert.equal(x.to.pathname, "/ai", "with no destination given they go to the client home");
    assert.deepEqual({ ...(db.getDb().prepare("SELECT provider, email_verified AS v FROM auth_identities WHERE subject = 'f-1'").get() as object) }, { provider: "facebook", v: 0 });
  });
  it("sends the secret and the PKCE verifier to the provider's token door, and the token in a header rather than an address", async () => {
    people.set("c1", { provider: "google", profile: google("g-4", "tok@example.com") });
    const x = await roundTrip("google", "c1");
    const form = tokenCalls.at(-1)!.form;
    assert.deepEqual([form.get("client_secret"), form.get("client_id"), form.get("grant_type"), form.get("redirect_uri"), form.get("code")], ["google-SECRET-do-not-leak-456", "google-client-id-123", "authorization_code", `${BASE}/api/auth/oauth/google/callback`, "c1"]);
    const challenge = new URL(x.location).searchParams.get("code_challenge");
    assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), challenge, "the verifier matches the challenge that was sent");
    assert.equal(userCalls.at(-1)!.auth, "Bearer tok-c1");
    assert.ok(!userCalls.at(-1)!.url.includes("tok-"), "no token in an address");
  });
  it("keeps no provider token, and no secret, anywhere in the database", async () => {
    const { db } = await mods();
    people.set("c1", { provider: "google", profile: google("g-5", "keep@example.com") });
    await roundTrip("google", "c1");
    const dump = JSON.stringify([db.getDb().prepare("SELECT * FROM auth_identities").all(), db.getDb().prepare("SELECT * FROM oauth_states").all(), db.getDb().prepare("SELECT * FROM users").all()]);
    assert.ok(!dump.includes("tok-c1") && !dump.includes("SECRET") && !dump.includes("access_token"));
  });
});

describe("4. refusing what must be refused", () => {
  it("a state that does not match this browser's cookie, a missing cookie, and a made-up state all stop the sign-in and create nothing", async () => {
    const { db } = await mods();
    people.set("c1", { provider: "google", profile: google("g-6", "state@example.com") });
    const before = (db.getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    for (const mangle of [() => ({ cookieState: "someone-elses-state" }), () => ({ cookieState: "" }), () => ({ state: "made-up-state", cookieState: "made-up-state" }), (s: { state: string }) => ({ state: s.state, cookieState: `${s.state}x` })]) {
      const x = await roundTrip("google", "c1", { mangle });
      assert.equal(errorOf(x), "state");
      assert.equal(x.session, undefined);
    }
    assert.equal((db.getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n, before);
    assert.equal(tokenCalls.length, 0, "the provider was never asked for anything");
  });
  it("a state works once: replaying the same address fails", async () => {
    const r = await routes();
    people.set("c1", { provider: "google", profile: google("g-7", "replay@example.com") });
    const start = await r.start.GET(req("/api/auth/oauth/google/start"), ctx("google"));
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const call = () => r.callback.GET(req(`/api/auth/oauth/google/callback?code=c1&state=${state}`, { cookie: `silpi_oauth=${state}` }), ctx("google"));
    const first = await call();
    assert.equal(new URL(first.headers.get("location")!, BASE).searchParams.get("error"), null);
    const second = await call();
    assert.equal(new URL(second.headers.get("location")!, BASE).searchParams.get("error"), "state");
  });
  it("a state that is for the other provider, or has expired, is refused", async () => {
    const { db } = await mods();
    const r = await routes();
    people.set("c1", { provider: "facebook", profile: facebook("f-9", "cross@example.com") });
    const start = await r.start.GET(req("/api/auth/oauth/google/start"), ctx("google"));
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const wrong = await r.callback.GET(req(`/api/auth/oauth/facebook/callback?code=c1&state=${state}`, { cookie: `silpi_oauth=${state}` }), ctx("facebook"));
    assert.equal(new URL(wrong.headers.get("location")!, BASE).searchParams.get("error"), "state");
    const s2 = await r.start.GET(req("/api/auth/oauth/google/start"), ctx("google"));
    const state2 = new URL(s2.headers.get("location")!).searchParams.get("state")!;
    db.getDb().prepare("UPDATE oauth_states SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    const late = await r.callback.GET(req(`/api/auth/oauth/google/callback?code=c1&state=${state2}`, { cookie: `silpi_oauth=${state2}` }), ctx("google"));
    assert.equal(new URL(late.headers.get("location")!, BASE).searchParams.get("error"), "state");
  });
  it("the person saying no at the provider, or the provider failing, ends on the sign-in page with a plain code", async () => {
    const r = await routes();
    const start = await r.start.GET(req("/api/auth/oauth/google/start?next=/ai/usage"), ctx("google"));
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const denied = await r.callback.GET(req(`/api/auth/oauth/google/callback?error=access_denied&state=${state}`, { cookie: `silpi_oauth=${state}` }), ctx("google"));
    const to = new URL(denied.headers.get("location")!, BASE);
    assert.deepEqual([to.pathname, to.searchParams.get("error"), to.searchParams.get("next")], ["/sign-in", "denied", "/ai/usage"]);
    const x = await roundTrip("google", "code-nobody");
    assert.equal(errorOf(x), "failed", "a code the provider does not accept");
    people.set("c-ok", { provider: "google", profile: google("g-10", "net@example.com") });
    const { o } = await mods();
    o.setOAuthFetch(async () => { throw new Error("network down"); });
    assert.equal(errorOf(await roundTrip("google", "c-ok")), "failed");
    const s2 = await r.start.GET(req("/api/auth/oauth/google/start"), ctx("google"));
    const st2 = new URL(s2.headers.get("location")!).searchParams.get("state")!;
    const noCode = await r.callback.GET(req(`/api/auth/oauth/google/callback?state=${st2}`, { cookie: `silpi_oauth=${st2}` }), ctx("google"));
    assert.equal(new URL(noCode.headers.get("location")!, BASE).searchParams.get("error"), "failed");
  });
  it("an address Google does not vouch for, or no address at all, cannot make an account", async () => {
    const { db } = await mods();
    const identities = () => (db.getDb().prepare("SELECT COUNT(*) AS n FROM auth_identities").get() as { n: number }).n;
    const had = identities();
    people.set("u", { provider: "google", profile: google("g-11", "unverified@example.com", { email_verified: false }) });
    assert.equal(errorOf(await roundTrip("google", "u")), "unverified-email");
    people.set("s", { provider: "google", profile: google("g-12", "stringy@example.com", { email_verified: "true" }) });
    assert.equal(errorOf(await roundTrip("google", "s")), "unverified-email", "only a real yes counts");
    people.set("n", { provider: "facebook", profile: facebook("f-12", undefined) });
    assert.equal(errorOf(await roundTrip("facebook", "n")), "no-email");
    people.set("b", { provider: "facebook", profile: facebook("f-13", "not an email") });
    assert.equal(errorOf(await roundTrip("facebook", "b")), "no-email");
    people.set("m", { provider: "google", profile: { email: "nosub@example.com", email_verified: true } });
    assert.equal(errorOf(await roundTrip("google", "m")), "failed", "a profile without the provider's own id is not a person");
    assert.equal(identities(), had);
  });
  it("an address that already has an account is never entered through a social sign-in: no session, no link, the account untouched", async () => {
    const { acc, ten, db } = await mods();
    const had = (db.getDb().prepare("SELECT COUNT(*) AS n FROM auth_identities").get() as { n: number }).n;
    await acc.signUp({ name: "Existing", email: "mine@example.com", password: GOOD, acceptTerms: true });
    people.set("g", { provider: "google", profile: google("g-13", "MINE@example.com") });
    const x = await roundTrip("google", "g");
    assert.equal(errorOf(x), "exists");
    assert.equal(x.session, undefined);
    people.set("f", { provider: "facebook", profile: facebook("f-14", "mine@example.com") });
    assert.equal(errorOf(await roundTrip("facebook", "f")), "exists");
    assert.equal((db.getDb().prepare("SELECT COUNT(*) AS n FROM auth_identities").get() as { n: number }).n, had);
    assert.ok(await ten.authenticate("mine@example.com", GOOD), "their password still works");
  });
  it("an account that has been disabled cannot be entered, and a person who signs in twice at once makes one account", async () => {
    const { db } = await mods();
    people.set("c1", { provider: "google", profile: google("g-14", "dis@example.com") });
    await roundTrip("google", "c1");
    db.getDb().prepare("UPDATE users SET status = 'disabled' WHERE email = 'dis@example.com'").run();
    const x = await roundTrip("google", "c1");
    assert.equal(errorOf(x), "disabled");
    assert.equal(x.session, undefined);
    people.set("race", { provider: "google", profile: google("g-15", "race@example.com") });
    const both = await Promise.all([roundTrip("google", "race"), roundTrip("google", "race")]);
    assert.equal((db.getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'race@example.com'").get() as { n: number }).n, 1);
    assert.ok(both.some((b) => b.session), "at least one got in");
  });
  it("a destination that is not a path on this site is replaced, so a sign-in link cannot send anyone elsewhere", async () => {
    people.set("c1", { provider: "google", profile: google("g-16", "next@example.com") });
    for (const evil of ["https://evil.example/", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      const x = await roundTrip("google", "c1", { next: evil });
      assert.equal(x.to.origin, BASE, evil);
      assert.equal(x.to.pathname, "/ai", evil + " falls back to the client home");
    }
  });
});

describe("5. connecting a social identity to an account you are already signed in to", () => {
  async function signedIn(email: string) {
    const { acc } = await mods();
    const r = await routes();
    await acc.signUp({ name: "Linker", email, password: GOOD, acceptTerms: true });
    const login = await r.login.POST(new NextRequest(`${BASE}/api/auth/login`, { method: "POST", headers: { host: "localhost:3000", origin: BASE, "content-type": "application/json", "x-forwarded-for": `10.6.0.${++seq % 250}` }, body: JSON.stringify({ email, password: GOOD }) }));
    return `silpi_session=${cookieValue(login, "silpi_session")}`;
  }
  it("attaches the identity to that account, starts no new session, and the person can then sign in with Google", async () => {
    const { db } = await mods();
    const cookie = await signedIn("link@example.com");
    const users = () => (db.getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    const had = users();
    people.set("c1", { provider: "google", profile: google("g-20", "different-address@example.com") });
    const x = await roundTrip("google", "c1", { cookie, link: true, next: "/ai/billing" });
    assert.equal(x.to.pathname, "/ai/billing");
    assert.equal(x.session, undefined, "no new session: they were already signed in");
    assert.equal(users(), had, "no second account");
    const link = db.getDb().prepare("SELECT u.email AS email FROM auth_identities i JOIN users u ON u.id = i.user_id WHERE i.subject = 'g-20'").get() as { email: string };
    assert.equal(link.email, "link@example.com");
    const later = await roundTrip("google", "c1");
    assert.ok(later.session, "Google now signs them in to that account");
  });
  it("needs a signed-in person to start, and cannot take an identity that belongs to another account", async () => {
    const r = await routes();
    const anon = await r.start.GET(req("/api/auth/oauth/google/start?link=1&next=/ai"), ctx("google"));
    assert.equal(new URL(anon.headers.get("location")!, BASE).pathname, "/sign-in");
    assert.equal(cookieValue(anon, "silpi_oauth"), undefined, "no sign-in was started");
    people.set("c1", { provider: "google", profile: google("g-21", "owner@example.com") });
    await roundTrip("google", "c1");
    const cookie = await signedIn("thief@example.com");
    const x = await roundTrip("google", "c1", { cookie, link: true });
    assert.equal(errorOf(x), "link-taken");
  });
  it("refuses to connect to an account that was disabled while the person was at the provider", async () => {
    const { db } = await mods();
    const cookie = await signedIn("late@example.com");
    people.set("c1", { provider: "google", profile: google("g-22", "late-google@example.com") });
    const r = await routes();
    const start = await r.start.GET(req("/api/auth/oauth/google/start?link=1", { cookie }), ctx("google"));
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    db.getDb().prepare("UPDATE users SET status = 'disabled' WHERE email = 'late@example.com'").run();
    const cb = await r.callback.GET(req(`/api/auth/oauth/google/callback?code=c1&state=${state}`, { cookie: `silpi_oauth=${state}` }), ctx("google"));
    assert.equal(new URL(cb.headers.get("location")!, BASE).searchParams.get("error"), "disabled");
    assert.equal((db.getDb().prepare("SELECT COUNT(*) AS n FROM auth_identities WHERE subject = 'g-22'").get() as { n: number }).n, 0);
  });
  it("a password reset removes a Facebook identity nobody vouched for, and keeps a Google one", async () => {
    const { acc, db } = await mods();
    const cookie = await signedIn("reset@example.com");
    people.set("fb", { provider: "facebook", profile: facebook("f-30", "reset@example.com") });
    people.set("gg", { provider: "google", profile: google("g-30", "reset@example.com") });
    await roundTrip("facebook", "fb", { cookie, link: true });
    await roundTrip("google", "gg", { cookie, link: true });
    const mine = () => (db.getDb().prepare("SELECT i.provider AS provider FROM auth_identities i JOIN users u ON u.id = i.user_id WHERE u.email = 'reset@example.com' ORDER BY i.provider").all() as { provider: string }[]).map((x) => x.provider);
    assert.deepEqual(mine(), ["facebook", "google"]);
    const mail = await import("@/server/mailer");
    const sent: string[] = [];
    mail.setMailTransport(async (m) => { sent.push(m.text); });
    await acc.requestPasswordReset("reset@example.com", BASE);
    const token = /token=([A-Za-z0-9_-]+)/.exec(sent[0]!)![1]!;
    await acc.resetPassword(token, "a-brand-new-phrase-1");
    mail.setMailTransport(null);
    assert.deepEqual(mine(), ["google"]);
  });
});

describe("6. the screen", () => {
  const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
  it("the sign-in screen links to the start doors when a method works, shows it switched off when it does not, and shows only our own wording for an error", () => {
    const s = read("src/components/client/client-auth.tsx");
    assert.match(s, /\/api\/auth\/providers/);
    assert.match(s, /\/api\/auth\/oauth\/\$\{i\.id\}\/start\?next=/);
    assert.match(s, /isOAuthError\(code\) \? OAUTH_ERRORS\[code\]/);
    assert.match(s, /aria-disabled="true"/);
  });
  it("no secret name appears in any browser file", () => {
    for (const f of ["src/components/client/client-auth.tsx", "src/lib/oauth-providers.ts"]) {
      const text = read(f);
      assert.ok(!/process\.env\.SILPI_(GOOGLE|FACEBOOK)_(CLIENT_SECRET|APP_SECRET)/.test(text) || f.endsWith("oauth-providers.ts"), f);
    }
    assert.ok(!/"use client"/.test(read("src/lib/oauth-providers.ts")));
  });
});

// Social sign-in with Google and Facebook (server only): the authorization-code flow with a one-time state bound to the browser, PKCE for Google, and a strict account policy.
//
// Account policy (why it is this strict): an e-mail address alone must never be enough to enter an existing account.
//   1. A known identity (provider + the provider's own id) signs in its account.
//   2. A new identity with an address no account uses creates a new account, with no usable password. Google must vouch for the address; Facebook's cannot be
//      vouched for, so such an identity is removed again if the address's owner later proves control by resetting the password.
//   3. A new identity whose address already belongs to an account is REFUSED. It can be connected only by someone who is already signed in to that account.
// No token from the provider is kept: it is used once to read the profile and discarded.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { getDb, transaction } from "@/lib/business/db";
import { TERMS_VERSION, validateEmail } from "@/lib/client-auth";
import { authorizeUrl, FACEBOOK_ENDPOINTS, GOOGLE_ENDPOINTS, providerCredentials, redirectUriFor, type OAuthErrorCode, type OAuthProvider } from "@/lib/oauth-providers";
import { safeNext } from "@/lib/safe-next";
import { recordAudit } from "@/server/audit";
import { addMember, createOrganization, type User } from "@/server/tenancy";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const STATE_MINUTES = 10;
export const OAUTH_COOKIE = "silpi_oauth";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
let fetcher: Fetcher | null = null;
/** Tests replace the network so no provider is contacted. */
export const setOAuthFetch = (f: Fetcher | null): void => { fetcher = f; };
const http: Fetcher = (url, init) => (fetcher ?? fetch)(url, { ...init, signal: AbortSignal.timeout(10_000) });

export type Profile = { subject: string; email: string; emailVerified: boolean; name: string };

export function configuredProviders(env: Record<string, string | undefined> = process.env): Record<OAuthProvider, boolean> {
  return { google: !!providerCredentials("google", env), facebook: !!providerCredentials("facebook", env) };
}

// ---- starting ------------------------------------------------------------------------------------------------------
/** Records a sign-in in progress and returns where to send the person, and the state that must also be held in their browser. */
export function beginOAuth(provider: OAuthProvider, p: { base: string; next: string; linkUserId?: string }): { url: string; state: string } | null {
  const creds = providerCredentials(provider);
  if (!creds) return null;
  const state = randomBytes(32).toString("base64url");
  const verifier = provider === "google" ? randomBytes(48).toString("base64url") : "";
  const challenge = verifier ? createHash("sha256").update(verifier).digest("base64url") : undefined;
  const now = Date.now();
  const db = getDb();
  db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").run(new Date(now).toISOString());
  db.prepare("INSERT INTO oauth_states (state_hash, provider, verifier, next_path, link_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    sha256(state),
    provider,
    verifier,
    safeNext(p.next, "/"),
    p.linkUserId ?? null,
    new Date(now).toISOString(),
    new Date(now + STATE_MINUTES * 60_000).toISOString(),
  );
  return { url: authorizeUrl(provider, { clientId: creds.id, redirectUri: redirectUriFor(provider, p.base), state, challenge }), state };
}

// ---- reading the provider's answer ---------------------------------------------------------------------------------
const textOf = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function profileFrom(provider: OAuthProvider, code: string, verifier: string, redirectUri: string): Promise<Profile | null> {
  const creds = providerCredentials(provider);
  if (!creds) return null;
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: creds.id, client_secret: creds.secret });
  if (provider === "google" && verifier) form.set("code_verifier", verifier);
  const tokenRes = await http(provider === "google" ? GOOGLE_ENDPOINTS.token : FACEBOOK_ENDPOINTS.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form });
  if (!tokenRes.ok) return null;
  const token = textOf((await readJson(tokenRes))?.access_token, 4000);
  if (!token) return null;
  const meRes = await http(provider === "google" ? GOOGLE_ENDPOINTS.userinfo : FACEBOOK_ENDPOINTS.me, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  if (!meRes.ok) return null;
  const me = await readJson(meRes);
  if (!me) return null;
  const subject = provider === "google" ? textOf(me.sub, 200) : textOf(me.id, 200);
  if (!subject) return null;
  const email = textOf(me.email, 254).toLowerCase();
  return { subject, email, emailVerified: provider === "google" && me.email_verified === true, name: textOf(me.name, 80) };
}

// ---- finishing -----------------------------------------------------------------------------------------------------
export type OAuthResult = { ok: true; userId: string; next: string; linked: boolean } | { ok: false; code: OAuthErrorCode; next: string };

function bound(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function finishOAuth(provider: OAuthProvider, p: { code: string | null; state: string | null; cookieState: string | null; providerError: string | null; base: string }): Promise<OAuthResult> {
  const fail = (code: OAuthErrorCode, next = "/"): OAuthResult => ({ ok: false, code, next });
  const state = p.state ?? "";
  if (!state || state.length > 200 || !p.cookieState || !bound(state, p.cookieState)) return fail("state");
  const db = getDb();
  const row = db.prepare("SELECT provider, verifier, next_path AS next, link_user_id AS linkUserId, expires_at AS expiresAt FROM oauth_states WHERE state_hash = ?").get(sha256(state)) as
    | { provider: string; verifier: string; next: string; linkUserId: string | null; expiresAt: string }
    | undefined;
  // The state is spent now, whatever happens next: it can never be replayed.
  db.prepare("DELETE FROM oauth_states WHERE state_hash = ?").run(sha256(state));
  if (!row || row.provider !== provider || Date.parse(row.expiresAt) <= Date.now()) return fail("state");
  if (p.providerError) return fail(p.providerError === "access_denied" ? "denied" : "failed", row.next);
  if (!p.code || p.code.length > 2000) return fail("failed", row.next);

  let profile: Profile | null;
  try {
    profile = await profileFrom(provider, p.code, row.verifier, redirectUriFor(provider, p.base));
  } catch {
    profile = null;
  }
  if (!profile) return fail("failed", row.next);
  return signInWithProfile(provider, profile, row.linkUserId, row.next);
}

/** Applies the account policy to a profile the provider has vouched for as a person (not for the address, which is checked separately). */
export function signInWithProfile(provider: OAuthProvider, profile: Profile, linkUserId: string | null, next: string): OAuthResult {
  const fail = (code: OAuthErrorCode): OAuthResult => ({ ok: false, code, next });
  const db = getDb();
  const known = db.prepare("SELECT i.id AS id, i.user_id AS userId, u.status AS status FROM auth_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?").get(provider, profile.subject) as
    | { id: number; userId: string; status: string }
    | undefined;

  // Connecting to the account of someone who is signed in.
  if (linkUserId) {
    const owner = db.prepare("SELECT status FROM users WHERE id = ?").get(linkUserId) as { status: string } | undefined;
    if (!owner || owner.status !== "active") return fail("disabled");
    if (known && known.userId !== linkUserId) return fail("link-taken");
    if (!known) {
      db.prepare("INSERT INTO auth_identities (user_id, provider, subject, email, email_verified, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(linkUserId, provider, profile.subject, profile.email, profile.emailVerified ? 1 : 0, new Date().toISOString(), new Date().toISOString());
      recordAudit({ actor: `client:${linkUserId}`, action: "client.identity_linked", entityType: "user", entityId: linkUserId, detail: { provider } });
    }
    return { ok: true, userId: linkUserId, next, linked: true };
  }

  if (known) {
    if (known.status !== "active") return fail("disabled");
    const at = new Date().toISOString();
    db.prepare("UPDATE auth_identities SET last_login_at = ? WHERE id = ?").run(at, known.id);
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(at, known.userId);
    return { ok: true, userId: known.userId, next, linked: false };
  }

  // A new identity: it needs an address, and Google must vouch for it.
  if (!profile.email) return fail("no-email");
  let email: string;
  try { email = validateEmail(profile.email); } catch { return fail("no-email"); }
  if (provider === "google" && !profile.emailVerified) return fail("unverified-email");
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) return fail("exists");

  const at = new Date().toISOString();
  const name = profile.name.replace(/\s+/g, " ").trim().slice(0, 80) || email.split("@")[0]!.slice(0, 80);
  try {
    const userId = transaction((tx) => {
      const user: User = { id: `usr_${randomUUID()}`, email, name, status: "active", createdAt: at };
      // "oauth$none" is not a password scheme: no password, however it is typed, can ever match it. A password can be set later through Forgot password.
      tx.prepare("INSERT INTO users (id, email, name, password_hash, status, created_at, terms_version, terms_accepted_at, last_login_at) VALUES (?, ?, ?, 'oauth$none', 'active', ?, ?, ?, ?)").run(user.id, email, name, at, TERMS_VERSION, at, at);
      const organization = createOrganization({ name: `${name}'s workspace`.slice(0, 120), type: "individual" });
      addMember(organization.id, user.id, "owner");
      tx.prepare("INSERT INTO auth_identities (user_id, provider, subject, email, email_verified, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(user.id, provider, profile.subject, email, profile.emailVerified ? 1 : 0, at, at);
      recordAudit({ actor: `client:${user.id}`, action: "client.signed_up", entityType: "user", entityId: user.id, orgId: organization.id, detail: { termsVersion: TERMS_VERSION, provider } });
      return user.id;
    });
    return { ok: true, userId, next, linked: false };
  } catch (error) {
    // Two sign-ins at the same moment for the same new person: the second finds the first's account.
    if (/UNIQUE/i.test((error as Error).message)) return fail("exists");
    throw error;
  }
}

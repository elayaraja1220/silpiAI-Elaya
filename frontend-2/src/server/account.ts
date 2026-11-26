// A signed-in person's own account (server only): their details, password, connected sign-in methods and sessions.
// Every function takes the user id from the session; none takes an id from the request.
import { getDb } from "@/lib/business/db";
import { ValidationError } from "@/lib/business/validate";
import { validateName, validatePassword } from "@/lib/client-auth";
import { isOAuthProvider, type OAuthProvider } from "@/lib/oauth-providers";
import { recordAudit } from "@/server/audit";
import { destroyOtherSessions, destroySessionsOfUser } from "@/server/sessions";
import { hashPassword, verifyPassword } from "@/server/tenancy";

export type Identity = { provider: OAuthProvider; email: string; vouchedFor: boolean; linkedAt: string };
export type Profile = { name: string; email: string; createdAt: string; termsVersion: string | null; termsAcceptedAt: string | null; hasPassword: boolean; identities: Identity[] };

type UserRow = { name: string; email: string; password_hash: string; created_at: string; terms_version: string | null; terms_accepted_at: string | null };
const user = (id: string): UserRow => {
  const row = getDb().prepare("SELECT name, email, password_hash, created_at, terms_version, terms_accepted_at FROM users WHERE id = ?").get(id) as UserRow | undefined;
  if (!row) throw new ValidationError("That account does not exist.");
  return row;
};
/** A password exists when the stored value is a real hash: an account made through Google or Facebook has none until one is set by Forgot password. */
const hasPassword = (hash: string) => hash.startsWith("scrypt$");

export function listIdentities(userId: string): Identity[] {
  const rows = getDb().prepare("SELECT provider, email, email_verified AS v, created_at AS at FROM auth_identities WHERE user_id = ? ORDER BY id").all(userId) as { provider: OAuthProvider; email: string; v: number; at: string }[];
  return rows.map((r) => ({ provider: r.provider, email: r.email, vouchedFor: r.v === 1, linkedAt: r.at }));
}

export function getProfile(userId: string): Profile {
  const u = user(userId);
  return { name: u.name, email: u.email, createdAt: u.created_at, termsVersion: u.terms_version, termsAcceptedAt: u.terms_accepted_at, hasPassword: hasPassword(u.password_hash), identities: listIdentities(userId) };
}

export function updateName(userId: string, value: unknown): string {
  const name = validateName(value);
  user(userId);
  getDb().prepare("UPDATE users SET name = ? WHERE id = ?").run(name, userId);
  return name;
}

/** Changes the password after checking the current one. Every other session of the account ends; the one used now stays. */
export async function changePassword(userId: string, current: unknown, next: unknown, keepToken: string | undefined): Promise<void> {
  const u = user(userId);
  if (!hasPassword(u.password_hash)) throw new ValidationError("Your account has no password yet. Use Forgot password on the sign-in page to set one.");
  if (typeof current !== "string" || !(await verifyPassword(current, u.password_hash))) throw new ValidationError("The current password is not correct.");
  const password = validatePassword(next, { email: u.email, name: u.name });
  if (password === current) throw new ValidationError("Choose a password that is different from the current one.");
  const hash = await hashPassword(password);
  getDb().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
  destroyOtherSessions(userId, keepToken);
  recordAudit({ actor: `client:${userId}`, action: "client.password_changed", entityType: "user", entityId: userId });
}

/** Disconnects Google or Facebook. Refused when it would leave the person with no way to sign in. */
export function unlinkIdentity(userId: string, provider: unknown): void {
  if (!isOAuthProvider(provider)) throw new ValidationError("Unknown sign-in method.");
  const u = user(userId);
  const all = listIdentities(userId);
  if (!all.some((i) => i.provider === provider)) throw new ValidationError("That sign-in method is not connected.");
  if (!hasPassword(u.password_hash) && all.length <= 1) throw new ValidationError("This is your only way to sign in. Set a password first (use Forgot password), then disconnect it.");
  getDb().prepare("DELETE FROM auth_identities WHERE user_id = ? AND provider = ?").run(userId, provider);
  recordAudit({ actor: `client:${userId}`, action: "client.identity_unlinked", entityType: "user", entityId: userId, detail: { provider } });
}

export function signOutEverywhere(userId: string): number {
  recordAudit({ actor: `client:${userId}`, action: "client.signed_out_everywhere", entityType: "user", entityId: userId });
  return destroySessionsOfUser(userId);
}

// Client accounts (server only): sign up, forgot password, reset password. Sign-in itself is the existing /api/auth/login.
// A client is a user with a personal organization they own; everything they create belongs to that organization and nobody else can reach it.
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { getDb, transaction } from "@/lib/business/db";
import { ValidationError } from "@/lib/business/validate";
import { looksLikeResetToken, TERMS_VERSION, validateEmail, validateName, validatePassword } from "@/lib/client-auth";
import { recordAudit } from "@/server/audit";
import { sendMail } from "@/server/mailer";
import { destroySessionsOfUser } from "@/server/sessions";
import { addMember, createOrganization, hashPassword, type Organization, type User } from "@/server/tenancy";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
export const RESET_MINUTES = 60;

export type SignUpInput = { name: unknown; email: unknown; password: unknown; acceptTerms: unknown };

/** Creates the user, their personal organization and their ownership of it, and records the terms they accepted, all or nothing. */
export async function signUp(input: SignUpInput): Promise<{ user: User; organization: Organization }> {
  if (input.acceptTerms !== true) throw new ValidationError("Please accept the Terms of Service and Privacy Policy to create an account.");
  const email = validateEmail(input.email);
  const name = validateName(input.name);
  const password = validatePassword(input.password, { email, name });
  const hash = await hashPassword(password);
  const at = new Date().toISOString();
  return transaction((db) => {
    const user: User = { id: `usr_${randomUUID()}`, email, name, status: "active", createdAt: at };
    try {
      db.prepare("INSERT INTO users (id, email, name, password_hash, status, created_at, terms_version, terms_accepted_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)").run(user.id, email, name, hash, at, TERMS_VERSION, at);
    } catch (error) {
      if (/UNIQUE/i.test((error as Error).message)) throw new ValidationError("An account with this email already exists. Sign in, or use Forgot password.");
      throw error;
    }
    const organization = createOrganization({ name: `${name}'s workspace`.slice(0, 120), type: "individual" });
    addMember(organization.id, user.id, "owner");
    recordAudit({ actor: `client:${user.id}`, action: "client.signed_up", entityType: "user", entityId: user.id, orgId: organization.id, detail: { termsVersion: TERMS_VERSION } });
    return { user, organization };
  });
}

/**
 * Starts a password reset. It does the same visible thing whether or not the address has an account (the caller answers the same way), so it cannot be used to find out who
 * has one. Only an active account gets a link; an older unused link stops working.
 */
export async function requestPasswordReset(emailInput: unknown, baseUrl: string): Promise<void> {
  let email: string;
  try { email = validateEmail(emailInput); } catch { return; }
  const db = getDb();
  const user = db.prepare("SELECT id, name FROM users WHERE email = ? AND status = 'active'").get(email) as { id: string; name: string } | undefined;
  if (!user) return;
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  transaction((tx) => {
    tx.prepare("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL").run(user.id);
    tx.prepare("INSERT INTO password_resets (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)").run(user.id, sha256(token), new Date(now).toISOString(), new Date(now + RESET_MINUTES * 60_000).toISOString());
  });
  recordAudit({ actor: `client:${user.id}`, action: "client.password_reset_requested", entityType: "user", entityId: user.id });
  const link = `${baseUrl.replace(/\/+$/, "")}/reset-password?token=${token}`;
  await sendMail({
    to: email,
    subject: "Reset your SILPI AI password",
    text: `Hello ${user.name},\n\nSomeone asked to reset the password of your SILPI AI account. To choose a new password, open this link within ${RESET_MINUTES} minutes:\n\n${link}\n\nIf you did not ask for this, ignore this message: your password has not changed.\n`,
  });
}

/** Sets a new password from a reset link. A link works once; every session of the account ends, so anyone who had the old password is signed out. */
export async function resetPassword(tokenInput: unknown, passwordInput: unknown): Promise<void> {
  if (!looksLikeResetToken(tokenInput)) throw new ValidationError("This reset link is not valid. Ask for a new one.");
  const db = getDb();
  const row = db
    .prepare("SELECT r.id AS id, r.user_id AS userId, r.expires_at AS expiresAt, u.email AS email, u.name AS name FROM password_resets r JOIN users u ON u.id = r.user_id AND u.status = 'active' WHERE r.token_hash = ? AND r.used_at IS NULL")
    .get(sha256(tokenInput)) as { id: number; userId: string; expiresAt: string; email: string; name: string } | undefined;
  if (!row || Date.parse(row.expiresAt) <= Date.now()) throw new ValidationError("This reset link has expired or was already used. Ask for a new one.");
  const password = validatePassword(passwordInput, { email: row.email, name: row.name });
  const hash = await hashPassword(password);
  transaction((tx) => {
    // The link is spent first, inside the same step, so two people using it at once cannot both succeed.
    const spent = tx.prepare("UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL").run(new Date().toISOString(), row.id);
    if (Number(spent.changes) !== 1) throw new ValidationError("This reset link has expired or was already used. Ask for a new one.");
    tx.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, row.userId);
    tx.prepare("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL").run(row.userId);
    destroySessionsOfUser(row.userId);
    recordAudit({ actor: `client:${row.userId}`, action: "client.password_reset", entityType: "user", entityId: row.userId });
  });
}

import { createHash, randomBytes } from "node:crypto";

import { getDb } from "@/lib/business/db";
import { organizationsOf, roleOf, type Role } from "./tenancy";

/**
 * User sessions (server only). The browser holds a random token; the database holds only its SHA-256, so a copy of the
 * database cannot sign anyone in. A session can be ended at any time (sign-out, or all of a user's sessions), and it
 * stops working the moment the user is disabled. The role is looked up on every request, so removing someone from an
 * organization, or suspending it, takes effect immediately instead of when the session expires.
 */

export const SESSION_COOKIE = "silpi_session";
export const SESSION_DAYS = 7;
const DAY_MS = 86_400_000;

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export type SessionUser = { id: string; email: string; name: string };
export type ResolvedSession = { user: SessionUser; orgId: string | null; role: Role | null };

/** Starts a session in the user's first active organization (or none). Returns the token to put in the cookie. */
export function createSession(userId: string, now = Date.now()): { token: string; expiresAt: string; orgId: string | null } {
  const token = randomBytes(32).toString("base64url");
  const orgId = organizationsOf(userId)[0]?.org.id ?? null;
  const expiresAt = new Date(now + SESSION_DAYS * DAY_MS).toISOString();
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date(now).toISOString()); // tidy up as we go
  db.prepare("INSERT INTO sessions (id, user_id, org_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    digest(token),
    userId,
    orgId,
    new Date(now).toISOString(),
    expiresAt,
    new Date(now).toISOString(),
  );
  return { token, expiresAt, orgId };
}

/** Who a token belongs to right now, or null (unknown, expired, ended, or the user is disabled). */
export function resolveSession(token: string | undefined | null, now = Date.now()): ResolvedSession | null {
  if (!token || typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT s.id AS id, s.org_id AS orgId, s.expires_at AS expiresAt, u.id AS userId, u.email AS email, u.name AS name
         FROM sessions s JOIN users u ON u.id = s.user_id AND u.status = 'active'
        WHERE s.id = ?`,
    )
    .get(digest(token)) as { id: string; orgId: string | null; expiresAt: string; userId: string; email: string; name: string } | undefined;
  if (!row) return null;
  if (Date.parse(row.expiresAt) <= now) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
    return null;
  }
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(new Date(now).toISOString(), row.id);
  return { user: { id: row.userId, email: row.email, name: row.name }, orgId: row.orgId, role: row.orgId ? roleOf(row.orgId, row.userId) : null };
}

export function destroySession(token: string | undefined | null): void {
  if (token) getDb().prepare("DELETE FROM sessions WHERE id = ?").run(digest(token));
}

/** Ends every session of a user (use when a password changes or an account is disabled). Returns how many. */
export function destroySessionsOfUser(userId: string): number {
  return Number(getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes);
}

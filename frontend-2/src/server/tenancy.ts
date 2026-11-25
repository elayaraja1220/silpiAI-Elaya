import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { getDb } from "@/lib/business/db";
import { AGENCY_ORG_ID, MEMBER_ROLES, ORG_TYPES } from "@/lib/business/migrations";
import { getLead, listLeads } from "@/lib/business/store";
import type { Lead } from "@/lib/business/types";
import { ValidationError } from "@/lib/business/validate";

/**
 * Organizations, users, roles and tenant-scoped access (server only).
 *
 * The rule this file exists to enforce: a lead is only reachable through the organization that owns it.
 * `getLeadForOrg` and `listLeadsForOrg` answer "not found" for another organization's lead, exactly as if it did not
 * exist, so an id from a URL can never be used to read across tenants.
 *
 * Nothing in the existing routes calls this yet: today's single-owner screens are unchanged. The next step wires
 * sign-in and passes the signed-in user's organization through these functions.
 */

export { AGENCY_ORG_ID };
export type OrgType = (typeof ORG_TYPES)[number];
export type Role = (typeof MEMBER_ROLES)[number];
export type Organization = { id: string; name: string; type: OrgType; status: "active" | "suspended"; createdAt: string };
export type User = { id: string; email: string; name: string; status: "active" | "disabled"; createdAt: string };

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const now = () => new Date().toISOString();

// ---- permissions ---------------------------------------------------------------------------------------------------
export const PERMISSIONS = ["lead:read", "lead:write", "members:manage", "billing:manage"] as const;
export type Permission = (typeof PERMISSIONS)[number];

const GRANTS: Record<Role, readonly Permission[]> = {
  owner: ["lead:read", "lead:write", "members:manage", "billing:manage"],
  admin: ["lead:read", "lead:write", "members:manage", "billing:manage"],
  member: ["lead:read", "lead:write"],
  viewer: ["lead:read"],
};

/** Whether a role may do something. An unknown role may do nothing. */
export const can = (role: Role | null | undefined, permission: Permission): boolean => !!role && (GRANTS[role] ?? []).includes(permission);

// ---- passwords -----------------------------------------------------------------------------------------------------
const MIN_PASSWORD = 10;

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) throw new ValidationError(`The password must be at least ${MIN_PASSWORD} characters.`);
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash || typeof password !== "string") return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await scrypt(password, Buffer.from(salt, "base64url"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---- organizations, users, memberships -----------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createOrganization(input: { name: string; type: OrgType }): Organization {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 120) throw new ValidationError("The organization name is required (up to 120 characters).");
  if (!(ORG_TYPES as readonly string[]).includes(input.type)) throw new ValidationError(`The organization type must be one of: ${ORG_TYPES.join(", ")}.`);
  // Only the one agency organization is internal: customers can never be created as internal.
  if (input.type === "internal") throw new ValidationError("An internal organization cannot be created here.");
  const org: Organization = { id: `org_${randomUUID()}`, name, type: input.type, status: "active", createdAt: now() };
  getDb().prepare("INSERT INTO organizations (id, name, type, status, created_at) VALUES (?, ?, ?, 'active', ?)").run(org.id, org.name, org.type, org.createdAt);
  return org;
}

export function getOrganization(id: string): Organization | null {
  const r = getDb().prepare("SELECT id, name, type, status, created_at AS createdAt FROM organizations WHERE id = ?").get(id) as Organization | undefined;
  return r ?? null;
}

export async function createUser(input: { email: string; name: string; password: string }): Promise<User> {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!EMAIL_RE.test(email) || email.length > 200) throw new ValidationError("A valid email address is required.");
  if (!name || name.length > 120) throw new ValidationError("The name is required (up to 120 characters).");
  const passwordHash = await hashPassword(input.password);
  const user: User = { id: `usr_${randomUUID()}`, email, name, status: "active", createdAt: now() };
  try {
    getDb().prepare("INSERT INTO users (id, email, name, password_hash, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)").run(user.id, user.email, user.name, passwordHash, user.createdAt);
  } catch (error) {
    if (/UNIQUE/i.test((error as Error).message)) throw new ValidationError("That email address is already registered.");
    throw error;
  }
  return user;
}

// A real-looking hash that matches no password, so a missing account costs the same hashing work as a wrong password.
const DUMMY_HASH = `scrypt$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(64).toString("base64url")}`;

/** The user when the email and password are right and the account is active, otherwise null (never says which was wrong). */
export async function authenticate(email: string, password: string): Promise<User | null> {
  const row = getDb().prepare("SELECT id, email, name, status, created_at AS createdAt, password_hash AS hash FROM users WHERE email = ?").get(String(email).trim().toLowerCase()) as (User & { hash: string }) | undefined;
  const ok = await verifyPassword(password, row?.hash ?? DUMMY_HASH);
  if (!row || !ok || row.status !== "active") return null;
  getDb().prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now(), row.id);
  const { hash: _hash, ...user } = row;
  return user;
}

export function addMember(orgId: string, userId: string, role: Role): void {
  if (!(MEMBER_ROLES as readonly string[]).includes(role)) throw new ValidationError(`The role must be one of: ${MEMBER_ROLES.join(", ")}.`);
  if (!getOrganization(orgId)) throw new ValidationError("That organization does not exist.");
  try {
    getDb().prepare("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").run(orgId, userId, role, now());
  } catch (error) {
    if (/UNIQUE|PRIMARY/i.test((error as Error).message)) throw new ValidationError("That user is already a member of this organization.");
    if (/FOREIGN/i.test((error as Error).message)) throw new ValidationError("That user does not exist.");
    throw error;
  }
}

/** The role a user holds in an organization, or null. A suspended organization or a disabled user holds none. */
export function roleOf(orgId: string, userId: string): Role | null {
  const r = getDb()
    .prepare(
      `SELECT m.role AS role FROM memberships m
         JOIN organizations o ON o.id = m.org_id AND o.status = 'active'
         JOIN users u ON u.id = m.user_id AND u.status = 'active'
        WHERE m.org_id = ? AND m.user_id = ?`,
    )
    .get(orgId, userId) as { role: Role } | undefined;
  return r?.role ?? null;
}

export function organizationsOf(userId: string): { org: Organization; role: Role }[] {
  const rows = getDb()
    .prepare(
      `SELECT o.id, o.name, o.type, o.status, o.created_at AS createdAt, m.role AS role FROM memberships m
         JOIN organizations o ON o.id = m.org_id AND o.status = 'active'
        WHERE m.user_id = ? ORDER BY o.created_at`,
    )
    .all(userId) as (Organization & { role: Role })[];
  return rows.map(({ role, ...org }) => ({ org, role }));
}

// ---- tenant-scoped leads -------------------------------------------------------------------------------------------
/** A lead, only if it belongs to this organization. Another organization's lead is "not found". */
export function getLeadForOrg(orgId: string, leadId: string): Lead | null {
  const owned = getDb().prepare("SELECT 1 FROM leads WHERE id = ? AND org_id = ?").get(leadId, orgId);
  return owned ? getLead(leadId) : null;
}

/** Only this organization's leads, newest first. */
export function listLeadsForOrg(orgId: string): Lead[] {
  const ids = new Set((getDb().prepare("SELECT id FROM leads WHERE org_id = ?").all(orgId) as { id: string }[]).map((r) => r.id));
  return listLeads().filter((l) => ids.has(l.id));
}

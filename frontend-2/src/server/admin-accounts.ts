import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/business/db";
import { ValidationError } from "@/lib/business/validate";
import { hashPassword, verifyPassword } from "@/server/tenancy";

/**
 * Named administrator accounts, so the audit log can say WHO did something.
 *
 * The administrator token (set in the server environment, read only by admin-auth) still works and is the way in before any account exists and the way back in if every account is locked:
 * it is recorded as "admin". An account signs in with its email and password. Roles:
 *   admin  - can do everything an administrator can, including managing these accounts;
 *   viewer - can look at everything (finance, audit, payments) and change nothing.
 * Accounts are never deleted (the audit log refers to them): they are disabled. A disabled account, or one whose role changed, takes effect on its next request.
 * Signing sessions need the administrator token to be set (it is the signing secret).
 */
export const ADMIN_ROLES = ["admin", "viewer"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
export type AdminAccount = { id: string; email: string; name: string; role: AdminRole; status: "active" | "disabled"; createdAt: string; createdBy: string; lastLoginAt: string | null };
type Row = { id: string; email: string; name: string; password_hash: string; role: AdminRole; status: "active" | "disabled"; created_at: string; created_by: string; last_login_at: string | null };
const toAccount = (r: Row): AdminAccount => ({ id: r.id, email: r.email, name: r.name, role: r.role, status: r.status, createdAt: r.created_at, createdBy: r.created_by, lastLoginAt: r.last_login_at });
const bad = (m: string) => new ValidationError(m);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_ADMIN_PASSWORD = 12;

export const listAdminAccounts = (): AdminAccount[] => (getDb().prepare("SELECT * FROM admin_accounts ORDER BY created_at, id").all() as Row[]).map(toAccount);
export const getAdminAccount = (id: string): AdminAccount | null => {
  const r = getDb().prepare("SELECT * FROM admin_accounts WHERE id = ?").get(id) as Row | undefined;
  return r ? toAccount(r) : null;
};

export async function createAdminAccount(input: { email: unknown; name: unknown; password: unknown; role?: unknown; createdBy?: string }): Promise<AdminAccount> {
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const role = (input.role === undefined ? "admin" : input.role) as AdminRole;
  if (!EMAIL.test(email) || email.length > 200) throw bad("A valid email address is required.");
  if (name.length < 1 || name.length > 120) throw bad("The name is required (up to 120 characters).");
  if (!(ADMIN_ROLES as readonly unknown[]).includes(role)) throw bad(`role must be one of: ${ADMIN_ROLES.join(", ")}.`);
  if (typeof input.password !== "string" || input.password.length < MIN_ADMIN_PASSWORD) throw bad(`The password must be at least ${MIN_ADMIN_PASSWORD} characters.`);
  const hash = await hashPassword(input.password);
  const id = `adm_${randomUUID()}`;
  try {
    getDb().prepare("INSERT INTO admin_accounts (id, email, name, password_hash, role, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)").run(id, email, name, hash, role, new Date().toISOString(), (input.createdBy ?? "").slice(0, 80));
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) throw bad("There is already an administrator account with that email address.");
    throw e;
  }
  return getAdminAccount(id)!;
}

/** The accounts must always include at least one active administrator who can manage the rest (the token remains as a way back in, but should not be the only way). */
export async function updateAdminAccount(id: string, patch: { name?: unknown; role?: unknown; status?: unknown; password?: unknown }): Promise<AdminAccount> {
  const db = getDb();
  const cur = db.prepare("SELECT * FROM admin_accounts WHERE id = ?").get(id) as Row | undefined;
  if (!cur) throw bad("That administrator account does not exist.");
  const role = (patch.role === undefined ? cur.role : patch.role) as AdminRole;
  const status = (patch.status === undefined ? cur.status : patch.status) as AdminAccount["status"];
  const name = patch.name === undefined ? cur.name : typeof patch.name === "string" ? patch.name.trim() : "";
  if (!(ADMIN_ROLES as readonly unknown[]).includes(role)) throw bad(`role must be one of: ${ADMIN_ROLES.join(", ")}.`);
  if (status !== "active" && status !== "disabled") throw bad('status must be "active" or "disabled".');
  if (name.length < 1 || name.length > 120) throw bad("The name is required (up to 120 characters).");
  if (cur.role === "admin" && cur.status === "active" && (role !== "admin" || status !== "active")) {
    const others = (db.prepare("SELECT COUNT(*) AS n FROM admin_accounts WHERE role = 'admin' AND status = 'active' AND id != ?").get(id) as { n: number }).n;
    if (others === 0) throw bad("This is the only active administrator account. Create or keep another one first.");
  }
  let hash = cur.password_hash;
  if (patch.password !== undefined) {
    if (typeof patch.password !== "string" || patch.password.length < MIN_ADMIN_PASSWORD) throw bad(`The password must be at least ${MIN_ADMIN_PASSWORD} characters.`);
    hash = await hashPassword(patch.password);
  }
  db.prepare("UPDATE admin_accounts SET name = ?, role = ?, status = ?, password_hash = ? WHERE id = ?").run(name, role, status, hash, id);
  return getAdminAccount(id)!;
}

// A real-looking hash that matches no password, so an unknown email costs the same hashing work as a wrong password.
const DUMMY_HASH = `scrypt$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(64).toString("base64url")}`;

/** The account when the email and password are right and the account is active, otherwise null (never says which was wrong). */
export async function authenticateAdmin(email: unknown, password: unknown): Promise<AdminAccount | null> {
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  const row = e ? (getDb().prepare("SELECT * FROM admin_accounts WHERE email = ?").get(e) as Row | undefined) : undefined;
  const ok = await verifyPassword(typeof password === "string" ? password : "", row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok || row.status !== "active") return null;
  getDb().prepare("UPDATE admin_accounts SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  return toAccount(row);
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { getAdminAccount, type AdminRole } from "@/server/admin-accounts";
import { RATES, clientAddress, rateLimited } from "@/server/rate-limit";

/**
 * Admin authentication for the execution APIs (server-only).
 *
 * - The admin secret lives only in the server environment (SILPI_ADMIN_TOKEN, at least 16 characters).
 *   Without it the execution APIs refuse to work: they are closed by default, never open.
 * - Signing in exchanges the secret for a signed, HttpOnly, SameSite=Strict session cookie that expires.
 *   The secret itself is never stored in the browser or sent back.
 * - A request that changes anything must come from this same site (Origin check), so another website
 *   cannot drive an admin's browser.
 * - A script may instead send the secret as "Authorization: Bearer <secret>".
 */

export const ADMIN_COOKIE = "silpi_admin";
const SESSION_HOURS = 8;
const MIN_TOKEN_LENGTH = 16;

const secret = () => process.env.SILPI_ADMIN_TOKEN?.trim() ?? "";
export const adminConfigured = () => secret().length >= MIN_TOKEN_LENGTH;
/** How long the administrator token is (never the token itself): lets the launch checklist judge its strength without reading the secret anywhere else. */
export const adminTokenLength = (env: Record<string, string | undefined> = process.env): number => (env.SILPI_ADMIN_TOKEN ?? "").trim().length;

const sessionKey = () => createHash("sha256").update(`silpi-admin-session:${secret()}`).digest();
const sign = (payload: string) => createHmac("sha256", sessionKey()).update(payload).digest("base64url");

/** Compares two strings without leaking where they differ. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export const checkAdminToken = (candidate: unknown): boolean => adminConfigured() && typeof candidate === "string" && safeEqual(candidate, secret());

/** A session for the token (3 parts) or for a named account (4 parts: the account id is inside what is signed, so it cannot be swapped). */
export function createSession(now = Date.now(), accountId?: string): { value: string; maxAgeSeconds: number } {
  const expires = now + SESSION_HOURS * 3_600_000;
  const payload = `${expires}.${randomBytes(8).toString("hex")}${accountId ? `.${accountId}` : ""}`;
  return { value: `${payload}.${sign(payload)}`, maxAgeSeconds: SESSION_HOURS * 3600 };
}

/** Who is making an administrator request, and what they may do. */
export type AdminIdentity = { actor: string; role: AdminRole; accountId: string | null; name: string };
const TOKEN_IDENTITY: AdminIdentity = { actor: "admin", role: "admin", accountId: null, name: "Administrator token" };

function identityFromCookie(value: string | undefined, now: number): AdminIdentity | null {
  if (!adminConfigured() || !value) return null;
  const parts = value.split(".");
  if (parts.length !== 3 && parts.length !== 4) return null;
  const signature = parts[parts.length - 1]!;
  const expires = parts[0]!;
  const nonce = parts[1]!;
  if (!/^\d{10,16}$/.test(expires) || !/^[0-9a-f]{16}$/.test(nonce) || Number(expires) <= now) return null;
  if (!safeEqual(signature, sign(parts.slice(0, -1).join(".")))) return null;
  if (parts.length === 3) return TOKEN_IDENTITY;
  const account = getAdminAccount(parts[2]!);
  return account && account.status === "active" ? { actor: `admin:${account.email}`, role: account.role, accountId: account.id, name: account.name } : null;
}

/** The administrator behind a request, from the token header or a signed session cookie, or null. A disabled or changed account is noticed at once. */
export function adminIdentity(request: NextRequest, now = Date.now()): AdminIdentity | null {
  if (!adminConfigured()) return null;
  const header = request.headers.get("authorization");
  if (header) return header.startsWith("Bearer ") && checkAdminToken(header.slice(7).trim()) ? TOKEN_IDENTITY : null;
  return identityFromCookie(request.cookies.get(ADMIN_COOKIE)?.value, now);
}
/** What to write in the audit log as the doer of an administrator action. */
export const adminActor = (request: NextRequest): string => adminIdentity(request)?.actor ?? "admin";

export function verifySession(value: string | undefined, now = Date.now()): boolean {
  return identityFromCookie(value, now) !== null;
}

/** Even a signed-in administrator is held to a (generous) limit on changes, so a runaway script cannot rewrite the books in a loop. */
const writeLimit = (request: NextRequest): NextResponse | null => rateLimited(RATES.adminWrite, clientAddress(request));

const refuse = (status: number, error: string) => NextResponse.json({ success: false, error }, { status, headers: { "Cache-Control": "no-store" } });

/** A state-changing browser request must come from this same site. */
export function sameSite(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Returns an error response when the caller is not an admin, or null when the request may go on. */
export function requireAdmin(request: NextRequest): NextResponse | null {
  if (!adminConfigured()) {
    return refuse(503, "Admin sign-in is not configured. Set SILPI_ADMIN_TOKEN (16+ characters) in frontend-2/.env.local and restart the server.");
  }
  const header = request.headers.get("authorization");
  const identity = adminIdentity(request);
  if (!identity) return refuse(401, header ? "Invalid admin credentials." : "Admin sign-in required.");
  const reads = request.method === "GET" || request.method === "HEAD";
  if (reads) return null;
  if (!header && !sameSite(request)) return refuse(403, "Cross-site request blocked.");
  if (identity.role === "viewer") return refuse(403, "This administrator account can look at everything but not change anything.");
  return writeLimit(request);
}

// ---- sign-in attempts: a few per ten minutes per client ------------------------------------
const attempts = new Map<string, number[]>();
export function allowLoginAttempt(client: string, now = Date.now(), limit = 8, windowMs = 10 * 60_000): boolean {
  const recent = (attempts.get(client) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) return false;
  attempts.set(client, [...recent, now]);
  return true;
}
export const resetLoginAttempts = () => attempts.clear();

export function sessionCookie(request: NextRequest, value: string, maxAgeSeconds: number) {
  return { name: ADMIN_COOKIE, value, httpOnly: true, sameSite: "strict" as const, path: "/", maxAge: maxAgeSeconds, secure: request.nextUrl.protocol === "https:" };
}

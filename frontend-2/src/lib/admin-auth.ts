import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

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

const sessionKey = () => createHash("sha256").update(`silpi-admin-session:${secret()}`).digest();
const sign = (payload: string) => createHmac("sha256", sessionKey()).update(payload).digest("base64url");

/** Compares two strings without leaking where they differ. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export const checkAdminToken = (candidate: unknown): boolean => adminConfigured() && typeof candidate === "string" && safeEqual(candidate, secret());

export function createSession(now = Date.now()): { value: string; maxAgeSeconds: number } {
  const expires = now + SESSION_HOURS * 3_600_000;
  const payload = `${expires}.${randomBytes(8).toString("hex")}`;
  return { value: `${payload}.${sign(payload)}`, maxAgeSeconds: SESSION_HOURS * 3600 };
}

export function verifySession(value: string | undefined, now = Date.now()): boolean {
  if (!adminConfigured() || !value) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [expires, nonce, signature] = parts;
  if (!/^\d{10,16}$/.test(expires) || !/^[0-9a-f]{16}$/.test(nonce)) return false;
  if (Number(expires) <= now) return false;
  return safeEqual(signature, sign(`${expires}.${nonce}`));
}

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
  if (header) {
    return header.startsWith("Bearer ") && checkAdminToken(header.slice(7).trim()) ? null : refuse(401, "Invalid admin credentials.");
  }
  if (!verifySession(request.cookies.get(ADMIN_COOKIE)?.value)) return refuse(401, "Admin sign-in required.");
  const reads = request.method === "GET" || request.method === "HEAD";
  if (!reads && !sameSite(request)) return refuse(403, "Cross-site request blocked.");
  return null;
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

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Checking that a notice really came from the payment provider (server only). Providers sign what they send with a secret only they and we know;
 * anyone can POST to a public address, so nothing may be believed until its signature checks out. These are the two schemes the common providers
 * use, written once so an adapter only has to pass in the secret and the raw body (never a parsed one: the signature covers the exact bytes).
 */

export const hmacSha256Hex = (secret: string, data: string): string => createHmac("sha256", secret).update(data, "utf8").digest("hex");

/** Compares two hex signatures in constant time. Anything that is not valid hex of the right length is simply "no". */
export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length === 0 || a.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(a) || !/^[0-9a-fA-F]+$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * Timestamped scheme (the one Stripe uses): a header like "t=1700000000,v1=<hex>[,v1=<hex>]" where each v1 is HMAC-SHA256 of "<t>.<raw body>".
 * Rejects a notice older (or newer) than the tolerance, so a captured notice cannot be replayed later. Any one matching v1 is enough (providers
 * send two while they rotate a secret).
 */
export function verifyTimestampedSignature(header: string | null | undefined, rawBody: string, secret: string, opts: { toleranceSeconds?: number; nowSeconds?: number } = {}): boolean {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.trim());
  const t = parts.find((p) => p.startsWith("t="))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !/^\d{1,12}$/.test(t) || signatures.length === 0) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(t)) > (opts.toleranceSeconds ?? 300)) return false;
  const expected = hmacSha256Hex(secret, `${t}.${rawBody}`);
  return signatures.some((s) => safeEqualHex(s, expected));
}

/** Plain scheme (the one Razorpay uses): the signature is the HMAC-SHA256 of the raw body, in hex. No timestamp, so duplicates are caught by event id instead. */
export function verifyBodySignature(signatureHex: string | null | undefined, rawBody: string, secret: string): boolean {
  if (!signatureHex || !secret) return false;
  return safeEqualHex(signatureHex, hmacSha256Hex(secret, rawBody));
}

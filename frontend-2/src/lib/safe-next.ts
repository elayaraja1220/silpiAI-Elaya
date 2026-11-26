/**
 * Where to go after signing in. Only a path on this same site is accepted: a full address, a protocol-relative "//host", a backslash trick or anything
 * that is not an ordinary path is replaced by the fallback, so a sign-in link can never be used to send someone to another website.
 */
export function safeNext(value: string | null | undefined, fallback = "/"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const url = new URL(value, "http://studio.invalid");
    if (url.origin !== "http://studio.invalid") return fallback;
  } catch {
    return fallback;
  }
  return value;
}

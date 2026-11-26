// Rules for client accounts (pure: no I/O), shared by the server and the sign-in screens.
import { ValidationError } from "./business/validate";

/** Which version of the Terms of Service and Privacy Policy a person accepted. Change it when the texts change, so older acceptances stay identifiable. */
export const TERMS_VERSION = "2026-11";

/** Where a client goes after signing in when no other destination was asked for. */
export const CLIENT_HOME = "/ai";

export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 200;

// A practical e-mail check: one @, a dotted domain with a letter-only ending, no spaces, no consecutive dots. (Whether the address really exists is not
// something a form can know.)
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

/** The address in its stored form (trimmed, lower case), or a plain-language error. */
export function validateEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  const [local = ""] = email.split("@");
  if (!email || email.length > 254 || local.length > 64 || email.includes("..") || local.startsWith(".") || local.endsWith(".") || !EMAIL_RE.test(email)) {
    throw new ValidationError("Enter a valid email address.");
  }
  return email;
}

export function validateName(value: unknown): string {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (name.length < 2 || name.length > 80) throw new ValidationError("Enter your name (2 to 80 characters).");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>]/.test(name)) throw new ValidationError("The name cannot contain those characters.");
  return name;
}

const OBVIOUS = ["password", "passw0rd", "1234567890", "qwertyuiop", "letmein123", "welcome123", "iloveyou12", "admin12345", "silpiai123", "changeme123"];

/** The password when it is acceptable, otherwise a plain-language error. The length matches the existing sign-in rule. */
export function validatePassword(value: unknown, context: { email?: string; name?: string } = {}): string {
  const password = typeof value === "string" ? value : "";
  if (password.length < MIN_PASSWORD) throw new ValidationError(`The password must be at least ${MIN_PASSWORD} characters.`);
  if (password.length > MAX_PASSWORD) throw new ValidationError(`The password must be at most ${MAX_PASSWORD} characters.`);
  const lower = password.toLowerCase();
  if (/^(.)\1+$/.test(password)) throw new ValidationError("Choose a password that is not one character repeated.");
  const local = (context.email ?? "").split("@")[0]?.toLowerCase() ?? "";
  if (lower === (context.email ?? "").toLowerCase() || (local.length >= 6 && lower.includes(local))) throw new ValidationError("The password cannot contain your email address.");
  if (OBVIOUS.some((p) => lower.includes(p))) throw new ValidationError("That password is too easy to guess. Choose another.");
  return password;
}

/** A reset link token as it appears in a link: URL-safe text of the right size. Anything else is refused before the database is asked. */
export const looksLikeResetToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(value);

import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";

import { getDb } from "@/lib/business/db";

/** Demo links in the database, their files on disk, and the settings around them (server-only). */

export const DEMO_TOKEN_RE = /^[0-9a-f]{60}$/;
const now = () => new Date().toISOString();
const DAY = 24 * 60 * 60 * 1000;

/** Where the copied sites live. Not inside the web root, never served except through the demo gateway. */
export const demosRoot = (): string => path.resolve(process.env.SILPI_DEMOS_DIR || path.join(process.cwd(), "storage", "demos"));
export const siteDir = (id: string): string => path.join(demosRoot(), id, "site");

export type DemoReport = {
  framework: string;
  files: number;
  bytes: number;
  redactions: number;
  warnings: string[];
  pages: number;
  broken: { path: string; from: string; status: number }[];
  unverified: string[];
  truncated: boolean;
  checked: boolean;
};

export type DemoRow = {
  id: string; lead_id: string; token: string; label: string; mode: string; framework: string; project_name: string; spa: number;
  app_dir: string; start_command: string; password_hash: string; show_to_client: number; created_at: string; expires_at: string;
  revoked_at: string | null; views: number; last_view_at: string | null; report: string;
};

export type DemoStatus = "live" | "expired" | "stopped";
export const statusOf = (row: Pick<DemoRow, "revoked_at" | "expires_at">, at = Date.now()): DemoStatus =>
  row.revoked_at ? "stopped" : new Date(row.expires_at).getTime() <= at ? "expired" : "live";

export function parseReport(text: string): DemoReport {
  try { return { framework: "", files: 0, bytes: 0, redactions: 0, warnings: [], pages: 0, broken: [], unverified: [], truncated: false, checked: false, ...(JSON.parse(text) as Partial<DemoReport>) }; }
  catch { return { framework: "", files: 0, bytes: 0, redactions: 0, warnings: [], pages: 0, broken: [], unverified: [], truncated: false, checked: false }; }
}

// ---- password ---------------------------------------------------------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(password, salt, 32).toString("hex")}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---- links ------------------------------------------------------------------------------------------------------------------------------

export type NewDemo = {
  id?: string; leadId: string; label: string; mode: "static" | "app"; framework: string; projectName: string; spa: boolean;
  appDir?: string; startCommand?: string; password?: string; showToClient: boolean; days: number; report: DemoReport;
};

export function insertDemo(input: NewDemo): DemoRow {
  const id = input.id ?? randomUUID();
  const token = randomBytes(30).toString("hex"); // 240 bits, and short enough to be a host name label
  getDb()
    .prepare("INSERT INTO demo_links (id, lead_id, token, label, mode, framework, project_name, spa, app_dir, start_command, password_hash, show_to_client, created_at, expires_at, report) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.leadId, token, input.label, input.mode, input.framework, input.projectName, input.spa ? 1 : 0, input.appDir ?? "", input.startCommand ?? "", input.password ? hashPassword(input.password) : "", input.showToClient ? 1 : 0, now(), new Date(Date.now() + input.days * DAY).toISOString(), JSON.stringify(input.report));
  return getDemo(id)!;
}

export const getDemo = (id: string): DemoRow | null => (getDb().prepare("SELECT * FROM demo_links WHERE id = ?").get(id) as DemoRow | undefined) ?? null;
export const getDemoByToken = (token: string): DemoRow | null => (DEMO_TOKEN_RE.test(token) ? ((getDb().prepare("SELECT * FROM demo_links WHERE token = ?").get(token) as DemoRow | undefined) ?? null) : null);
export const listDemosForLead = (leadId: string): DemoRow[] => getDb().prepare("SELECT * FROM demo_links WHERE lead_id = ? ORDER BY created_at DESC").all(leadId) as DemoRow[];
export const listLiveDemos = (): DemoRow[] =>
  getDb().prepare("SELECT * FROM demo_links WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC").all(now()) as DemoRow[];
export const hasLiveDemos = (): boolean => listLiveDemos().length > 0;

export function addView(id: string): void {
  getDb().prepare("UPDATE demo_links SET views = views + 1, last_view_at = ? WHERE id = ?").run(now(), id);
}

export function revokeDemo(id: string): void {
  getDb().prepare("UPDATE demo_links SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(now(), id);
}

export function removeDemoFiles(id: string): void {
  rmSync(path.join(demosRoot(), id), { recursive: true, force: true });
}

/** Deletes the copies of stopped and expired demos (the rows stay, as a record). Returns the ids that were cleaned. */
export function purgeEnded(at = Date.now()): string[] {
  const rows = getDb().prepare("SELECT id, revoked_at, expires_at, mode FROM demo_links").all() as Pick<DemoRow, "id" | "revoked_at" | "expires_at" | "mode">[];
  const ended = rows.filter((r) => statusOf(r, at) !== "live" && r.mode === "static").map((r) => r.id);
  for (const id of ended) removeDemoFiles(id);
  return ended;
}

/** A lead is deleted: its demo copies go too. */
export function purgeLeadDemos(leadId: string): void {
  for (const row of listDemosForLead(leadId)) removeDemoFiles(row.id);
}

/** The demo (if any) a client may be shown on their quotation page. */
export function clientDemoFor(leadId: string): DemoRow | null {
  return listDemosForLead(leadId).find((r) => statusOf(r) === "live" && r.show_to_client === 1) ?? null;
}

// ---- settings ---------------------------------------------------------------------------------------------------------------------------

const getSetting = (key: string): string => ((getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? "");
const putSetting = (key: string, value: string): void => { getDb().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value); };

export const DEFAULT_PORT = 4100;
export const demoPort = (): number => {
  const n = Number(process.env.SILPI_DEMO_PORT);
  return Number.isInteger(n) && n >= 0 && n < 65536 ? n : DEFAULT_PORT;
};

/** The address clients open: the tunnel or host address when one is set, otherwise this computer's. */
export function publicBase(port = demoPort()): string {
  return process.env.SILPI_DEMO_PUBLIC_URL?.trim().replace(/\/+$/, "") || getSetting("demo_public_url") || `http://localhost:${port}`;
}
export const isLocalBase = (base: string): boolean => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(base);

/** Saves the public address (the tunnel URL). Empty = back to this computer. Only an origin: https, or http on localhost. */
export function setPublicBase(value: string): string {
  const v = value.trim();
  if (v === "") { putSetting("demo_public_url", ""); return ""; }
  let url: URL;
  try { url = new URL(v); } catch { throw new Error("That is not a web address. Use something like https://my-demo.trycloudflare.com"); }
  const local = /^(localhost|127\.0\.0\.1)$/i.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("The public address must start with https:// (a tunnel or host gives you one).");
  if (url.username || url.password) throw new Error("The address must not contain a user name or password.");
  const origin = url.origin;
  putSetting("demo_public_url", origin);
  return origin;
}

/** The link a client opens. */
export const clientLink = (row: Pick<DemoRow, "token">, base = publicBase()): string => `${base}/__demo/${row.token}`;
/** A link for the team on this computer: its own address, so several previews can be open side by side. */
export const previewLink = (row: Pick<DemoRow, "token">, port = demoPort()): string => `http://${row.token}.localhost:${port}/`;

// ---- cookie ---------------------------------------------------------------------------------------------------------------------------

const cookieKey = (): string => {
  let key = getSetting("demo_cookie_key");
  if (!key) { key = randomBytes(32).toString("hex"); putSetting("demo_cookie_key", key); }
  return key;
};
const sign = (payload: string) => createHmac("sha256", cookieKey()).update(payload).digest("hex");

export const COOKIE_NAME = "silpi_demo";
/** "token.expiry.signature": proves the visitor opened the link (and gave the password, if there is one). */
export function makeCookieValue(token: string, expiresAt: number): string {
  const payload = `${token}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}
export function readCookieValue(value: string | undefined, at = Date.now()): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [token, exp, sig] = parts;
  if (!DEMO_TOKEN_RE.test(token) || !/^\d{10,16}$/.test(exp) || Number(exp) <= at) return null;
  const expected = Buffer.from(sign(`${token}.${exp}`));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given) ? token : null;
}


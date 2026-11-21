import { createReadStream, readFileSync, statSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { startApp, stopAllApps, touchApp } from "./app-runner";
import { contentTypeOf, isHtmlFile, resolveStatic } from "./files";
import { injectOverlay, overlayScript } from "./overlay";
import {
  COOKIE_NAME, DEMO_TOKEN_RE, addView, demoPort, getDemoByToken, hasLiveDemos, makeCookieValue, purgeEnded, readCookieValue, siteDir, statusOf, verifyPassword, type DemoRow,
} from "./store";

/**
 * The demo gateway: ONE server that shows every project's demo, side by side and at the same time. (server-only)
 *
 * A client opens  <address>/__demo/<secret token>  once. That sets a cookie, and from then on every page of THEIR demo is served
 * at the normal paths (/products/blue-flute/ works as it will on the real site). The cookie, not the path, says which project
 * they are looking at, so different clients can look at different projects at the same moment through the one address, and
 * relative and root-relative links keep working for every framework. The team can also use  <token>.localhost:<port>  to open
 * several previews in separate tabs of the same browser.
 *
 * What a demo can never do: write (every non-GET request is refused), reach anything outside its own copy, or be found by a guess.
 */

export type GatewayStatus = { running: boolean; port: number | null; host: string; error?: string };

type State = { server: http.Server; port: number; host: string };
const g = globalThis as unknown as { silpiDemoGateway?: State; silpiDemoGatewayError?: string; silpiDemoUnlock?: Map<string, number[]> };

export function gatewayStatus(): GatewayStatus {
  const s = g.silpiDemoGateway;
  return { running: !!s, port: s?.port ?? null, host: s?.host ?? "127.0.0.1", ...(g.silpiDemoGatewayError ? { error: g.silpiDemoGatewayError } : {}) };
}

// ---- small helpers ----------------------------------------------------------------------------------------------------------------------

const BASE_HEADERS: Record<string, string> = {
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function send(res: ServerResponse, status: number, body: string | Buffer, type = "text/html; charset=utf-8", extra: Record<string, string> = {}, head = false): void {
  const buffer = typeof body === "string" ? Buffer.from(body) : body;
  res.writeHead(status, { ...BASE_HEADERS, "Content-Type": type, "Content-Length": buffer.length, ...extra });
  res.end(head ? undefined : buffer);
}

function infoPage(title: string, message: string, extraHead = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title>${extraHead}<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f1f5f9;color:#0f172a;font:16px/1.5 system-ui,sans-serif}main{background:#fff;border-radius:16px;padding:32px;max-width:420px;margin:16px;box-shadow:0 10px 40px rgba(15,23,42,.08)}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#475569}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${message}</p></main></body></html>`;
}

function passwordPage(token: string, error = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Private demo</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f1f5f9;color:#0f172a;font:16px/1.5 system-ui,sans-serif}form{background:#fff;border-radius:16px;padding:32px;width:100%;max-width:380px;margin:16px;box-shadow:0 10px 40px rgba(15,23,42,.08)}h1{font-size:20px;margin:0 0 4px}p{margin:0 0 16px;color:#475569;font-size:14px}input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:10px;font-size:16px}button{margin-top:12px;width:100%;padding:11px;border:0;border-radius:10px;background:#7c3aed;color:#fff;font-size:16px;font-weight:600;cursor:pointer}.e{color:#b91c1c;margin:10px 0 0;font-size:14px}</style></head><body><form method="post" action="/__demo/unlock"><h1>Private demo</h1><p>Enter the password you were given to open this preview.</p><input type="hidden" name="token" value="${escapeHtml(token)}"><input type="password" name="password" placeholder="Password" autocomplete="off" autofocus required>${error ? `<p class="e">${escapeHtml(error)}</p>` : ""}<button type="submit">Open the demo</button></form></body></html>`;
}

const parseCookies = (header: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
};

const expiryText = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
const secureRequest = (req: IncomingMessage) => req.headers["x-forwarded-proto"] === "https";

function setSession(req: IncomingMessage, res: ServerResponse, demo: DemoRow): void {
  const expiry = Math.min(new Date(demo.expires_at).getTime(), Date.now() + 7 * 24 * 3600 * 1000);
  const maxAge = Math.max(1, Math.floor((expiry - Date.now()) / 1000));
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${makeCookieValue(demo.token, expiry)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureRequest(req) ? "; Secure" : ""}`);
}

function allowUnlock(key: string, limit = 6, windowMs = 10 * 60_000): boolean {
  const map = (g.silpiDemoUnlock ??= new Map<string, number[]>());
  const recent = (map.get(key) ?? []).filter((t) => Date.now() - t < windowMs);
  if (recent.length >= limit) return false;
  map.set(key, [...recent, Date.now()]);
  return true;
}

/** Reads a small form. Anything bigger is refused without reading it all. */
function readBody(req: IncomingMessage, max = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] ?? 0) > max) return reject(new Error("too large"));
    let size = 0;
    let over = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) { if (!over) { over = true; reject(new Error("too large")); } } else if (!over) chunks.push(c);
    });
    req.on("end", () => { if (!over) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

// ---- the request handler -----------------------------------------------------------------------------------------------------------

const NOT_FOUND = () => infoPage("Nothing to see here", "Please open the demo link you were sent.");
const ENDED = () => infoPage("This demo has ended", "The preview you were sent is no longer available. Please ask for a new link.");

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://demo.local");
  const path = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();
  const head = method === "HEAD";

  if (path === "/__demo/overlay.js") return send(res, 200, overlayScript(), "text/javascript; charset=utf-8", { "Cache-Control": "public, max-age=300" }, head);

  if (path === "/__demo/unlock") {
    if (method !== "POST") return send(res, 405, infoPage("Not allowed", "This address only accepts the password form."));
    return unlock(req, res);
  }

  const entry = path.match(/^\/__demo\/([0-9a-f]{60})\/?$/);
  if (entry) {
    if (method !== "GET" && method !== "HEAD") return send(res, 405, infoPage("Not allowed", "This preview is view-only."));
    const demo = getDemoByToken(entry[1]);
    if (!demo) return send(res, 404, NOT_FOUND(), undefined, {}, head);
    if (statusOf(demo) !== "live") return send(res, 410, ENDED(), undefined, {}, head);
    if (demo.password_hash) return send(res, 200, passwordPage(demo.token), undefined, {}, head);
    setSession(req, res, demo);
    addView(demo.id);
    res.writeHead(302, { ...BASE_HEADERS, Location: "/", "Set-Cookie": res.getHeader("Set-Cookie") as string });
    return void res.end();
  }
  if (path.startsWith("/__demo/")) return send(res, 404, NOT_FOUND(), undefined, {}, head);

  // Which demo is this visitor looking at? The host name (team previews) or the cookie they got from the link.
  const hostLabel = (req.headers.host ?? "").split(":")[0].split(".")[0].toLowerCase();
  const viaHost = DEMO_TOKEN_RE.test(hostLabel) ? hostLabel : null;
  const cookieToken = readCookieValue(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  const token = viaHost ?? cookieToken;
  if (!token) return send(res, 404, NOT_FOUND(), undefined, {}, head);

  const demo = getDemoByToken(token);
  if (!demo) return send(res, 404, NOT_FOUND(), undefined, {}, head);
  if (statusOf(demo) !== "live") return send(res, 410, ENDED(), undefined, {}, head);

  // A password-protected demo needs the cookie that proves the password was given; an open one only needs the link.
  const hasSession = cookieToken === token;
  if (demo.password_hash && !hasSession) return send(res, 401, passwordPage(token), undefined, {}, head);
  if (!hasSession) { setSession(req, res, demo); addView(demo.id); }

  // A demo is view-only: nothing that writes is ever passed on.
  if (method !== "GET" && method !== "HEAD") {
    return send(res, 405, JSON.stringify({ demo: true, message: "This is a demo: forms and actions that send data are switched off." }), "application/json; charset=utf-8", { Allow: "GET, HEAD" }, head);
  }

  return demo.mode === "app" ? proxy(req, res, demo, url, head) : serveStatic(res, demo, url, head);
}

async function unlock(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let form: URLSearchParams;
  try { form = new URLSearchParams(await readBody(req)); } catch {
    // Close the connection after answering, so a large upload is not read to the end.
    res.on("finish", () => req.destroy());
    return send(res, 413, infoPage("Too much data", "Please try again."), undefined, { Connection: "close" });
  }
  const token = form.get("token") ?? "";
  const password = form.get("password") ?? "";
  const demo = getDemoByToken(token);
  if (!demo) return send(res, 404, NOT_FOUND());
  if (statusOf(demo) !== "live") return send(res, 410, ENDED());
  if (!allowUnlock(`${req.socket.remoteAddress ?? "?"}|${token}`)) return send(res, 429, infoPage("Too many tries", "Please wait a few minutes and try again."));
  if (!demo.password_hash || !password || !verifyPassword(password, demo.password_hash)) return send(res, 401, passwordPage(token, "That password is not right."));
  setSession(req, res, demo);
  addView(demo.id);
  res.writeHead(303, { ...BASE_HEADERS, Location: "/", "Set-Cookie": res.getHeader("Set-Cookie") as string });
  res.end();
}

function sendDemoHtml(res: ServerResponse, status: number, html: string, demo: DemoRow, head: boolean): void {
  send(res, status, injectOverlay(html, { label: demo.label, expires: expiryText(demo.expires_at) }), "text/html; charset=utf-8", {}, head);
}

function serveStatic(res: ServerResponse, demo: DemoRow, url: URL, head: boolean): void {
  const root = siteDir(demo.id);
  const found = resolveStatic(root, url.pathname, { spa: demo.spa === 1 });
  if (found.kind === "redirect") return void (res.writeHead(301, { ...BASE_HEADERS, Location: found.to + url.search }), res.end());
  if (found.kind === "blocked") return send(res, 404, NOT_FOUND(), undefined, {}, head);
  if (found.kind === "notfound") {
    if (found.page) return sendDemoHtml(res, 404, readFileSync(found.page, "utf8"), demo, head);
    return send(res, 404, infoPage("Page not found", "This page is not part of the demo."), undefined, {}, head);
  }
  if (isHtmlFile(found.file)) return sendDemoHtml(res, 200, readFileSync(found.file, "utf8"), demo, head);
  const size = statSync(found.file).size;
  res.writeHead(200, { ...BASE_HEADERS, "Cache-Control": "private, max-age=300", "Content-Type": contentTypeOf(found.file), "Content-Length": size });
  if (head) return void res.end();
  createReadStream(found.file).on("error", () => res.destroy()).pipe(res);
}

const DROP_RESPONSE_HEADERS = new Set(["set-cookie", "content-security-policy", "content-security-policy-report-only", "strict-transport-security", "transfer-encoding", "connection", "keep-alive"]);

async function proxy(req: IncomingMessage, res: ServerResponse, demo: DemoRow, url: URL, head: boolean): Promise<void> {
  const starting = startApp(demo);
  starting.catch(() => {});
  const port = await Promise.race([starting, new Promise<null>((r) => setTimeout(() => r(null), 4000))]).catch(() => -1);
  if (port === -1) return send(res, 502, infoPage("The demo could not start", "Please tell us and we will fix it."), undefined, {}, head);
  if (port === null) return send(res, 200, infoPage("Starting the demo...", "This takes a few seconds. The page will open by itself.", `<meta http-equiv="refresh" content="3">`), undefined, { Refresh: "3" }, head);
  touchApp(demo.id);

  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `127.0.0.1:${port}`, "accept-encoding": "identity" };
  delete headers.connection;
  delete headers["content-length"];
  const cookie = (req.headers.cookie ?? "").split(";").map((c) => c.trim()).filter((c) => c && !c.startsWith(`${COOKIE_NAME}=`)).join("; ");
  if (cookie) headers.cookie = cookie; else delete headers.cookie;

  const upstream = http.request({ host: "127.0.0.1", port, method: head ? "HEAD" : "GET", path: url.pathname + url.search, headers, timeout: 30_000 }, (up) => {
    const out: http.OutgoingHttpHeaders = { ...BASE_HEADERS };
    for (const [name, value] of Object.entries(up.headers)) {
      if (value === undefined || DROP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
      out[name] = value;
    }
    // The app talks about itself as 127.0.0.1:<port>: turn those redirects into addresses on this demo.
    if (typeof out.location === "string") out.location = out.location.replace(new RegExp(`^https?://(?:127\\.0\\.0\\.1|localhost):${port}`, "i"), "") || "/";
    const type = String(up.headers["content-type"] ?? "");
    if (/text\/html/i.test(type) && !head) {
      const chunks: Buffer[] = [];
      let size = 0;
      up.on("data", (c: Buffer) => { size += c.length; if (size <= 8 * 1024 * 1024) chunks.push(c); });
      up.on("end", () => {
        const html = injectOverlay(Buffer.concat(chunks).toString("utf8"), { label: demo.label, expires: expiryText(demo.expires_at) });
        delete out["content-length"];
        send(res, up.statusCode ?? 200, html, type || "text/html; charset=utf-8", Object.fromEntries(Object.entries(out).filter(([k]) => !["content-type", "content-length"].includes(k.toLowerCase())).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)])), false);
      });
      return;
    }
    res.writeHead(up.statusCode ?? 200, out);
    if (head) return void res.end();
    up.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
  upstream.on("error", () => { if (!res.headersSent) send(res, 502, infoPage("The demo is not answering", "Please try again in a moment."), undefined, {}, head); else res.destroy(); });
  upstream.end();
}

// ---- start and stop ------------------------------------------------------------------------------------------------------------------------

/** Starts the gateway (once). Safe to call again. Reports a clear problem if the port is taken. */
export function startGateway(opts: { port?: number; host?: string } = {}): Promise<GatewayStatus> {
  if (g.silpiDemoGateway) return Promise.resolve(gatewayStatus());
  const host = opts.host ?? process.env.SILPI_DEMO_HOST ?? "127.0.0.1";
  const wanted = opts.port ?? demoPort();
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      handle(req, res).catch(() => { if (!res.headersSent) send(res, 500, infoPage("Something went wrong", "Please try again.")); else res.destroy(); });
    });
    server.requestTimeout = 60_000;
    server.on("error", (e: NodeJS.ErrnoException) => {
      g.silpiDemoGatewayError = e.code === "EADDRINUSE" ? `Port ${wanted} is already in use. Set SILPI_DEMO_PORT to a free port number in .env.local and restart.` : e.message;
      resolve(gatewayStatus());
    });
    server.listen(wanted, host, () => {
      g.silpiDemoGateway = { server, port: (server.address() as AddressInfo).port, host };
      g.silpiDemoGatewayError = undefined;
      try { purgeEnded(); } catch { /* cleanup is best effort */ }
      resolve(gatewayStatus());
    });
  });
}
export const ensureGateway = (): Promise<GatewayStatus> => startGateway();

/** Starts the gateway at server start only when there are demos to show (a restart must not end a client's demo). */
export async function ensureGatewayIfNeeded(): Promise<void> {
  if (hasLiveDemos()) await startGateway();
}

export function stopGateway(): Promise<void> {
  const state = g.silpiDemoGateway;
  g.silpiDemoGateway = undefined;
  stopAllApps();
  if (!state) return Promise.resolve();
  return new Promise((resolve) => {
    state.server.closeAllConnections?.();
    state.server.close(() => resolve());
  });
}

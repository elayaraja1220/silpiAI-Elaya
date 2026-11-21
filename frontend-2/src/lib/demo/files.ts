import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Demo preview: safe file serving and secret scanning (server-only, no network).
 *
 * A demo only ever serves a COPY of the built website (never the project folder), and this module is the second wall: whatever
 * is in that copy, source files, dotfiles, maps and lock files are never served, and nothing can leave the folder.
 */

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", webmanifest: "application/manifest+json", txt: "text/plain; charset=utf-8", xml: "application/xml; charset=utf-8", md: "text/plain; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", pdf: "application/pdf",
};
export const contentTypeOf = (file: string): string => CONTENT_TYPES[path.extname(file).slice(1).toLowerCase()] ?? "application/octet-stream";
export const isHtmlFile = (file: string): boolean => /\.html?$/i.test(file);

const BLOCKED_NAMES = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.json", "dockerfile", "build.js", "serve.js", "test.js"]);

/** Paths that are never served or copied: dotfiles (except .well-known), node_modules, source maps, project and lock files. */
export function isBlockedPath(relative: string): boolean {
  const segments = relative.split("/").filter(Boolean);
  for (const segment of segments) {
    const s = segment.toLowerCase();
    if (s === ".well-known") continue;
    if (s.startsWith(".") || s === "node_modules") return true;
  }
  const last = (segments[segments.length - 1] ?? "").toLowerCase();
  return last.endsWith(".map") || BLOCKED_NAMES.has(last);
}

export type Resolved =
  | { kind: "file"; file: string; spa?: boolean }
  | { kind: "redirect"; to: string }
  | { kind: "blocked" }
  | { kind: "notfound"; page?: string };

const isRealFile = (p: string): boolean => {
  try {
    const s = lstatSync(p);
    return s.isFile() && !s.isSymbolicLink();
  } catch {
    return false;
  }
};
const isRealDir = (p: string): boolean => {
  try {
    const s = lstatSync(p);
    return s.isDirectory() && !s.isSymbolicLink();
  } catch {
    return false;
  }
};

/** Counts the HTML pages in a built site (decides between "many pages" and "one app that routes in the browser"). */
export function countHtmlFiles(root: string, limit = 50): number {
  let n = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (n >= limit) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!isBlockedPath(entry.name)) walk(full); }
      else if (isHtmlFile(entry.name)) n += 1;
    }
  };
  try { walk(root); } catch { /* an unreadable folder just counts as empty */ }
  return n;
}

/**
 * Turns a request path into a file inside `root`: clean URLs (/journey, /products/blue-flute and with a trailing slash), folders with
 * an index.html, and, for a single-page app, a fallback to index.html so client-side routes still load. Nothing outside `root`.
 */
export function resolveStatic(root: string, urlPath: string, opts: { spa?: boolean } = {}): Resolved {
  let decoded: string;
  try { decoded = decodeURIComponent(urlPath); } catch { return { kind: "notfound" }; }
  if (decoded.includes("\0") || decoded.includes("\\")) return { kind: "blocked" };
  const normal = path.posix.normalize(`/${decoded}`);
  const rel = normal.replace(/^\/+/, "");
  if (isBlockedPath(rel)) return { kind: "blocked" };

  const trailing = normal.endsWith("/") && rel !== "";
  const base = rel.replace(/\/+$/, "");
  const contained = (p: string) => {
    const r = path.relative(root, p);
    return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
  };

  if (base === "") {
    const index = path.join(root, "index.html");
    return isRealFile(index) ? { kind: "file", file: index } : { kind: "notfound" };
  }
  const direct = path.join(root, base);
  if (!contained(direct)) return { kind: "blocked" };
  if (!trailing && isRealFile(direct)) return { kind: "file", file: direct };
  const folderIndex = path.join(direct, "index.html");
  if (isRealDir(direct) && isRealFile(folderIndex)) {
    // A folder without its trailing slash would break relative links on that page, so send it to the canonical address.
    return trailing ? { kind: "file", file: folderIndex } : { kind: "redirect", to: `/${base}/` };
  }
  if (!trailing && isRealFile(`${direct}.html`)) return { kind: "file", file: `${direct}.html` };

  const hasExtension = path.extname(base) !== "";
  const root404 = path.join(root, "404.html");
  if (!hasExtension && opts.spa && isRealFile(path.join(root, "index.html"))) return { kind: "file", file: path.join(root, "index.html"), spa: true };
  return { kind: "notfound", ...(isRealFile(root404) ? { page: root404 } : {}) };
}

// ---- secrets ----------------------------------------------------------------------------------------------------------------------------

export type SecretHit = { file: string; kind: string; severity: "block" | "warn" };

const SECRET_PATTERNS: { kind: string; re: RegExp; severity: "block" | "warn" }[] = [
  { kind: "an Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{20,}/, severity: "block" },
  { kind: "a private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, severity: "block" },
  { kind: "an AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/, severity: "block" },
  { kind: "a GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, severity: "block" },
  { kind: "a Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, severity: "block" },
  { kind: "a Stripe live secret key", re: /\bsk_live_[A-Za-z0-9]{16,}/, severity: "block" },
  { kind: "a Google API key (check it is restricted)", re: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: "warn" },
  { kind: "a value that looks like a secret", re: /(?:secret|password|passwd|api[_-]?key|access[_-]?token)["']?\s*[:=]\s*["'][A-Za-z0-9_\-+/=]{16,}["']/i, severity: "warn" },
];

const TEXT_EXTENSIONS = new Set(["html", "htm", "css", "js", "mjs", "json", "txt", "xml", "svg", "md", "webmanifest"]);
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
export const isTextFile = (file: string): boolean => TEXT_EXTENSIONS.has(path.extname(file).slice(1).toLowerCase());

/** Looks for keys and secrets in the copied site. "block" findings stop the demo from being created. */
export function scanForSecrets(root: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!isTextFile(full) || statSync(full).size > MAX_TEXT_BYTES) continue;
      const text = readFileSync(full, "utf8");
      const seen = new Set<string>();
      for (const p of SECRET_PATTERNS) {
        if (p.re.test(text) && !seen.has(p.kind)) {
          seen.add(p.kind);
          hits.push({ file: path.relative(root, full).replace(/\\/g, "/"), kind: p.kind, severity: p.severity });
        }
      }
    }
  };
  if (existsSync(root)) walk(root);
  return hits;
}

/** The values in the project's own .env files: these must never appear in a demo (they are replaced while copying). */
export function readEnvValues(projectDir: string): string[] {
  const values = new Set<string>();
  let names: string[] = [];
  try { names = readdirSync(projectDir).filter((n) => /^\.env(\..+)?$/.test(n) && !/\.example$|\.sample$|\.template$/.test(n)); } catch { /* no folder */ }
  for (const name of names) {
    let text = "";
    try { text = readFileSync(path.join(projectDir, name), "utf8"); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/);
      if (!m) continue;
      const value = m[1].trim().replace(/^["']|["']$/g, "");
      if (value.length >= 8 && !/^(https?:\/\/)?(localhost|127\.0\.0\.1)/i.test(value)) values.add(value);
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

export const REDACTED = "DEMO-REDACTED";
export function redactValues(text: string, values: string[]): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const v of values) {
    if (!out.includes(v)) continue;
    const parts = out.split(v);
    count += parts.length - 1;
    out = parts.join(REDACTED);
  }
  return { text: out, count };
}

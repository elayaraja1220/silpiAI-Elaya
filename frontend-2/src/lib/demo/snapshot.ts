import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { contentTypeOf, isBlockedPath, isHtmlFile, isTextFile, redactValues, resolveStatic } from "./files";

/** Copies a built website into the demo area (server-only). Only the built output, only safe files, secrets replaced. */

export const MAX_SITE_BYTES = 250 * 1024 * 1024;
export const MAX_SITE_FILES = 20000;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

export type SnapshotResult = { files: number; bytes: number; redactions: number; skipped: string[] };

export function snapshotSite(source: string, dest: string, secrets: string[] = []): SnapshotResult {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const result: SnapshotResult = { files: 0, bytes: 0, redactions: 0, skipped: [] };
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { result.skipped.push(`${childRel} (link)`); continue; }
      if (isBlockedPath(childRel)) { result.skipped.push(childRel); continue; }
      const from = path.join(dir, entry.name);
      const to = path.join(dest, ...childRel.split("/"));
      if (entry.isDirectory()) { mkdirSync(to, { recursive: true }); walk(from, childRel); continue; }
      if (!entry.isFile()) continue;
      const size = statSync(from).size;
      result.files += 1;
      result.bytes += size;
      if (result.files > MAX_SITE_FILES) throw new Error(`The website has more than ${MAX_SITE_FILES} files, which is too many for a demo.`);
      if (result.bytes > MAX_SITE_BYTES) throw new Error(`The website is larger than ${MAX_SITE_BYTES / 1048576} MB, which is too big for a demo.`);
      if (secrets.length && isTextFile(from) && size <= MAX_TEXT_BYTES) {
        const { text, count } = redactValues(readFileSync(from, "utf8"), secrets);
        result.redactions += count;
        writeFileSync(to, text);
      } else {
        copyFileSync(from, to);
      }
    }
  };
  walk(source, "");
  return result;
}

// ---- the link check ------------------------------------------------------------------------------------------------------------------

export type PageReply = { status: number; type: string; body: string; spa?: boolean };
/** Reads one page of the site: from the copied folder, or from the running app. null = unreachable. */
export type PageFetch = (urlPath: string) => Promise<PageReply | null>;

export type CrawlReport = {
  pages: number;
  assets: number;
  broken: { path: string; from: string; status: number }[];
  /** Paths answered by a single-page app's fallback: they exist only if the app's own routes handle them. */
  unverified: string[];
  truncated: boolean;
};

const attr = /\b(?:href|src|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** Internal targets of a page, as absolute paths. Skips external links, mailto:, tel:, javascript:, data: and #anchors. */
export function linksIn(html: string, pagePath: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(attr)) {
    const raw = (m[1] ?? m[2] ?? "").trim();
    if (!raw || raw.startsWith("#") || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue;
    const clean = raw.split("#")[0].split("?")[0];
    if (!clean) continue;
    const base = pagePath.endsWith("/") ? pagePath : pagePath.replace(/[^/]*$/, "");
    const target = clean.startsWith("/") ? clean : path.posix.normalize(`${base}${clean}`);
    if (target.startsWith("/..")) continue;
    found.add(target);
  }
  return [...found];
}

/** Product and sitemap addresses too: the sitemap lists pages that no menu links to. */
function sitemapPaths(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
    try { out.push(new URL(m[1]).pathname); } catch { if (m[1].startsWith("/")) out.push(m[1]); }
  }
  return out;
}

/**
 * Follows every internal link from the home page (and the sitemap) and reports what does not load. Product pages and other
 * "slug" pages are found because the listing pages link to them. Breadth-first, capped.
 */
export async function crawlSite(fetchPage: PageFetch, maxPages = 300): Promise<CrawlReport> {
  const report: CrawlReport = { pages: 0, assets: 0, broken: [], unverified: [], truncated: false };
  const seen = new Set<string>();
  const queue: { path: string; from: string }[] = [{ path: "/", from: "(start)" }];
  const sitemap = await fetchPage("/sitemap.xml").catch(() => null);
  if (sitemap && sitemap.status === 200) for (const p of sitemapPaths(sitemap.body)) queue.push({ path: p, from: "sitemap.xml" });

  while (queue.length) {
    const next = queue.shift()!;
    const key = next.path.replace(/\/+$/, "") || "/";
    if (seen.has(key)) continue;
    seen.add(key);
    if (report.pages + report.assets >= maxPages) { report.truncated = true; break; }
    const reply = await fetchPage(next.path).catch(() => null);
    if (!reply || reply.status >= 400) { report.broken.push({ path: next.path, from: next.from, status: reply?.status ?? 0 }); continue; }
    if (reply.spa && path.extname(next.path) === "") report.unverified.push(next.path);
    if (/html/i.test(reply.type)) {
      report.pages += 1;
      for (const target of linksIn(reply.body, next.path)) if (!seen.has(target.replace(/\/+$/, "") || "/")) queue.push({ path: target, from: next.path });
    } else {
      report.assets += 1;
    }
  }
  return report;
}

/** The page reader for a copied static site (no server needed). */
export function staticFetcher(root: string, spa: boolean): PageFetch {
  return async (urlPath) => {
    let hops = 0;
    let target = urlPath;
    for (;;) {
      const r = resolveStatic(root, target, { spa });
      if (r.kind === "redirect" && hops++ < 3) { target = r.to; continue; }
      if (r.kind === "file") {
        const html = isHtmlFile(r.file);
        return { status: 200, type: contentTypeOf(r.file), body: html ? readFileSync(r.file, "utf8") : "", spa: r.spa };
      }
      return { status: r.kind === "blocked" ? 403 : 404, type: "", body: "" };
    }
  };
}

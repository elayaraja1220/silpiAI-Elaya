// Demo preview, the safe core: which files may be served, clean URLs and slug pages, secrets, the overlay and the link check.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { detectProject } from "@/lib/demo/detect";
import { isBlockedPath, readEnvValues, redactValues, resolveStatic, scanForSecrets } from "@/lib/demo/files";
import { injectOverlay, overlayScript } from "@/lib/demo/overlay";
import { crawlSite, linksIn, snapshotSite, staticFetcher } from "@/lib/demo/snapshot";

const root = mkdtempSync(path.join(tmpdir(), "silpi-demo-core-"));
after(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a file a moment */ } });

const write = (base: string, rel: string, body: string | Buffer) => {
  const full = path.join(base, ...rel.split("/"));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
};

/** A small multi-page site with a listing and product (slug) pages, built into dist/. */
function makeSite(name: string, opts: { brokenLink?: boolean } = {}) {
  const dir = path.join(root, name);
  const dist = path.join(dir, "dist");
  write(dist, "index.html", `<html><head><title>Home</title></head><body><a href="/products/">Products</a><a href="/about">About</a><link rel="stylesheet" href="/assets/site.css"></body></html>`);
  write(dist, "about/index.html", `<html><body><h1>About</h1><a href="../">Home</a></body></html>`);
  write(dist, "products/index.html", `<html><body><a href="/products/blue-flute/">Blue flute</a><a href="/products/nadaswaram-classic">Nadaswaram classic</a>${opts.brokenLink ? `<a href="/products/missing-one/">Missing</a>` : ""}</body></html>`);
  write(dist, "products/blue-flute/index.html", `<html><body><h1>Blue flute</h1><img src="/assets/flute.png"></body></html>`);
  write(dist, "products/nadaswaram-classic.html", `<html><body><h1>Nadaswaram classic</h1></body></html>`);
  write(dist, "assets/site.css", "body{color:#111}");
  write(dist, "assets/flute.png", Buffer.from([137, 80, 78, 71]));
  write(dist, "404.html", "<html><body>Not found</body></html>");
  write(dist, "sitemap.xml", `<urlset><url><loc>https://example.com/products/blue-flute/</loc></url></urlset>`);
  return { dir, dist };
}

describe("files that are never served", () => {
  it("blocks dotfiles, source maps, node_modules and project files at any depth", () => {
    for (const p of [".env", ".silpi/brief.md", "a/.git/config", "assets/app.js.map", "node_modules/x/index.js", "package.json", "deep/package-lock.json", "build.js", "serve.js", ".htaccess"]) assert.equal(isBlockedPath(p), true, p);
    for (const p of ["index.html", "assets/site.css", "products/blue-flute/index.html", ".well-known/security.txt", "robots.txt"]) assert.equal(isBlockedPath(p), false, p);
  });
  it("cannot leave the site folder, however the path is written", () => {
    const { dist } = makeSite("traversal");
    write(path.dirname(dist), "secret.txt", "do not serve");
    for (const p of ["/../secret.txt", "/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt", "/..\\secret.txt", "/%00", "/assets/%2e%2e%2f%2e%2e%2fsecret.txt"]) {
      const r = resolveStatic(dist, p);
      assert.ok(r.kind !== "file", `${p} must not resolve to a file (got ${JSON.stringify(r)})`);
    }
    assert.equal(resolveStatic(dist, "/.env").kind, "blocked");
    assert.equal(resolveStatic(dist, "/package.json").kind, "blocked");
    assert.equal(resolveStatic(dist, "/assets/x.js.map").kind, "blocked");
  });
});

describe("clean URLs and slug pages", () => {
  const { dist } = makeSite("clean");
  const file = (p: string, opts?: { spa?: boolean }) => { const r = resolveStatic(dist, p, opts); return r.kind === "file" ? path.relative(dist, r.file).replace(/\\/g, "/") : r.kind; };
  it("serves pages with and without the trailing slash, and .html files by clean name", () => {
    assert.equal(file("/"), "index.html");
    assert.equal(file("/about/"), "about/index.html");
    assert.equal(file("/products/blue-flute/"), "products/blue-flute/index.html");
    assert.equal(file("/products/nadaswaram-classic"), "products/nadaswaram-classic.html");
    assert.equal(file("/products/nadaswaram-classic.html"), "products/nadaswaram-classic.html");
    assert.equal(file("/assets/site.css"), "assets/site.css");
  });
  it("sends a folder without its slash to the canonical address so relative links keep working", () => {
    assert.deepEqual(resolveStatic(dist, "/about"), { kind: "redirect", to: "/about/" });
    assert.deepEqual(resolveStatic(dist, "/products/blue-flute"), { kind: "redirect", to: "/products/blue-flute/" });
  });
  it("unknown pages are 404 and use the site's own 404 page; a single-page app falls back to index.html", () => {
    const r = resolveStatic(dist, "/products/no-such-thing/");
    assert.equal(r.kind, "notfound");
    assert.ok(r.kind === "notfound" && r.page?.endsWith("404.html"));
    assert.equal(file("/missing.css"), "notfound", "a missing asset is never answered with the app shell");
    assert.equal(file("/products/some-slug", { spa: true }), "index.html", "client-routed slug in a single-page app");
  });
});

describe("secrets", () => {
  it("finds keys in a built site and tells blocking findings from warnings", () => {
    const dir = path.join(root, "secrets");
    write(dir, "main.js", `var k="sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";`);
    write(dir, "pay.js", `var s="sk_live_abcdefghijklmnop1234";`);
    write(dir, "maps.html", `<script src="https://maps.example/x?key=AIzaSyA1234567890abcdefghijklmnopqrstuv"></script>`);
    write(dir, "ok.js", `var a = "hello";`);
    const hits = scanForSecrets(dir);
    assert.ok(hits.some((h) => h.file === "main.js" && h.severity === "block"));
    assert.ok(hits.some((h) => h.file === "pay.js" && h.severity === "block"));
    assert.ok(hits.some((h) => h.file === "maps.html" && h.severity === "warn"));
    assert.ok(!hits.some((h) => h.file === "ok.js"));
  });
  it("reads values from the project's .env files (not the example) and replaces them in the copy", () => {
    const { dir, dist } = makeSite("withenv");
    write(dir, ".env", "WEB3FORMS_ACCESS_KEY=abcd-1234-real-key\nSITE_URL=http://localhost:3000\nSHORT=abc\n");
    write(dir, ".env.example", "WEB3FORMS_ACCESS_KEY=your-key-here-placeholder\n");
    const values = readEnvValues(dir);
    assert.deepEqual(values, ["abcd-1234-real-key"], "example files, short values and localhost are not secrets");
    write(dist, "main.js", `var KEY = "abcd-1234-real-key"; // and again abcd-1234-real-key`);
    const copy = path.join(root, "withenv-copy");
    const result = snapshotSite(dist, copy, values);
    assert.equal(result.redactions, 2);
    assert.ok(!readFileSync(path.join(copy, "main.js"), "utf8").includes("real-key"));
    assert.match(readFileSync(path.join(copy, "main.js"), "utf8"), /DEMO-REDACTED/);
    assert.equal(redactValues("a b", ["zzzzzzzz"]).count, 0);
  });
});

describe("the copy", () => {
  it("copies only safe files and never the project's own files", () => {
    const { dist } = makeSite("copy");
    write(dist, ".env", "SECRET=1234567890");
    write(dist, "assets/app.js.map", "{}");
    write(dist, "node_modules/x/index.js", "x");
    write(dist, "package.json", "{}");
    const copy = path.join(root, "copy-out");
    const result = snapshotSite(dist, copy);
    for (const p of [".env", "assets/app.js.map", "node_modules", "package.json"]) assert.ok(!existsSync(path.join(copy, ...p.split("/"))), `${p} must not be copied`);
    assert.ok(existsSync(path.join(copy, "products", "blue-flute", "index.html")));
    assert.ok(result.skipped.length >= 4);
    assert.ok(result.files >= 8);
  });
});

describe("the overlay", () => {
  it("is added once before </body>, with a noindex tag, and the label cannot break out of the page", () => {
    const evil = `Acme "><script>alert(1)</script>`;
    const out = injectOverlay(`<html><head></head><body><p>x</p></body></html>`, { label: evil, expires: "30 Nov 2026" });
    assert.match(out, /<meta name="robots" content="noindex,nofollow">/);
    assert.ok(out.indexOf("overlay.js") < out.indexOf("</body>"));
    assert.ok(!out.includes("<script>alert(1)</script>"), "the label is escaped");
    assert.equal(injectOverlay(out, { label: "x", expires: "y" }), out, "never added twice");
    assert.ok(injectOverlay("<p>no body tag</p>", { label: "A", expires: "B" }).endsWith("</script>"));
  });
  it("switches off forms and anything that sends data, and shows the demo bar", () => {
    const js = overlayScript();
    assert.match(js, /DEMO PREVIEW/);
    assert.match(js, /addEventListener\("submit"/);
    assert.match(js, /window\.fetch/);
    assert.match(js, /XMLHttpRequest/);
    assert.match(js, /sendBeacon/);
    assert.doesNotThrow(() => new Function(js), "the script is valid JavaScript");
  });
});

describe("the link check", () => {
  it("finds the internal links of a page and skips external ones", () => {
    const links = linksIn(`<a href="/a">1</a><a href="b/c">2</a><a href="../d">3</a><a href="https://x.com">4</a><a href="mailto:a@b.c">5</a><a href="#top">6</a><a href="//cdn.x/y.js">7</a><a href="/e?x=1#z">8</a>`, "/section/page");
    assert.deepEqual(links.sort(), ["/a", "/d", "/e", "/section/b/c"].sort());
  });
  it("follows the listing to every product page and reports nothing when all load", async () => {
    const { dist } = makeSite("crawl-ok");
    const report = await crawlSite(staticFetcher(dist, false));
    assert.deepEqual(report.broken, []);
    assert.ok(report.pages >= 5, `pages: ${report.pages}`);
    assert.ok(report.assets >= 2);
    assert.deepEqual(report.unverified, []);
  });
  it("reports a product page that does not exist, and where the link is", async () => {
    const { dist } = makeSite("crawl-broken", { brokenLink: true });
    const report = await crawlSite(staticFetcher(dist, false));
    assert.equal(report.broken.length, 1);
    assert.equal(report.broken[0].path, "/products/missing-one/");
    assert.equal(report.broken[0].from, "/products/");
    assert.equal(report.broken[0].status, 404);
  });
  it("cannot say whether client-routed pages exist in a single-page app, and says so", async () => {
    const dir = path.join(root, "spa");
    write(dir, "index.html", `<html><body><a href="/products/x">x</a></body></html>`);
    const report = await crawlSite(staticFetcher(dir, true));
    assert.deepEqual(report.broken, []);
    assert.deepEqual(report.unverified, ["/products/x"]);
  });
});

describe("what kind of project it is", () => {
  const pkg = (dir: string, body: object) => write(dir, "package.json", JSON.stringify(body));
  it("a built folder of pages is static", () => {
    const { dir } = makeSite("detect-static");
    pkg(dir, { scripts: { build: "x", start: "x" } });
    const d = detectProject(dir);
    assert.equal(d.mode, "static");
    assert.ok(d.mode === "static" && d.outputDir.endsWith("dist") && d.spa === false);
  });
  it("a single index.html is treated as a single-page app", () => {
    const dir = path.join(root, "detect-spa");
    pkg(dir, { dependencies: { react: "1", vite: "1" } });
    write(dir, "dist/index.html", "<html></html>");
    const d = detectProject(dir);
    assert.ok(d.mode === "static" && d.spa === true);
  });
  it("a framework that needs a server is run, not copied", () => {
    const dir = path.join(root, "detect-next");
    pkg(dir, { dependencies: { next: "15" }, scripts: { start: "next start", build: "next build" } });
    write(dir, ".next/BUILD_ID", "x");
    const d = detectProject(dir);
    assert.ok(d.mode === "app" && d.framework === "Next.js" && d.startCommand === "npm run start");
  });
  it("a Next.js static export is plain static files", () => {
    const dir = path.join(root, "detect-next-export");
    pkg(dir, { dependencies: { next: "15" }, scripts: { start: "next start" } });
    write(dir, ".next/BUILD_ID", "x");
    write(dir, "out/index.html", "<html></html>");
    write(dir, "out/about/index.html", "<html></html>");
    assert.equal(detectProject(dir).mode, "static");
  });
  it("nothing built yet says so", () => {
    const dir = path.join(root, "detect-none");
    pkg(dir, { scripts: { build: "x" } });
    const d = detectProject(dir);
    assert.ok(d.mode === "none" && /not been built/.test(d.reason));
  });
});

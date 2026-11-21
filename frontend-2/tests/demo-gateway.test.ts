// Demo preview end to end: creating demos, and serving several projects' demos at the same time through the one gateway.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const root = mkdtempSync(path.join(tmpdir(), "silpi-demo-gw-"));
process.env.SILPI_DB_PATH = path.join(root, "test.db");
process.env.SILPI_DEMOS_DIR = path.join(root, "demos");
delete process.env.SILPI_DEMO_PUBLIC_URL;
const WORKSPACES = path.join(root, "workspaces");
mkdirSync(WORKSPACES, { recursive: true });

const mods = async () => ({
  store: await import("@/lib/business/store"),
  validate: await import("@/lib/business/validate"),
  db: await import("@/lib/business/db"),
  demo: await import("@/lib/demo/service"),
  dstore: await import("@/lib/demo/store"),
  gateway: await import("@/lib/demo/gateway"),
  runner: await import("@/lib/demo/app-runner"),
});

const write = (base: string, rel: string, body: string | Buffer) => {
  const full = path.join(base, ...rel.split("/"));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
};

const requirement = () => ({
  title: "Demo site", summary: "A website that is long enough to be a valid summary.", scope: "full" as const, existingProject: "", version: "", projectType: "business-website" as const, complexity: "basic" as const,
  pages: ["Home", "About Us", "Contact Us"], modules: [], design: "ai" as const, references: "", domain: { needed: false, choice: "self" as const, name: "", tld: ".com", years: 1 },
  hosting: { needed: false, choice: "self" as const, plan: "static" as const, years: 1 }, deadlineWeeks: 0, budget: 0,
});

/** A lead whose generated project lives in the test workspace, with a built dist/ of pages and product (slug) pages. */
async function projectWithSite(name: string, opts: { title: string; env?: string; extra?: (dist: string, dir: string) => void } = { title: name }) {
  const m = await mods();
  const client = { name: `${name} Client`, email: "t@example.com", phone: "9876543210", company: "", gstin: "", state: "Tamil Nadu", address: "" };
  const lead = m.store.createLead(client, m.validate.parseRequirement(requirement(), m.store.getRateCard()), "standard");
  const dir = path.join(WORKSPACES, name);
  const dist = path.join(dir, "dist");
  write(dist, "index.html", `<html><head><title>${opts.title}</title></head><body><h1>${opts.title} HOME</h1><a href="/products/">Products</a><a href="/about">About</a></body></html>`);
  write(dist, "about/index.html", `<html><body><h1>${opts.title} ABOUT</h1></body></html>`);
  write(dist, "products/index.html", `<html><body><a href="/products/blue-flute/">Blue flute</a><a href="/products/nadaswaram-classic">Nadaswaram</a></body></html>`);
  write(dist, "products/blue-flute/index.html", `<html><body><h1>${opts.title} BLUE FLUTE</h1></body></html>`);
  write(dist, "products/nadaswaram-classic.html", `<html><body><h1>${opts.title} NADASWARAM</h1></body></html>`);
  write(dist, "assets/site.css", "body{color:#111}");
  write(dist, "404.html", `<html><body>${opts.title} 404</body></html>`);
  write(dir, "package.json", JSON.stringify({ name, scripts: { build: "x" } }));
  write(dir, ".env", opts.env ?? "WEB3FORMS_ACCESS_KEY=real-secret-key-98765\n");
  opts.extra?.(dist, dir);
  m.db.getDb().prepare("UPDATE leads SET project_name = ? WHERE id = ?").run(name, lead.id);
  return { id: lead.id, name, dir, dist };
}

const deps = (over: Partial<import("@/lib/demo/service").DemoDeps> = {}): import("@/lib/demo/service").DemoDeps => ({ workspaceRoot: () => WORKSPACES, build: async () => ({ ok: false, message: "no build in tests" }), ...over });

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };
let port = 0;
/** A plain HTTP request to the gateway with a chosen Host header and cookie (fetch cannot set Host). */
function call(p: string, opts: { method?: string; host?: string; cookie?: string; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: opts.method ?? "GET", headers: { host: opts.host ?? `localhost:${port}`, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.body ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(opts.body) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
const cookieOf = (r: Reply): string => String((r.headers["set-cookie"] ?? [])[0] ?? "").split(";")[0];
/** Opens a demo the way a client does and returns what their browser would keep. */
async function open(token: string): Promise<string> {
  const r = await call(`/__demo/${token}`);
  assert.equal(r.status, 302, "the link redirects to the demo");
  assert.equal(r.headers.location, "/");
  const cookie = cookieOf(r);
  assert.match(cookie, /^silpi_demo=/);
  return cookie;
}

before(async () => {
  const m = await mods();
  const status = await m.gateway.startGateway({ port: 0 });
  assert.equal(status.running, true, status.error);
  port = status.port!;
});
after(async () => {
  const m = await mods();
  await m.gateway.stopGateway();
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may hold a file a moment */ }
});

describe("creating a demo", () => {
  it("copies the built site, replaces the project's .env values, follows every link, and keeps the project folder out", async () => {
    const m = await mods();
    const p = await projectWithSite("create-ok", { title: "OK", extra: (dist) => write(dist, "main.js", `var k="real-secret-key-98765";`) });
    const view = await m.demo.createDemo(p.id, { days: 5, label: "Acme Traders" }, deps());
    assert.equal(view.status, "live");
    assert.equal(view.mode, "static");
    assert.equal(view.label, "Acme Traders");
    assert.deepEqual(view.report.broken, [], "every page and product page loads");
    assert.ok(view.report.pages >= 5, `pages ${view.report.pages}`);
    assert.equal(view.report.redactions, 1);
    assert.match(view.report.warnings.join(" "), /\.env file were replaced/);
    assert.match(view.url, /^http:\/\/localhost:\d+\/__demo\/[0-9a-f]{60}$/);
    assert.match(view.previewUrl, /^http:\/\/[0-9a-f]{60}\.localhost:\d+\/$/);
    const copy = path.join(process.env.SILPI_DEMOS_DIR!, view.id, "site");
    assert.ok(existsSync(path.join(copy, "products", "blue-flute", "index.html")));
    assert.ok(!existsSync(path.join(copy, "package.json")) && !existsSync(path.join(copy, ".env")), "only the built output is copied");
    assert.ok(Math.round((new Date(view.expiresAt).getTime() - Date.now()) / 86_400_000) === 5);
  });

  it("reports a broken product page, but still creates the demo so the team can decide", async () => {
    const m = await mods();
    const p = await projectWithSite("create-broken", { title: "BR", extra: (dist) => write(dist, "products/index.html", `<a href="/products/blue-flute/">x</a><a href="/products/gone/">gone</a>`) });
    const view = await m.demo.createDemo(p.id, {}, deps());
    assert.deepEqual(view.report.broken.map((b) => b.path), ["/products/gone/"]);
  });

  it("refuses a site that contains a real key, and leaves nothing behind", async () => {
    const m = await mods();
    const p = await projectWithSite("create-secret", { title: "SE", env: "NOTHING=1\n", extra: (dist) => write(dist, "app.js", `var k="sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";`) });
    await assert.rejects(() => m.demo.createDemo(p.id, {}, deps()), /contains an Anthropic API key in app\.js/);
    assert.deepEqual(m.dstore.listDemosForLead(p.id), []);
  });

  it("checks the options and the project", async () => {
    const m = await mods();
    const p = await projectWithSite("create-opts", { title: "OP" });
    await assert.rejects(() => m.demo.createDemo(p.id, { days: 0 }, deps()), /1 to 30 days/);
    await assert.rejects(() => m.demo.createDemo(p.id, { days: 31 }, deps()), /1 to 30 days/);
    await assert.rejects(() => m.demo.createDemo(p.id, { password: "abc" }, deps()), /4 to 64 characters/);
    await assert.rejects(() => m.demo.createDemo("00000000-0000-0000-0000-000000000000", {}, deps()), /not found/);
    const client = { name: "N", email: "n@example.com", phone: "9876543210", company: "", gstin: "", state: "Tamil Nadu", address: "" };
    const bare = m.store.createLead(client, m.validate.parseRequirement(requirement(), m.store.getRateCard()), "basic");
    await assert.rejects(() => m.demo.createDemo(bare.id, {}, deps()), /Generate the project first/);
    // An unbuilt project: the build is attempted, and its failure is explained.
    const dir = path.join(WORKSPACES, "unbuilt");
    write(dir, "package.json", JSON.stringify({ scripts: { build: "x" } }));
    m.db.getDb().prepare("UPDATE leads SET project_name = ? WHERE id = ?").run("unbuilt", bare.id);
    await assert.rejects(() => m.demo.createDemo(bare.id, {}, deps()), /could not be built for the demo. no build in tests/);
    let built = false;
    await m.demo.createDemo(bare.id, {}, deps({ build: async (d) => { built = true; write(d, "dist/index.html", "<html><body>built</body></html>"); return { ok: true, message: "" }; } }));
    assert.equal(built, true, "the project is built first when nothing is built");
  });

  it("allows only a few live demos per project", async () => {
    const m = await mods();
    const p = await projectWithSite("create-cap", { title: "CAP" });
    for (let i = 0; i < 3; i++) await m.demo.createDemo(p.id, {}, deps());
    await assert.rejects(() => m.demo.createDemo(p.id, {}, deps()), /already has 3 live demos/);
  });
});

describe("what a client sees through the gateway", () => {
  it("opens with the link, then every page and product page works at its normal address", async () => {
    const m = await mods();
    const p = await projectWithSite("gw-basic", { title: "BASIC" });
    const view = await m.demo.createDemo(p.id, { label: "Basic Co" }, deps());
    const token = view.url.split("/").pop()!;

    assert.equal((await call("/")).status, 404, "no link, no demo");
    assert.equal((await call("/products/blue-flute/")).status, 404);
    const cookie = await open(token);
    assert.equal(m.dstore.getDemo(view.id)!.views, 1);

    const home = await call("/", { cookie });
    assert.equal(home.status, 200);
    assert.match(home.body, /BASIC HOME/);
    assert.match(home.body, /<script src="\/__demo\/overlay\.js" data-silpi-demo-script data-label="Basic Co"/);
    assert.match(home.body, /name="robots" content="noindex,nofollow"/);
    assert.match(String(home.headers["x-robots-tag"]), /noindex/);

    assert.match((await call("/products/blue-flute/", { cookie })).body, /BASIC BLUE FLUTE/);
    assert.match((await call("/products/nadaswaram-classic", { cookie })).body, /BASIC NADASWARAM/);
    const noSlash = await call("/about", { cookie });
    assert.equal(noSlash.status, 301);
    assert.equal(noSlash.headers.location, "/about/");
    assert.match((await call("/about/", { cookie })).body, /BASIC ABOUT/);

    const css = await call("/assets/site.css", { cookie });
    assert.equal(css.status, 200);
    assert.match(String(css.headers["content-type"]), /text\/css/);
    assert.ok(!css.body.includes("data-silpi-demo"), "only pages get the overlay");

    const missing = await call("/products/nothing/", { cookie });
    assert.equal(missing.status, 404);
    assert.match(missing.body, /BASIC 404/, "the site's own 404 page, still with the demo bar");
    assert.match(missing.body, /overlay\.js/);

    const script = await call("/__demo/overlay.js");
    assert.equal(script.status, 200);
    assert.match(script.body, /DEMO PREVIEW/);
    assert.equal((await call("/", { cookie, method: "HEAD" })).status, 200);
  });

  it("never serves source, secrets or project files, and refuses anything that writes", async () => {
    const m = await mods();
    const p = await projectWithSite("gw-safe", { title: "SAFE", extra: (dist) => { write(dist, ".env", "X=1"); write(dist, "assets/app.js.map", "{}"); write(dist, "package.json", "{}"); } });
    const view = await m.demo.createDemo(p.id, {}, deps());
    const cookie = await open(view.url.split("/").pop()!);
    for (const bad of ["/.env", "/package.json", "/assets/app.js.map", "/../package.json", "/..%2f..%2f.env", "/%2e%2e/.env", "/.silpi/brief.md", "/node_modules/x/index.js", "/src/main.js"]) {
      const r = await call(bad, { cookie });
      assert.ok(r.status === 404 || r.status === 301, `${bad} -> ${r.status}`);
      assert.ok(!r.body.includes("X=1") && !r.body.includes("real-secret-key"), `${bad} leaked`);
    }
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const r = await call("/", { cookie, method });
      assert.equal(r.status, 405, method);
      assert.match(r.body, /switched off/);
      assert.equal(r.headers.allow, "GET, HEAD");
    }
  });

  it("rejects a forged or damaged cookie, a made-up link, and a cookie for nothing", async () => {
    const m = await mods();
    const p = await projectWithSite("gw-forge", { title: "FORGE" });
    const view = await m.demo.createDemo(p.id, {}, deps());
    const token = view.url.split("/").pop()!;
    const cookie = await open(token);
    const value = cookie.split("=")[1];
    const parts = value.split(".");
    assert.equal((await call("/", { cookie: `silpi_demo=${token}.${parts[1]}.${"0".repeat(64)}` })).status, 404, "bad signature");
    assert.equal((await call("/", { cookie: `silpi_demo=${token}.9999999999999.${parts[2]}` })).status, 404, "changed expiry");
    assert.equal((await call("/", { cookie: `silpi_demo=${"a".repeat(60)}.${parts[1]}.${parts[2]}` })).status, 404, "another token");
    assert.equal((await call(`/__demo/${"b".repeat(60)}`)).status, 404, "a made-up link");
    assert.equal((await call("/__demo/short")).status, 404);
    assert.equal((await call("/", { host: `${"c".repeat(60)}.localhost:${port}` })).status, 404, "a made-up host name");
  });

  it("many projects at the same time: each client sees only their own demo, and the team can open them side by side", async () => {
    const m = await mods();
    const a = await projectWithSite("multi-a", { title: "ALPHA" });
    const b = await projectWithSite("multi-b", { title: "BRAVO" });
    const c = await projectWithSite("multi-c", { title: "CHARLIE" });
    const [va, vb, vc] = [await m.demo.createDemo(a.id, {}, deps()), await m.demo.createDemo(b.id, {}, deps()), await m.demo.createDemo(c.id, {}, deps())];
    const [ca, cb, cc] = [await open(va.url.split("/").pop()!), await open(vb.url.split("/").pop()!), await open(vc.url.split("/").pop()!)];

    // The same paths, at the same moment, from three clients: three different websites.
    const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => call(i % 2 ? "/products/blue-flute/" : "/", { cookie: [ca, cb, cc][i % 3] })));
    const names = ["ALPHA", "BRAVO", "CHARLIE"];
    replies.forEach((r, i) => {
      assert.equal(r.status, 200);
      assert.ok(r.body.includes(names[i % 3]), `reply ${i} should be ${names[i % 3]}`);
      for (const other of names.filter((n) => n !== names[i % 3])) assert.ok(!r.body.includes(other), `reply ${i} leaked ${other}`);
    });

    // The team: separate tabs by host name, no cookie needed, while the clients keep their own sessions.
    const hostB = await call("/", { host: `${vb.previewUrl.slice(7).split("/")[0]}` });
    assert.match(hostB.body, /BRAVO HOME/);
    const hostC = await call("/products/nadaswaram-classic", { host: vc.previewUrl.slice(7).split("/")[0] });
    assert.match(hostC.body, /CHARLIE NADASWARAM/);
    assert.match((await call("/", { cookie: ca })).body, /ALPHA HOME/);
    assert.equal(m.dstore.listLiveDemos().length >= 3, true);
    assert.ok(m.demo.liveDemos().some((d) => d.id === va.id) && m.demo.liveDemos().some((d) => d.id === vc.id), "all of them are listed together");
  });

  it("stopping one demo ends only that demo and deletes its copy", async () => {
    const m = await mods();
    const a = await projectWithSite("stop-a", { title: "STOPA" });
    const b = await projectWithSite("stop-b", { title: "STOPB" });
    const va = await m.demo.createDemo(a.id, {}, deps());
    const vb = await m.demo.createDemo(b.id, {}, deps());
    const ca = await open(va.url.split("/").pop()!);
    const cb = await open(vb.url.split("/").pop()!);
    const stopped = m.demo.stopDemo(va.id);
    assert.equal(stopped.status, "stopped");
    const ended = await call("/", { cookie: ca });
    assert.equal(ended.status, 410);
    assert.match(ended.body, /This demo has ended/);
    assert.equal((await call(`/__demo/${va.url.split("/").pop()}`)).status, 410);
    assert.match((await call("/", { cookie: cb })).body, /STOPB HOME/, "the other demo is untouched");
    assert.ok(!existsSync(path.join(process.env.SILPI_DEMOS_DIR!, va.id, "site")), "the copy is deleted");
  });

  it("an expired demo ends by itself", async () => {
    const m = await mods();
    const p = await projectWithSite("expire", { title: "EXP" });
    const view = await m.demo.createDemo(p.id, { days: 1 }, deps());
    const cookie = await open(view.url.split("/").pop()!);
    assert.equal((await call("/", { cookie })).status, 200);
    m.db.getDb().prepare("UPDATE demo_links SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), view.id);
    assert.equal((await call("/", { cookie })).status, 410);
    assert.ok(m.dstore.purgeEnded().includes(view.id));
    assert.ok(!existsSync(path.join(process.env.SILPI_DEMOS_DIR!, view.id)));
  });

  it("a password-protected demo needs the password, limits guesses, and is not opened by the link alone", async () => {
    const m = await mods();
    const p = await projectWithSite("secret-demo", { title: "SECRETSITE" });
    const view = await m.demo.createDemo(p.id, { password: "open-sesame" }, deps());
    assert.equal(view.protected, true);
    const token = view.url.split("/").pop()!;

    const form = await call(`/__demo/${token}`);
    assert.equal(form.status, 200);
    assert.match(form.body, /type="password"/);
    assert.ok(!form.body.includes("SECRETSITE HOME"));
    assert.equal(m.dstore.getDemo(view.id)!.views, 0, "looking at the password page is not a view");
    const viaHost = await call("/", { host: `${token}.localhost:${port}` });
    assert.equal(viaHost.status, 401, "the host-name way needs the password too");
    assert.ok(!viaHost.body.includes("SECRETSITE HOME"));

    const wrong = await call("/__demo/unlock", { method: "POST", body: `token=${token}&password=nope` });
    assert.equal(wrong.status, 401);
    assert.match(wrong.body, /not right/);
    assert.equal(cookieOf(wrong), "");

    const right = await call("/__demo/unlock", { method: "POST", body: `token=${token}&password=open-sesame` });
    assert.equal(right.status, 303);
    const cookie = cookieOf(right);
    assert.match((await call("/", { cookie })).body, /SECRETSITE HOME/);
    assert.equal(m.dstore.getDemo(view.id)!.views, 1);
    assert.ok(!JSON.stringify(m.dstore.getDemo(view.id)).includes("open-sesame"), "the password is stored hashed");

    // Guessing is limited.
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await call("/__demo/unlock", { method: "POST", body: `token=${token}&password=guess${i}` })).status;
    assert.equal(last, 429);
  });

  it("a password page cannot be used to learn anything about other demos", async () => {
    assert.equal((await call("/__demo/unlock", { method: "GET" })).status, 405);
    assert.equal((await call("/__demo/unlock", { method: "POST", body: `token=${"d".repeat(60)}&password=x` })).status, 404);
    assert.equal((await call("/__demo/unlock", { method: "POST", body: "x".repeat(10000) })).status, 413);
  });
});

describe("sites that need a running server", () => {
  const SERVER = `
const http = require("http");
const port = Number(process.env.PORT);
http.createServer((req, res) => {
  const base = { "Set-Cookie": "sid=1; Path=/", "Content-Security-Policy": "default-src 'none'" };
  if (req.url === "/") { res.writeHead(200, { ...base, "Content-Type": "text/html" }); return res.end('<html><body><h1>APP HOME</h1><a href="/products/blue-flute">Blue flute</a><a href="/old">Old</a><a href="/products/gone">Gone</a></body></html>'); }
  if (req.url === "/products/blue-flute") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html><body><h1>APP BLUE FLUTE</h1></body></html>"); }
  if (req.url === "/old") { res.writeHead(302, { Location: "http://127.0.0.1:" + port + "/products/blue-flute" }); return res.end(); }
  if (req.url === "/cookie-echo") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("cookie=" + (req.headers.cookie || "")); }
  if (req.url === "/env") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("key=" + (process.env.ANTHROPIC_API_KEY || "none") + ";admin=" + (process.env.SILPI_ADMIN_TOKEN || "none") + ";web3=" + process.env.WEB3FORMS_ACCESS_KEY); }
  if (req.url === "/api.json") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"ok":true}'); }
  res.writeHead(404, { "Content-Type": "text/html" }); res.end("<html><body>APP 404</body></html>");
}).listen(port, "127.0.0.1");
`;
  it("starts the app privately, proxies it, keeps slugs working, and never passes secrets or writes", async () => {
    const m = await mods();
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-never-reach-a-demo-0123456789";
    process.env.SILPI_ADMIN_TOKEN = "admin-should-never-reach-a-demo-0123456789";
    const p = await projectWithSite("app-demo", { title: "APPDIR" });
    rmSync(p.dist, { recursive: true, force: true });
    write(p.dir, "package.json", JSON.stringify({ name: "app-demo", dependencies: { next: "15" }, scripts: { start: "node server.js", build: "x" } }));
    write(p.dir, ".next/BUILD_ID", "x");
    write(p.dir, "server.js", SERVER);

    const view = await m.demo.createDemo(p.id, { label: "App Client" }, deps());
    assert.equal(view.mode, "app");
    assert.equal(view.framework, "Next.js");
    assert.deepEqual(view.report.broken.map((b) => b.path), ["/products/gone"], "the link check works on a running app too");
    assert.match(view.report.warnings.join(" "), /cannot be scanned/);

    const cookie = await open(view.url.split("/").pop()!);
    const home = await call("/", { cookie });
    assert.match(home.body, /APP HOME/);
    assert.match(home.body, /overlay\.js/);
    assert.equal(home.headers["set-cookie"], undefined, "the app cannot set cookies on the demo address");
    assert.equal(home.headers["content-security-policy"], undefined, "so the demo bar can load");
    assert.match((await call("/products/blue-flute", { cookie })).body, /APP BLUE FLUTE/);

    const redirect = await call("/old", { cookie });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, "/products/blue-flute", "redirects stay on the demo address");

    assert.equal((await call("/cookie-echo", { cookie: `${cookie}; theme=dark` })).body, "cookie=theme=dark", "the demo cookie is not passed on");
    const env = await call("/env", { cookie });
    assert.equal(env.body, "key=none;admin=none;web3=demo-disabled", "SILPI's own secrets never reach the app");
    const json = await call("/api.json", { cookie });
    assert.equal(json.body, '{"ok":true}');
    assert.ok(!json.body.includes("overlay"), "only pages get the demo bar");
    assert.equal((await call("/nothing", { cookie })).status, 404);
    assert.equal((await call("/", { cookie, method: "POST" })).status, 405);

    // Stopping the demo stops the app.
    assert.ok(m.runner.runningAppIds().includes(view.id), "the app is running while the demo is live");
    m.demo.stopDemo(view.id);
    assert.ok(!m.runner.runningAppIds().includes(view.id), "the app was stopped");
    assert.equal((await call("/", { cookie })).status, 410);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.SILPI_ADMIN_TOKEN;
  });

  it("an app that cannot start is reported clearly and leaves no demo", async () => {
    const m = await mods();
    const p = await projectWithSite("app-broken", { title: "BROKENAPP" });
    rmSync(p.dist, { recursive: true, force: true });
    write(p.dir, "package.json", JSON.stringify({ dependencies: { next: "15" }, scripts: { start: "node nothing-here.js" } }));
    write(p.dir, ".next/BUILD_ID", "x");
    await assert.rejects(() => m.demo.createDemo(p.id, {}, deps()), /app could not be started/);
    assert.deepEqual(m.dstore.listDemosForLead(p.id), []);
    assert.deepEqual(m.runner.runningAppIds(), [], "nothing is left running");
  });
});

describe("the public address and clean-up", () => {
  it("the public address is saved only as a safe origin", async () => {
    const m = await mods();
    assert.equal(m.dstore.setPublicBase("https://my-demo.trycloudflare.com/some/path?x=1"), "https://my-demo.trycloudflare.com");
    assert.match(m.dstore.publicBase(), /^https:\/\/my-demo\.trycloudflare\.com$/);
    for (const bad of ["http://example.com", "ftp://x.com", "javascript:alert(1)", "not a url", "https://user:pw@x.com"]) assert.throws(() => m.dstore.setPublicBase(bad), Error, bad);
    assert.equal(m.dstore.setPublicBase("http://localhost:4100"), "http://localhost:4100");
    assert.equal(m.dstore.setPublicBase(""), "");
    assert.match(m.dstore.publicBase(), /^http:\/\/localhost:\d+$/);
    assert.equal(m.dstore.isLocalBase(m.dstore.publicBase()), true);
  });

  it("deleting a lead removes its demo copies", async () => {
    const m = await mods();
    const p = await projectWithSite("cleanup", { title: "CLEAN" });
    const view = await m.demo.createDemo(p.id, {}, deps());
    const copy = path.join(process.env.SILPI_DEMOS_DIR!, view.id);
    assert.ok(existsSync(copy));
    m.dstore.purgeLeadDemos(p.id);
    assert.ok(!existsSync(copy));
  });

  it("the client sees a demo only while it is live and marked to show", async () => {
    const m = await mods();
    const p = await projectWithSite("client-visible", { title: "CV" });
    const hidden = await m.demo.createDemo(p.id, { showToClient: false }, deps());
    assert.equal(m.dstore.clientDemoFor(p.id), null, "not shown unless chosen");
    const shown = await m.demo.createDemo(p.id, { showToClient: true }, deps());
    assert.equal(m.dstore.clientDemoFor(p.id)?.id, shown.id);
    m.demo.stopDemo(shown.id);
    assert.equal(m.dstore.clientDemoFor(p.id), null);
    assert.ok(hidden.id);
  });
});

// The studio is for administrators only: enforced on the server for every page and every business API, whatever the address or host, with no public link to the administrator areas.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { safeNext } from "@/lib/safe-next";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-studio-"));
const TOKEN = "studio-test-token-0123456789abcdef";
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const mods = async () => ({ mw: await import("@/middleware"), auth: await import("@/lib/admin-auth"), acc: await import("@/server/admin-accounts") });
const req = (url: string, init: { headers?: Record<string, string>; cookie?: string; method?: string } = {}) =>
  new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers: { host: "localhost:3000", ...(init.headers ?? {}), ...(init.cookie ? { cookie: init.cookie } : {}) } });
const passes = (r: Response) => r.headers.get("x-middleware-next") === "1";

before(() => {
  process.env.SILPI_DB_PATH = path.join(dir, "studio.db");
  process.env.SILPI_ADMIN_TOKEN = TOKEN;
});
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("1. where a sign-in returns to", () => {
  it("accepts an ordinary path on this site and nothing else", () => {
    assert.equal(safeNext("/clients/abc?tab=costs#top"), "/clients/abc?tab=costs#top");
    assert.equal(safeNext("/"), "/");
    for (const bad of ["https://evil.example/x", "//evil.example", "/\\evil.example", "javascript:alert(1)", "clients", "", null, undefined, "/a\nb", "/a\u0000b", "/" + "a".repeat(600)]) assert.equal(safeNext(bad as string), "/", String(bad).slice(0, 30));
    assert.equal(safeNext("//evil.example", "/home"), "/home", "the fallback is the caller's");
  });
});

describe("2. the studio pages", () => {
  it("send anyone who is not signed in as an administrator to the sign-in page, remembering where they were going, on localhost too", async () => {
    const { mw } = await mods();
    for (const p of ["/", "/clients", "/clients/quote", "/clients/abc123", "/projects", "/existing", "/activity", "/pricing", "/plans", "/settings", "/recurring-income"]) {
      const res = mw.middleware(req(p));
      assert.equal(res.status, 307, p);
      const to = new URL(res.headers.get("location")!);
      assert.equal(to.pathname, "/admin/sign-in", p);
      assert.equal(to.searchParams.get("next"), p, p);
    }
    const query = mw.middleware(req("/clients/abc?tab=costs"));
    assert.equal(new URL(query.headers.get("location")!).searchParams.get("next"), "/clients/abc?tab=costs");
  });
  it("are not opened by a host, a forwarding header or a proxy header: the old rule that opened localhost is gone", async () => {
    const { mw } = await mods();
    for (const headers of [{ "x-forwarded-for": "127.0.0.1" } as Record<string, string>, { host: "127.0.0.1:3000" }, { host: "[::1]:3000" }, { "x-real-ip": "127.0.0.1" }]) assert.equal(mw.middleware(req("/", { headers })).status, 307, JSON.stringify(headers));
  });
  it("open for a signed-in administrator, and for a viewer (who can look), and not for a forged or expired cookie", async () => {
    const { mw, auth, acc } = await mods();
    const token = auth.createSession();
    assert.ok(passes(mw.middleware(req("/clients", { cookie: `${auth.ADMIN_COOKIE}=${token.value}` }))));
    const viewer = await acc.createAdminAccount({ email: "viewer@studio.example", name: "Viewer", password: "a-correct-horse-battery", role: "viewer" });
    const vs = auth.createSession(Date.now(), viewer.id);
    assert.ok(passes(mw.middleware(req("/pricing", { cookie: `${auth.ADMIN_COOKIE}=${vs.value}` }))));
    const parts = token.value.split(".");
    for (const bad of [`${auth.ADMIN_COOKIE}=${parts[0]}.${parts[1]}.${"0".repeat(parts[2]!.length)}`, `${auth.ADMIN_COOKIE}=garbage`, `${auth.ADMIN_COOKIE}=${auth.createSession(Date.now() - 365 * 86_400_000).value}`]) assert.equal(mw.middleware(req("/", { cookie: bad })).status, 307, bad.slice(0, 40));
    // a disabled account is noticed at once
    await acc.updateAdminAccount(viewer.id, { status: "disabled" });
    assert.equal(mw.middleware(req("/pricing", { cookie: `${auth.ADMIN_COOKIE}=${vs.value}` })).status, 307);
  });
});

describe("3. the business APIs", () => {
  it("answer 401 without an administrator, on localhost too, and pass with the token or a session", async () => {
    const { mw, auth } = await mods();
    for (const p of ["/api/business/leads", "/api/business/recurring-income", "/api/business/rate-card", "/api/business/anything-added-later", "/api/projects", "/api/projects/x"]) {
      assert.equal(mw.middleware(req(p)).status, 401, p);
      assert.equal(mw.middleware(req(p, { headers: { authorization: "Bearer wrong-token-0000000000" } })).status, 401, p);
      assert.ok(passes(mw.middleware(req(p, { headers: { authorization: `Bearer ${TOKEN}` } }))), p);
      assert.ok(passes(mw.middleware(req(p, { cookie: `${auth.ADMIN_COOKIE}=${auth.createSession().value}` }))), p);
    }
  });
  it("a viewer may read but not change", async () => {
    const { mw, auth, acc } = await mods();
    const viewer = await acc.createAdminAccount({ email: "viewer2@studio.example", name: "Viewer", password: "a-correct-horse-battery", role: "viewer" });
    const cookie = `${auth.ADMIN_COOKIE}=${auth.createSession(Date.now(), viewer.id).value}`;
    assert.ok(passes(mw.middleware(req("/api/business/leads", { cookie }))));
    const write = mw.middleware(new NextRequest("http://localhost:3000/api/business/leads", { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", cookie } }));
    assert.equal(write.status, 403);
  });
  it("closed with a clear message while no administrator token is set", async () => {
    const { mw } = await mods();
    const keep = process.env.SILPI_ADMIN_TOKEN;
    delete process.env.SILPI_ADMIN_TOKEN;
    try {
      assert.equal(mw.middleware(req("/api/business/leads")).status, 503);
      assert.equal(mw.middleware(req("/")).status, 307, "the page still goes to the sign-in page, which explains the setup");
    } finally { process.env.SILPI_ADMIN_TOKEN = keep; }
  });
});

describe("4. nothing is left outside the guard, and nothing public is caught by it", () => {
  it("every studio page route is covered by the matcher, so a page added later cannot be forgotten", async () => {
    const { mw } = await mods();
    const root = path.join(process.cwd(), "src/app/(app)");
    const pages: string[] = [];
    const walk = (d: string, base: string) => {
      for (const name of readdirSync(d)) {
        const p = path.join(d, name);
        if (statSync(p).isDirectory()) walk(p, `${base}/${name}`);
        else if (name === "page.tsx") pages.push(base === "" ? "/" : base);
      }
    };
    walk(root, "");
    assert.ok(pages.length >= 9, pages.join(","));
    const covered = (route: string) => mw.config.matcher.some((m) => m === route || (m.endsWith("/:path*") && (route === m.slice(0, -7) || route.startsWith(m.slice(0, -6)))) || (route.includes("[") && m.endsWith("/:path*") && route.startsWith(m.slice(0, -6))));
    const uncovered = pages.filter((p) => !covered(p));
    assert.deepEqual(uncovered, [], "these (app) pages would be open");
  });
  it("the client's own quotation link, the customer areas and the sign-in pages are not matched", async () => {
    const { mw } = await mods();
    for (const m of mw.config.matcher) for (const open of ["/q", "/ai", "/api/client", "/api/workspace", "/api/auth", "/api/admin", "/login", "/admin"]) assert.ok(!(m === open || m.startsWith(`${open}/`)), `${m} would catch ${open}`);
  });
});

describe("5. recurring income is for administrators only", () => {
  it("is not on the Overview, has its own studio page behind the guard, and its API checks the administrator itself", async () => {
    assert.ok(!/RecurringIncomeCard|recurring-income-card/.test(read("src/components/studio/dashboard.tsx")), "the Overview does not show it");
    assert.match(read("src/app/(app)/recurring-income/page.tsx"), /RecurringIncomeCard/);
    const { mw } = await mods();
    assert.ok(mw.config.matcher.includes("/recurring-income"));
    const route = await import("@/app/api/business/recurring-income/route");
    assert.equal((await route.GET(req("/api/business/recurring-income"))).status, 401, "no administrator, no figures");
    const ok = await route.GET(req("/api/business/recurring-income", { headers: { authorization: `Bearer ${TOKEN}` } }));
    assert.equal(ok.status, 200);
  });
});

describe("6. no public page links to an administrator area", () => {
  it("the customer header and the public landing page have no Admin link, and nothing sends a customer to the studio", () => {
    for (const f of ["src/components/ai/ai-shell.tsx", "src/components/ai/landing.tsx"]) {
      const text = read(f);
      assert.ok(!/href=["']\/ai\/admin/.test(text) && !/href:\s*["']\/ai\/admin/.test(text), `${f} links to the administrator console`);
      assert.ok(!/>\s*Admin(istrator)?\s*</.test(text), `${f} shows an Admin label`);
    }
    assert.ok(!/href="\/"[^>]*>[^<]*Workspace/.test(read("src/components/ai/ai-shell.tsx")), "the customer header does not send customers to the studio");
  });
  it("administrators reach the console from the studio, and the studio from the console", () => {
    assert.match(read("src/components/layout/studio-shell.tsx"), /href="\/ai\/admin"/);
    assert.match(read("src/components/ai/admin-dashboard.tsx"), /Open the studio/);
  });
  it("the sign-in page exists, is not indexed, and returns only to this site", () => {
    const page = read("src/app/admin/sign-in/page.tsx");
    assert.match(page, /index: false/);
    assert.match(read("src/components/ai/admin-sign-in-screen.tsx"), /readEntry\(params, "silpi:admin-next", "\/"\)/);
  });
});

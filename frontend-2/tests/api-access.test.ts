import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { forwardedFromThisComputer, hostnameOf, localAccessAllowed } from "@/lib/api-access";

const direct = (host: string, env = {}) => localAccessAllowed({ host, forwardedFor: "::1", env });

describe("when the business APIs are open without sign-in", () => {
  it("opens for a dev server used as localhost (today's behaviour is kept)", () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "LOCALHOST"]) assert.equal(direct(host, { NODE_ENV: "development" }), true, host);
  });
  it("closes for any other host, so a LAN or public address needs sign-in", () => {
    for (const host of ["192.168.1.20:3000", "silpi.example.com", "localhost.evil.com", "evil.com:3000", "", null, undefined]) assert.equal(localAccessAllowed({ host, forwardedFor: "::1", env: { NODE_ENV: "development" } }), false, String(host));
  });
  it("closes when the connection did not come from this computer, even if the Host says localhost", () => {
    const env = { NODE_ENV: "development" };
    for (const ff of ["192.168.1.20", "8.8.8.8", "::1, 8.8.8.8", "8.8.8.8, 127.0.0.1", "garbage"]) assert.equal(localAccessAllowed({ host: "localhost:3000", forwardedFor: ff, env }), false, ff);
    assert.equal(localAccessAllowed({ host: "localhost:3000", forwardedFor: "::1", proxyHeader: true, env }), false, "a proxy-only header");
  });
  it("accepts every loopback spelling, and an absent header", () => {
    for (const ff of ["::1", "127.0.0.1", "::ffff:127.0.0.1", " 127.0.0.1 , ::1", undefined, null, ""]) assert.equal(forwardedFromThisComputer(ff), true, String(ff));
  });
  it("SILPI_API_AUTH=required closes it everywhere", () => {
    assert.equal(direct("localhost:3000", { SILPI_API_AUTH: "required" }), false);
  });
  it("a production build is closed unless SILPI_API_AUTH=local is set on purpose", () => {
    assert.equal(direct("localhost:3000", { NODE_ENV: "production" }), false);
    assert.equal(direct("localhost:3000", { NODE_ENV: "production", SILPI_API_AUTH: "local" }), true);
    assert.equal(direct("silpi.example.com", { NODE_ENV: "production", SILPI_API_AUTH: "local" }), false, "local never opens a non-local host");
  });
  it("reads the host name out of host:port forms", () => {
    assert.deepEqual(["localhost:3000", "[::1]:3000", "a.b:1", ""].map(hostnameOf), ["localhost", "[::1]", "a.b", ""]);
  });
});

// ---- Guard: a new API route cannot be added ungated -----------------------------------------------------------
const API = path.resolve("src/app/api");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const rel = (f: string) => path.relative(API, f).replace(/\\/g, "/");
const routes = walk(API).filter((f) => f.endsWith("route.ts"));

describe("every API route is gated one way or another", () => {
  it("the middleware covers all of /api/business and /api/projects", () => {
    const mw = readFileSync(path.resolve("src/middleware.ts"), "utf8");
    for (const m of ["/api/business/:path*", "/api/projects", "/api/projects/:path*"]) assert.ok(mw.includes(`"${m}"`), m);
    assert.ok(/requireAdmin\(request\)/.test(mw));
  });
  it("no business route weakens the gate by importing the local-open rule itself", () => {
    for (const f of routes.filter((r) => rel(r).startsWith("business/"))) assert.ok(!/api-access/.test(readFileSync(f, "utf8")), rel(f));
  });
  it("every route outside the middleware is the login, a secret-link client route, or checks the admin itself", () => {
    const known = new Set(["admin", "auth", "business", "client", "demo", "execution", "projects", "workspace"]);
    for (const f of routes) {
      const group = rel(f).split("/")[0];
      assert.ok(known.has(group), `${rel(f)}: a new API group needs a decision about who may call it (add it to this test only after deciding)`);
      if (group === "business" || group === "projects" || group === "client" || rel(f) === "admin/session/route.ts") continue;
      // Signed-in user routes: login is the public door; logout only ends the caller's own session; the rest need a session.
      if (group === "auth" && ["auth/login/route.ts", "auth/logout/route.ts"].includes(rel(f))) continue;
      if (group === "auth" || group === "workspace") {
        assert.ok(/requireSession\(/.test(readFileSync(f, "utf8")), `${rel(f)} does not require a signed-in user`);
        continue;
      }
      const code = readFileSync(f, "utf8");
      assert.ok(/requireAdmin\(|requireAdminOrDevStart\(|directApiBlocked\(/.test(code), `${rel(f)} is not admin-gated`);
    }
  });
});

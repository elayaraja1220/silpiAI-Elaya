// The client's way in: Get Your Quotation -> sign in -> /clients/new -> choose Fixed Price or SaaS. Fixed price keeps the studio's own quotation form apart.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-client-entry-"));
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const passes = (r: Response) => r.headers.get("x-middleware-next") === "1";
const req = (url: string) => new NextRequest(`http://localhost:3000${url}`, { headers: { host: "localhost:3000" } });
const mods = async () => ({ mw: await import("@/middleware"), acc: await import("@/server/client-accounts"), subs: await import("@/server/subscriptions"), saas: await import("@/server/saas-entry"), page: await import("@/server/model-choice"), db: await import("@/lib/business/db"), ca: await import("@/lib/client-auth") });

before(() => {
  process.env.SILPI_DB_PATH = path.join(dir, "entry.db");
  process.env.SILPI_ADMIN_TOKEN = "client-entry-test-token-0123456789";
});
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("1. what is the client's and what is the studio's", () => {
  it("/clients/new and what is below it are the client's; every other /clients page, and the studio's own quotation form, still need an administrator", async () => {
    const { mw } = await mods();
    for (const p of ["/clients/new", "/clients/new/saas", "/clients/new/fixed-price"]) assert.ok(passes(mw.middleware(req(p))), p);
    for (const p of ["/clients", "/clients/quote", "/clients/abc123", "/clients/newer", "/clients/newsletter", "/clients/new-lead"]) assert.equal(mw.middleware(req(p)).status, 307, p);
  });
  it("the studio's quotation form moved to /clients/quote, and nothing in the studio still points at /clients/new", () => {
    assert.ok(existsSync(path.join(process.cwd(), "src/app/(app)/clients/quote/page.tsx")));
    assert.ok(!existsSync(path.join(process.cwd(), "src/app/(app)/clients/new")), "the old studio page is gone, so it cannot take the chooser's address");
    for (const f of ["src/components/layout/app-shell.tsx", "src/components/pages/clients.tsx", "src/components/pages/dashboard.tsx"]) assert.ok(!/["']\/clients\/new["']/.test(read(f)), f);
    assert.match(read("src/components/layout/app-shell.tsx"), /href="\/clients\/quote"/);
    assert.match(read("src/lib/routes.ts"), /pathname === "\/clients\/quote"/);
  });
  it("the client pages live in their own frame, not the studio's", () => {
    assert.ok(existsSync(path.join(process.cwd(), "src/app/(client)/layout.tsx")));
    assert.match(read("src/app/(client)/layout.tsx"), /ClientShell/);
    assert.ok(!/AppShell/.test(read("src/app/(client)/layout.tsx")));
    for (const p of ["clients/new/page.tsx", "clients/new/saas/page.tsx", "clients/new/fixed-price/page.tsx"]) assert.match(read(`src/app/(client)/${p}`), /requireClient\(/, p);
  });
});

describe("2. the choice page", () => {
  const s = () => read("src/components/client/model-chooser.tsx");
  it("says what the brief says: heading, description, two cards, their titles and their buttons", () => {
    const t = s();
    for (const text of ["What would you like to build with SILPI AI?", "Choose your development model. Whether you need a fully customized project with a fixed budget or an AI-powered application development subscription, SILPI AI provides the right solution.", "Fixed Price Project", "SILPI AI SaaS", "Choose Fixed Price", "Start with SILPI AI",
      "Get your complete project designed and developed with a predefined budget, approved requirements, and agreed project scope.", "Build applications using our AI-powered development platform through a flexible subscription-based model."]) assert.ok(t.includes(text), text);
  });
  it("lists every feature of both options", () => {
    const t = s();
    for (const f of ["Custom project development", "Requirement analysis", "Project quotation", "Technology selection", "Fixed project budget", "Milestone-based development", "Advance payment", "Project tracking", "Private demo preview", "Final project delivery"]) assert.ok(t.includes(f), f);
    for (const f of ["AI-powered application development", "AI agent workspace", "Automated project generation", "Monthly subscription", "Yearly subscription", "Credit-based AI usage", "Project management", "Development preview", "AI-powered development tools"]) assert.ok(t.includes(f), f);
  });
  it("the two buttons lead to two different journeys, and the cards are visually distinct", () => {
    const t = s();
    assert.match(t, /href="\/clients\/new\/fixed-price"/);
    assert.match(t, /href="\/clients\/new\/saas"/);
    assert.match(t, /tone="violet"/);
    assert.match(t, /tone="emerald"/);
    assert.match(t, /lg:grid-cols-2/, "side by side on a wide screen, stacked on a narrow one");
  });
  it("every link in the client frame goes to a client page: none to an administrator area or to the studio", () => {
    const shell = read("src/components/client/client-shell.tsx");
    const hrefs = [...shell.matchAll(/href(?:=|:\s*)\{?"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(hrefs.length >= 3, hrefs.join(","));
    for (const h of hrefs) assert.ok(["/clients/new", "/ai/builder", "/ai/billing"].includes(h!), `unexpected link ${h}`);
    assert.ok(!/\/ai\/admin|recurring|\/clients\/quote/i.test(shell));
  });
});

describe("3. Start with SILPI AI", () => {
  it("goes to the AI workspace when the organization has a plan, and to the plans (carrying on to the workspace afterwards) when it has none", async () => {
    const { acc, subs, saas } = await mods();
    const { organization } = await acc.signUp({ name: "Sara Saas", email: "sara@example.com", password: "a-correct-horse-battery", acceptTerms: true });
    assert.equal(saas.saasDestination(organization.id), "/ai/billing?then=%2Fai%2Fbuilder");
    subs.startSubscription({ orgId: organization.id, planId: "free" });
    assert.equal(saas.saasDestination(organization.id), "/ai/builder");
  });
  it("the plans page carries on to the workspace after a plan that is active at once, and never to another site", () => {
    const b = read("src/components/ai/billing.tsx");
    assert.match(b, /safeNext\(new URLSearchParams\(window\.location\.search\)\.get\("then"\), ""\)/);
    assert.match(b, /if \(then && !inv && r\.result\.kind !== "scheduled"\) \{ window\.location\.assign\(then\)/);
  });
});

describe("4. remembering the choice", () => {
  it("each choice is a record with who, which workspace and when, and a record cannot be edited", async () => {
    const { acc, db, page } = await mods();
    const { user, organization } = await acc.signUp({ name: "Fixed Fred", email: "fred@example.com", password: "a-correct-horse-battery", acceptTerms: true });
    const session = { user: { id: user.id, email: user.email, name: user.name }, orgId: organization.id, role: "owner" as const };
    page.recordModelChoice(session, "fixed_price");
    page.recordModelChoice(session, "saas");
    const rows = db.getDb().prepare("SELECT model, org_id AS orgId, chosen_at AS at FROM model_selections WHERE user_id = ? ORDER BY id").all(user.id) as { model: string; orgId: string; at: string }[];
    assert.deepEqual(rows.map((r) => [r.model, r.orgId]), [["fixed_price", organization.id], ["saas", organization.id]]);
    assert.match(rows[0]!.at, /^\d{4}-\d\d-\d\dT/);
    assert.throws(() => db.getDb().prepare("UPDATE model_selections SET model = 'saas' WHERE user_id = ?").run(user.id), /append-only/);
    assert.throws(() => db.getDb().prepare("INSERT INTO model_selections (user_id, org_id, model, chosen_at) VALUES (?, ?, 'other', 'x')").run(user.id, organization.id), /CHECK/i);
  });
});

describe("5. getting there from the front page", () => {
  it("a signed-out client who is sent to sign in comes back to /clients/new, and a client with no destination goes there", async () => {
    const { ca } = await mods();
    assert.equal(ca.CLIENT_HOME, "/clients/new");
    assert.match(read("src/server/client-page.ts"), /redirect\(`\/sign-in\?next=\$\{encodeURIComponent\(next\)\}`\)/);
    assert.match(read("src/app/(client)/clients/new/page.tsx"), /requireClient\("\/clients\/new"\)/);
  });
  it("the public front page has a Get your quotation entry that goes through sign-in, and its Sign in and Get started use the one client sign-in page", () => {
    const l = read("src/components/ai/landing.tsx");
    assert.match(l, /href="\/clients\/new"[^>]*>Get your quotation/);
    assert.match(l, /href="\/sign-in\?mode=signup"/);
    assert.match(l, /href="\/sign-in\?next=%2Fai"/);
    assert.ok(!/href="\/ai\/sign-in"/.test(l), "no link to the old separate sign-in");
  });
  it("the fixed-price page records the choice and opens the client form", () => {
    const p = read("src/app/(client)/clients/new/fixed-price/page.tsx");
    assert.match(p, /recordModelChoice\(session, "fixed_price"\)/);
    assert.match(p, /ClientFixedPrice/);
  });
});

// Suggesting how a quotation's hours are shared between roles: always adds up to the quotation's own hours, falls back to a plain rule, and never touches a price.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { digestOf } from "@/lib/business/approvals";
import { normaliseSplit, parseSplitAnswer, ruleSplit, splitPrompt, SPLIT_ROLES } from "@/lib/business/hour-split";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import type { Client, Quotation, Requirement } from "@/lib/business/types";
import { parseClient, parseRequirement } from "@/lib/business/validate";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-hour-split-"));
const mods = async () => ({ s: await import("@/lib/business/store"), h: await import("@/server/hour-split"), db: await import("@/lib/business/db") });
const fails = async (fn: () => unknown, pattern: RegExp) => { try { await fn(); } catch (e) { assert.match((e as Error).message, pattern); return; } assert.fail(`expected an error matching ${pattern}`); };
const sum = (lines: { hours: number }[]) => lines.reduce((a, l) => a + l.hours, 0);
const base = { name: "Client", email: "c@example.com", phone: "+91 98765 43210", company: "", gstin: "", address: "", state: "Tamil Nadu" };
const client = (): Client => parseClient(base);
const SIX = ["Home", "About Us", "Services", "Products / Portfolio", "Gallery", "Contact Us"];
const site = (over: Record<string, unknown> = {}): Requirement => parseRequirement({ title: "Shop site", summary: "A website for a small shop with six pages.", scope: "full", projectType: "business-website", pages: SIX, modules: ["contact-form"], design: "ai", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 }, hosting: { needed: false, choice: "self", plan: "static", years: 1 }, ...over }, DEFAULT_RATE_CARD);
const retainer = (): Requirement => parseRequirement({ title: "Retainer", summary: "A senior developer for a month on the shop front end.", scope: "full", projectType: "business-website", complexity: "standard", pages: [], modules: [], design: "ai", billing: "hourly", hourly: { role: "Full-stack developer", rate: 1000, estimatedHours: 40, rangePct: 20, cycle: "monthly" } }, DEFAULT_RATE_CARD);
const aiSays = (json: unknown, model = "test-model") => async () => ({ text: typeof json === "string" ? json : JSON.stringify(json), model, inputTokens: 120, outputTokens: 80 });

before(() => { process.env.SILPI_DB_PATH = path.join(dir, "hs.db"); });
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("1. making any proposal add up", () => {
  it("always adds up to exactly the total, in half hours, whatever the proposal says", () => {
    for (const total of [1, 7.5, 10, 33, 41.5, 120, 999.5]) {
      for (const proposal of [[{ roleId: "frontend", hours: 5 }, { roleId: "backend", hours: 3 }, { roleId: "qa", hours: 1 }], [{ roleId: "frontend", hours: 1 }, { roleId: "qa", hours: 1 }, { roleId: "ui-ux", hours: 1 }], [{ roleId: "frontend", hours: 1_000_000 }, { roleId: "qa", hours: 3 }]]) {
        const lines = normaliseSplit(proposal, total)!;
        assert.equal(sum(lines), total, `${total} h`);
        assert.ok(lines.every((l) => l.hours > 0 && Number.isInteger(l.hours * 2)), "positive, whole half hours");
      }
    }
  });
  it("ignores unknown roles, zero, negative and non-numbers; merges the same role listed twice; and gives nothing when nothing is usable", () => {
    const lines = normaliseSplit([{ roleId: "Frontend", hours: 2 }, { roleId: "frontend", hours: 2 }, { roleId: "wizard", hours: 50 }, { roleId: "backend", hours: -3 }, { roleId: "qa", hours: "x" }, { roleId: "qa", hours: NaN }, { roleId: null, hours: 4 }], 10)!;
    assert.deepEqual(lines, [{ roleId: "frontend", hours: 10 }]);
    for (const none of [[], [{ roleId: "wizard", hours: 5 }], [{ roleId: "qa", hours: 0 }]]) assert.equal(normaliseSplit(none, 10), null);
    assert.equal(normaliseSplit([{ roleId: "qa", hours: 1 }], 0), null, "no hours, no split");
    assert.equal(normaliseSplit([{ roleId: "qa", hours: 1 }], NaN), null);
  });
  it("gives each role its share by size, with the leftover half hours going to the biggest remainders, in a fixed order", () => {
    assert.deepEqual(normaliseSplit([{ roleId: "frontend", hours: 1 }, { roleId: "backend", hours: 1 }, { roleId: "qa", hours: 1 }], 10), [{ roleId: "frontend", hours: 3.5 }, { roleId: "backend", hours: 3.5 }, { roleId: "qa", hours: 3 }]);
    const again = normaliseSplit([{ roleId: "qa", hours: 1 }, { roleId: "backend", hours: 1 }, { roleId: "frontend", hours: 1 }], 10)!;
    assert.deepEqual(again.map((l) => l.roleId), ["frontend", "backend", "qa"], "the order does not depend on how the answer was ordered");
    assert.equal(sum(again), 10);
  });
});

describe("2. reading the AI's answer", () => {
  it("accepts the JSON asked for, even with words around it, and refuses anything else", () => {
    assert.deepEqual(parseSplitAnswer('Here you go: {"split":[{"role":"frontend","hours":6},{"role":"qa","hours":2}],"reason":"Mostly UI work."} Thanks'), { lines: [{ roleId: "frontend", hours: 6 }, { roleId: "qa", hours: 2 }], reason: "Mostly UI work." });
    for (const bad of ["", "no json here", "{broken", '{"split":"x"}', "[1,2]", '{"other":1}']) assert.equal(parseSplitAnswer(bad), null, bad);
  });
});

describe("3. the default rule", () => {
  it("adds up to the total, drops the backend share for a static site, and says it is a rule of thumb", () => {
    const stat = ruleSplit({ projectType: "business-website", modules: [] }, DEFAULT_RATE_CARD, 60)!;
    assert.equal(sum(stat.lines), 60);
    assert.ok(!stat.lines.some((l) => l.roleId === "backend"));
    assert.equal(stat.source, "rule");
    assert.match(stat.reason, /rule of thumb/i);
    const app = ruleSplit({ projectType: "web-app", modules: [] }, DEFAULT_RATE_CARD, 60)!;
    assert.equal(sum(app.lines), 60);
    assert.ok(app.lines.some((l) => l.roleId === "backend"));
    assert.equal(ruleSplit({ projectType: "web-app", modules: [] }, DEFAULT_RATE_CARD, 0), null);
  });
});

describe("4. what the AI is told", () => {
  it("is given the facts and the total, the allowed roles, and no price", async () => {
    const { s } = await mods();
    const q = s.createLead(client(), site()).quotation as Quotation;
    const { system, user } = splitPrompt(q, 55);
    assert.match(user, /Total hours to share: 55/);
    assert.match(user, /Shop site/);
    for (const r of SPLIT_ROLES) assert.ok(system.includes(r), r);
    assert.ok(!/₹|\bINR\b|\brate\b|\bprice\b|grandTotal/i.test(user), "the user part carries no money");
    assert.match(system, /Never mention prices/);
  });
});

describe("5. suggesting for a real quotation", () => {
  it("uses the AI's split, adjusted to add up to the quotation's own hours, and records the model and who asked", async () => {
    const { s, h } = await mods();
    const lead = s.createLead(client(), site());
    const total = lead.quotation!.totalHours;
    const e = await h.suggestSplit(lead.id, "Asha", aiSays({ split: [{ role: "frontend", hours: 999 }, { role: "backend", hours: 1 }, { role: "ui-ux", hours: 100 }, { role: "magician", hours: 5 }], reason: "Design-heavy brochure site." }, "claude-fast"));
    assert.deepEqual([e.source, e.model, e.createdBy, e.status, e.totalHours, e.aiNote, e.inputTokens, e.outputTokens], ["ai", "claude-fast", "Asha", "suggested", total, "", 120, 80]);
    assert.equal(sum(e.lines), total, "the AI cannot add or remove hours");
    assert.ok(e.lines.every((l) => l.roleId !== ("magician" as never)));
    assert.equal(e.reason, "Design-heavy brochure site.");
  });
  it("falls back to the default rule, and says why, when there is no AI, the AI fails, or its answer is not a split", async () => {
    const { s, h } = await mods();
    const lead = s.createLead(client(), site());
    const total = lead.quotation!.totalHours;
    const cases: [string, Parameters<typeof h.suggestSplit>[2], RegExp][] = [
      ["no model configured", async () => ({ unavailable: "No AI model is switched on and configured for this, so the default rule was used." }), /No AI model/],
      ["not json", aiSays("I think frontend mostly."), /could not be used/],
      ["no usable roles", aiSays({ split: [{ role: "wizard", hours: 5 }], reason: "x" }), /could not be used/],
    ];
    for (const [label, ask, note] of cases) {
      const e = await h.suggestSplit(lead.id, "t", ask);
      assert.equal(e.source, label === "no model configured" ? "rule" : "rule", label);
      assert.equal(e.model, "", label);
      assert.match(e.aiNote, note, label);
      assert.equal(sum(e.lines), total, label);
    }
  });
  it("the real asker says so plainly when no model is configured", async () => {
    const { s, h } = await mods();
    const keep = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const lead = s.createLead(client(), site());
      const e = await h.suggestSplit(lead.id, "t");
      assert.equal(e.source, "rule");
      assert.match(e.aiNote, /No AI model|default rule/);
    } finally { if (keep !== undefined) process.env.ANTHROPIC_API_KEY = keep; }
  });
  it("shares an hourly engagement's expected hours", async () => {
    const { s, h } = await mods();
    const lead = s.createLead(client(), retainer());
    const e = await h.suggestSplit(lead.id, "t", aiSays({ split: [{ role: "full-stack", hours: 1 }], reason: "One developer." }));
    assert.equal(e.totalHours, 40);
    assert.deepEqual(e.lines, [{ roleId: "full-stack", hours: 40 }]);
  });
  it("refuses a project with no quotation", async () => {
    const { h } = await mods();
    await fails(() => h.suggestSplit("no-such-lead", "t", aiSays({})), /no quotation/i);
  });
});

describe("6. it never touches the price", () => {
  it("leaves the quotation, its fingerprint, its version list and the project exactly as they were", async () => {
    const { s, h, db } = await mods();
    const lead = s.createLead(client(), site());
    const row = () => db.getDb().prepare("SELECT data FROM quotations WHERE lead_id = ?").all(lead.id) as { data: string }[];
    const before = { digests: row().map((r) => digestOf(r.data)), versions: s.approvalRecord(lead.id).versions.length, total: lead.quotation!.grandTotal, stage: s.getLead(lead.id)!.stage, updated: s.getLead(lead.id)!.updatedAt };
    const e = await h.suggestSplit(lead.id, "t", aiSays({ split: [{ role: "frontend", hours: 1 }], reason: "x" }));
    h.decideSplit(lead.id, e.id, "accepted", "t");
    assert.deepEqual(row().map((r) => digestOf(r.data)), before.digests);
    assert.equal(s.approvalRecord(lead.id).versions.length, before.versions);
    assert.equal(s.getLead(lead.id)!.quotation!.grandTotal, before.total);
    assert.deepEqual([s.getLead(lead.id)!.stage, s.getLead(lead.id)!.updatedAt], [before.stage, before.updated]);
  });
  it("works on an approved quotation too, which stays locked", async () => {
    const { s, h } = await mods();
    const lead = s.createLead(client(), site());
    s.setStage(lead.id, "approved", "ok");
    const e = await h.suggestSplit(lead.id, "t", aiSays({ split: [{ role: "frontend", hours: 1 }, { role: "qa", hours: 1 }], reason: "x" }));
    assert.equal(e.status, "suggested");
    assert.equal(s.approvalRecord(lead.id).approvals[0]!.intact, true);
  });
  it("no pricing or quotation code reads a split", () => {
    const root = path.join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = path.join(d, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const rel = path.relative(root, p).split(path.sep).join("/");
        if (/hour-split|hour-split\.tsx?$/.test(rel) || rel.startsWith("app/api/business/leads/[id]/hour-split")) continue;
        if (/hour-split|quotation_hour_estimates/.test(readFileSync(p, "utf8")) && !/migrations\.ts$|components\/business\/hour-split-card\.tsx$|components\/pages\/clients\.tsx$/.test(rel)) offenders.push(rel);
      }
    };
    walk(root);
    assert.deepEqual(offenders, [], "only the split's own files, its card, the project page that shows the card and the migration mention it");
  });
});

describe("7. deciding on a suggestion", () => {
  it("accepting or dismissing is recorded with who and when, once; the split itself cannot be edited", async () => {
    const { s, h, db } = await mods();
    const lead = s.createLead(client(), site());
    const e = await h.suggestSplit(lead.id, "t", aiSays({ split: [{ role: "frontend", hours: 1 }], reason: "x" }));
    const done = h.decideSplit(lead.id, e.id, "accepted", "Asha");
    assert.deepEqual([done.status, done.decidedBy], ["accepted", "Asha"]);
    assert.match(done.decidedAt, /^\d{4}-\d\d-\d\dT/);
    await fails(() => h.decideSplit(lead.id, e.id, "dismissed", "Asha"), /already accepted/);
    await fails(() => h.decideSplit(lead.id, 99_999, "accepted", "Asha"), /does not exist/);
    await fails(() => h.decideSplit("another-lead", e.id, "accepted", "Asha"), /does not exist/);
    const d = db.getDb();
    assert.throws(() => d.prepare("UPDATE quotation_hour_estimates SET split = '[]' WHERE id = ?").run(e.id), /cannot be edited/);
    assert.throws(() => d.prepare("UPDATE quotation_hour_estimates SET total_hours = 1 WHERE id = ?").run(e.id), /cannot be edited/);
    assert.deepEqual(h.listEstimates(lead.id).map((x) => x.id), [e.id]);
  });
  it("is written to the audit log", async () => {
    const { s, h } = await mods();
    const { listAudit } = await import("@/server/audit");
    const lead = s.createLead(client(), site());
    const e = await h.suggestSplit(lead.id, "Asha", aiSays({ split: [{ role: "frontend", hours: 1 }], reason: "x" }));
    h.decideSplit(lead.id, e.id, "dismissed", "Asha");
    const actions = listAudit({ action: "hours.", limit: 10 }).filter((a) => a.actor === "Asha").map((a) => a.action);
    assert.ok(actions.includes("hours.split_suggested") && actions.includes("hours.split_dismissed"), actions.join(","));
  });
});

describe("8. the doors", () => {
  it("suggest, list and decide through the routes; a bad body is refused", async () => {
    const { s } = await mods();
    const route = await import("@/app/api/business/leads/[id]/hour-split/route");
    const { NextRequest } = await import("next/server");
    const lead = s.createLead(client(), site());
    const ctx = { params: Promise.resolve({ id: lead.id }) };
    const call = (method: string, body?: object) => new NextRequest(`http://localhost:3000/api/business/leads/${lead.id}/hour-split`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const keep = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const made = await (await route.POST(call("POST"), ctx)).json();
      assert.equal(made.success, true);
      assert.equal(made.estimate.source, "rule", "with no key the rule answers");
      assert.equal((await (await route.GET(call("GET"), ctx)).json()).estimates.length, 1);
      assert.equal((await route.PUT(call("PUT", { id: made.estimate.id, status: "approved" }), ctx)).status, 400);
      assert.equal((await route.PUT(call("PUT", { id: "1", status: "accepted" }), ctx)).status, 400);
      assert.equal((await route.PUT(call("PUT", { id: made.estimate.id, status: "accepted" }), ctx)).status, 200);
      const gone = { params: Promise.resolve({ id: "nope" }) };
      assert.equal((await route.POST(call("POST"), gone)).status, 404);
    } finally { if (keep !== undefined) process.env.ANTHROPIC_API_KEY = keep; }
  });
});

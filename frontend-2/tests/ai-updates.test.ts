// The AI workspace's own updates (its bell): builds, credits and a failed payment, worked out from records that already exist; only the person's own organization;
// fixed wording, so no internal note reaches them. Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-ai-updates-"));
let seq = 0;
const k = (p = "k") => `${p}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

const mods = async () => ({
  u: await import("@/server/ai-updates"),
  o: await import("@/server/ai/orchestrator"),
  s: await import("@/server/ai/job-store"),
  c: await import("@/server/credits"),
  t: await import("@/server/tenancy"),
});
const newOrg = async () => (await mods()).t.createOrganization({ name: `Updates Org ${++seq}`, type: "business" }).id;

before(() => {
  process.env.SILPI_DB_PATH = path.join(dir, "updates.db");
});
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("the AI workspace's updates", () => {
  it("says what each build is doing, and only builds that need the person light the bell", async () => {
    const { u, o, s } = await mods();
    const org = await newOrg();
    const make = (title: string) => o.createJob({ orgId: org, brief: `A website called ${title} with a few pages`, title });
    // (A person may have three unfinished builds at once, so the finished ones are made first.)
    s.setJob(make("Done build").id, { status: "completed", finished_at: new Date().toISOString() });
    s.setJob(make("Broken build").id, { status: "failed", finished_at: new Date().toISOString() });
    const approval = make("Waiting build");
    s.setJob(approval.id, { status: "awaiting_approval" });
    s.setJob(make("Poor build").id, { status: "paused", pause_reason: "insufficient_credits" });
    s.setJob(make("Capped build").id, { status: "paused", pause_reason: "daily_cap" });
    const by = (title: string) => u.aiUpdates(org).find((x) => x.text === title)!;
    assert.equal(by("Waiting build").needsAction, true);
    assert.match(by("Waiting build").detail, /approval/);
    assert.equal(by("Poor build").needsAction, true);
    assert.match(by("Poor build").detail, /not enough credits/);
    assert.equal(by("Capped build").needsAction, false, "a daily limit is not something the person can fix now");
    assert.equal(by("Done build").needsAction, false);
    assert.equal(by("Done build").tone, "good");
    assert.equal(by("Broken build").tone, "warn");
    assert.equal(by("Waiting build").href, `/ai/builder/${approval.id}`);
    assert.equal(u.aiUpdates(org).filter((x) => x.needsAction).length, 2);
    // Once the plan is approved the build no longer needs them.
    s.setJob(approval.id, { status: "running", pause_reason: null });
    assert.equal(u.aiUpdates(org).filter((x) => x.needsAction).length, 1);
  });

  it("lists credits added by the plan or bought, in plain words, and never an internal note", async () => {
    const { u, c } = await mods();
    const org = await newOrg();
    c.addCredits({ orgId: org, units: 25_000, kind: "grant", idempotencyKey: k("grant"), note: "SECRET-internal-note", createdBy: "someone@internal.example" });
    c.addCredits({ orgId: org, units: 100_000, kind: "purchase", idempotencyKey: k("buy"), reference: "ORDER-SECRET-REF" });
    const list = u.aiUpdates(org);
    assert.deepEqual(list.map((x) => x.text).sort(), ["Credits added", "Credits bought"]);
    assert.ok(list.some((x) => x.detail.includes("25 credits")) && list.some((x) => x.detail.includes("100 credits")));
    assert.ok(list.every((x) => x.href === "/ai/billing" && !x.needsAction));
    const text = JSON.stringify(list);
    assert.ok(!/SECRET|internal\.example/.test(text), "no note, reference or e-mail address in what the person sees");
  });

  it("is newest first, limited, and shows one organization only", async () => {
    const { u, o, c, s } = await mods();
    const mine = await newOrg();
    const other = await newOrg();
    for (let i = 0; i < 4; i++) s.setJob(o.createJob({ orgId: mine, brief: `Website number ${i} with several pages`, title: `Mine ${i}` }).id, { status: "completed", finished_at: new Date().toISOString() });
    o.createJob({ orgId: other, brief: "Somebody else's private website idea", title: "Not mine" });
    c.addCredits({ orgId: other, units: 5_000, kind: "grant", idempotencyKey: k("other") });
    s.setJob(o.createJob({ orgId: mine, brief: "The newest website with many pages", title: "Newest" }).id, { status: "awaiting_approval" });
    const list = u.aiUpdates(mine);
    assert.ok(list.every((x) => !/Not mine|Credits added/.test(x.text)), "nothing of the other organization");
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1]!.at >= list[i]!.at, "newest first");
    assert.equal(u.aiUpdates(mine, 2).length, 2);
    assert.equal(u.aiUpdates(await newOrg()).length, 0, "a new organization has nothing yet");
  });

  it("the route needs a sign-in, and the bell and its page are in the AI workspace only", async () => {
    const route = await import("@/app/api/workspace/updates/route");
    const res = await route.GET(new NextRequest("http://localhost:3000/api/workspace/updates"));
    assert.equal(res.status, 401);
    const { readFileSync, existsSync } = await import("node:fs");
    const frame = readFileSync("src/components/ai/ai-frame.tsx", "utf8");
    assert.ok(frame.includes('href="/ai/updates"') && !frame.includes('href="/notifications"'), "the AI bell opens the AI updates, not the Fixed Price ones");
    const shell = readFileSync("src/components/client/client-shell.tsx", "utf8");
    assert.ok(shell.includes('href="/notifications"') && !shell.includes("/ai/updates"), "the Fixed Price bell keeps its own list");
    assert.ok(existsSync("src/app/ai/updates/page.tsx") && existsSync("src/app/(client)/notifications/page.tsx"), "both pages exist");
  });
});

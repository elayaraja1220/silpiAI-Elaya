// Agent orchestration: plan -> approve a budget -> build file by file, all through the AI Gateway. Real SQLite; the AI is a fake.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { resetLoginAttempts } from "@/lib/admin-auth";
import { useFixedMetering } from "./fixtures/fixed-pricing";

const dir = mkdtempSync(path.join(tmpdir(), "silpi-jobs-"));
const ADMIN = "test-admin-token-0123456789abcdef";
const PASSWORD = "a-long-test-password";
let seq = 0;
const k = (p = "k") => `${p}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
const noSleep = async () => {};

const mods = async () => ({
  o: await import("@/server/ai/orchestrator"),
  s: await import("@/server/ai/job-store"),
  prov: await import("@/server/ai/providers"),
  c: await import("@/server/credits"),
  t: await import("@/server/tenancy"),
  db: await import("@/lib/business/db"),
});
const newOrg = async () => (await mods()).t.createOrganization({ name: `Job Org ${++seq}`, type: "business" }).id;
const fund = async (orgId: string, units: number) => (await mods()).c.addCredits({ orgId, units, kind: "grant", idempotencyKey: k("fund") });
const err = async (fn: () => unknown) => { try { await fn(); } catch (e) { return (e as { code?: string }).code ?? "other"; } return "no-error"; };

// A fake provider. The seeded Anthropic models run on it. A call of 1000 in / 500 out costs: fast 16 units, balanced 315, best 630.
type Script = { files?: [string, "low" | "high"][]; plan?: () => string; onFile?: () => void; failFiles?: () => boolean };
async function fake(script: Script = {}) {
  const { prov } = await mods();
  const calls: { system: string; user: string }[] = [];
  const adapter: import("@/server/ai/providers").ProviderAdapter = {
    id: "anthropic",
    isConfigured: () => true,
    async complete(req) {
      const system = req.system ?? "";
      const user = req.messages[req.messages.length - 1]!.content;
      calls.push({ system, user });
      let text = "ok";
      if (system.includes("SILPI_JOB_PLAN")) text = script.plan ? script.plan() : JSON.stringify({ summary: "A small site.", files: (script.files ?? [["a.html", "low"], ["b.css", "low"], ["c.js", "high"]]).map(([p, c]) => ({ path: p, purpose: `the ${p}`, complexity: c })) });
      else if (system.includes("SILPI_JOB_FILE")) {
        if (script.failFiles?.()) throw new prov.ProviderError("overloaded", true, 529);
        script.onFile?.();
        text = `content of ${/File to write: (.+)/.exec(user)![1]}`;
      } else if (system.includes("SILPI_JOB_REVIEW")) text = "The project looks sound.";
      return { text, inputTokens: 1000, outputTokens: 500, providerRequestId: null };
    },
  };
  return { calls, deps: { providers: { anthropic: adapter, echo: prov.echoAdapter }, sleep: noSleep } };
}
const FILE_HOLD_LOW = 47; // a 2048-token file on the fast tier holds at most this many units (checked in the budget test)

before(async () => {
  process.env.SILPI_DB_PATH = path.join(dir, "jobs.db");
  process.env.SILPI_ADMIN_TOKEN = ADMIN;
  delete process.env.ANTHROPIC_API_KEY;
  await useFixedMetering();
});
after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  rmSync(dir, { recursive: true, force: true });
});

// =================================================================================================
describe("1. reading the plan", () => {
  it("accepts a good plan and tolerates text around the JSON", async () => {
    const { o } = await mods();
    const r = o.parsePlan('Here you go:\n{"summary":"s","files":[{"path":"src/a.ts","purpose":"p","complexity":"high"},{"path":"b.css"}]}\nThanks');
    assert.ok("plan" in r);
    if ("plan" in r) assert.deepEqual(r.plan.files.map((f) => [f.path, f.complexity]), [["src/a.ts", "high"], ["b.css", "low"]]);
  });
  it("refuses unsafe or broken plans", async () => {
    const { o } = await mods();
    const bad = (files: unknown, summary: unknown = "s") => "error" in o.parsePlan(JSON.stringify({ summary, files }));
    assert.ok(bad([{ path: "../etc/passwd" }]), "path traversal");
    assert.ok(bad([{ path: "/etc/passwd" }]), "absolute path");
    assert.ok(bad([{ path: "a\\b.txt" }]), "backslash");
    assert.ok(bad([{ path: "C:/x" }]), "drive letter");
    assert.ok(bad([{ path: "a//b" }]), "empty segment");
    assert.ok(bad([{ path: "a/./b" }]), "dot segment");
    assert.ok(bad([{ path: "A.txt" }, { path: "a.TXT" }]), "duplicates ignoring case");
    assert.ok(bad([]), "no files");
    assert.ok(bad(Array.from({ length: 13 }, (_, i) => ({ path: `f${i}.txt` }))), "too many files");
    assert.ok(bad([{ path: "a.txt" }], ""), "no summary");
    assert.ok("error" in o.parsePlan("no json here"));
    assert.ok("error" in o.parsePlan("{broken"));
  });
  it("removes a code fence wrapped around a whole file, and only that", async () => {
    const { o } = await mods();
    assert.equal(o.cleanFile("```js\nconst a = 1;\n```"), "const a = 1;");
    assert.equal(o.cleanFile("const a = '```';"), "const a = '```';");
    assert.equal(o.cleanFile("plain"), "plain");
  });
  it("picks the model for each step: cheap for routine files, stronger only where it matters", async () => {
    const { o } = await mods();
    assert.deepEqual(["economy", "standard", "high"].map((q) => o.modelFor(q as never, "file", "low")), ["fast", "fast", "balanced"]);
    assert.deepEqual(["economy", "standard", "high"].map((q) => o.modelFor(q as never, "file", "high")), ["fast", "balanced", "balanced"]);
    assert.deepEqual(["economy", "standard", "high"].map((q) => o.modelFor(q as never, "review")), ["fast", "balanced", "best"]);
    assert.equal(o.modelFor("demo", "plan"), "silpi-demo");
  });
});

// =================================================================================================
describe("2. a whole build", () => {
  it("plans, waits for approval, builds every file, and charges exactly the real cost", async () => {
    const { o, s, c } = await mods();
    const org = await newOrg();
    await fund(org, 1_000_000);
    const f = await fake();
    const job = o.createJob({ orgId: org, brief: "A landing page for a bakery" });
    assert.equal(job.status, "planning");
    await o.runJob(job.id, f.deps);
    const planned = s.getJob(org, job.id)!;
    assert.equal(planned.status, "awaiting_approval");
    assert.equal(planned.spentUnits, 315, "only the plan has been paid for");
    assert.equal(f.calls.length, 1);
    assert.deepEqual(s.getSteps(job.id).map((x) => [x.kind, x.status, x.model]), [["plan", "completed", "balanced"], ["file", "pending", "fast"], ["file", "pending", "fast"], ["file", "pending", "balanced"]]);
    const est = o.estimateRemaining(planned);
    assert.ok(est.maxUnits > 0 && est.steps.length === 3, "the customer is shown the most the build could cost");

    o.approveJob(org, job.id); // default budget: spent + the worst case of the rest
    await o.runJob(job.id, f.deps);
    const done = s.getJob(org, job.id)!;
    assert.equal(done.status, "completed");
    assert.equal(done.spentUnits, 315 + 16 + 16 + 315);
    assert.ok(done.spentUnits <= done.budgetUnits, "never above the budget");
    assert.deepEqual(s.getFiles(org, job.id), [{ path: "a.html", content: "content of a.html" }, { path: "b.css", content: "content of b.css" }, { path: "c.js", content: "content of c.js" }]);
    const w = c.getWallet(org);
    assert.equal(w.balanceUnits, 1_000_000 - done.spentUnits, "the wallet paid exactly what the job recorded");
    assert.equal(w.reservedUnits, 0);
    assert.deepEqual(c.auditWallets(), []);
    assert.deepEqual(s.getSteps(job.id).filter((x) => x.kind === "file").map((x) => x.modelUsed), ["haiku-5-5", "haiku-5-5", "sonnet-5-5"]);
  });
  it("an optional review step runs last, on the best tier for high quality", async () => {
    const { o, s } = await mods();
    const org = await newOrg();
    await fund(org, 1_000_000);
    const f = await fake({ files: [["only.js", "low"]] });
    const job = o.createJob({ orgId: org, brief: "A tiny script please", quality: "high", review: true });
    await o.runJob(job.id, f.deps);
    o.approveJob(org, job.id);
    await o.runJob(job.id, f.deps);
    const steps = s.getSteps(job.id);
    assert.equal(steps[steps.length - 1]!.kind, "review");
    assert.equal(steps[steps.length - 1]!.modelUsed, "opus-5-5");
    assert.equal(s.getStepOutput(job.id, steps[steps.length - 1]!.seq), "The project looks sound.");
    assert.ok(f.calls.at(-1)!.user.includes("### only.js"), "the reviewer was given the generated file");
    assert.equal(s.getJob(org, job.id)!.status, "completed");
  });
  it("the demo quality builds the whole thing free, with no provider", async () => {
    const { o, s, c, prov } = await mods();
    const org = await newOrg();
    const deps = { providers: prov.defaultProviders(), sleep: noSleep };
    const job = o.createJob({ orgId: org, brief: "Anything at all, for a free trial", quality: "demo" });
    await o.runJob(job.id, deps);
    o.approveJob(org, job.id);
    await o.runJob(job.id, deps);
    const done = s.getJob(org, job.id)!;
    assert.equal(done.status, "completed");
    assert.equal(done.spentUnits, 0);
    assert.equal(s.getFiles(org, job.id)!.length, 3);
    assert.match(s.getFiles(org, job.id)![0]!.content, /Demo file/);
    assert.equal(c.listLedger(org).length, 0, "no credits were touched");
  });
});

// =================================================================================================
describe("3. the budget is a hard cap", () => {
  it("stops before a step that could pass the budget, spends nothing more, and continues after approval", async () => {
    const { o, s } = await mods();
    const org = await newOrg();
    await fund(org, 1_000_000);
    const f = await fake();
    const job = o.createJob({ orgId: org, brief: "A landing page for a bakery" });
    await o.runJob(job.id, f.deps);
    const calls = f.calls.length;
    o.approveJob(org, job.id, 315 + 20); // too little for even the first file's worst case
    await o.runJob(job.id, f.deps);
    const stuck = s.getJob(org, job.id)!;
    assert.deepEqual([stuck.status, stuck.pauseReason], ["paused", "needs_approval"]);
    assert.equal(stuck.spentUnits, 315);
    assert.equal(f.calls.length, calls, "no AI call was made");
    assert.ok(FILE_HOLD_LOW > 20);
    assert.equal(await err(() => o.resumeJob(org, job.id)), "state", "resume is not the way out: more budget is");
    o.approveJob(org, job.id);
    await o.runJob(job.id, f.deps);
    assert.equal(s.getJob(org, job.id)!.status, "completed");
  });
  it("refuses a budget below what is already spent, and an approval when nothing is waiting", async () => {
    const { o } = await mods();
    const org = await newOrg();
    await fund(org, 1_000_000);
    const f = await fake();
    const job = o.createJob({ orgId: org, brief: "A landing page for a bakery" });
    assert.equal(await err(() => o.approveJob(org, job.id)), "state", "still planning");
    await o.runJob(job.id, f.deps);
    assert.equal(await err(() => o.approveJob(org, job.id, 100)), "other", "100 < 315 spent: a validation error");
    assert.equal(await err(() => o.approveJob(org, job.id, 1.5)), "other");
    o.approveJob(org, job.id, 100_000);
    assert.equal(await err(() => o.approveJob(org, job.id, 200_000)), "state", "already running");
  });
});

// =================================================================================================
describe("4. things going wrong", () => {
  it("not enough credits mid-build pauses it; adding credits and resuming finishes it without paying twice", async () => {
    const { o, s, c } = await mods();
    const org = await newOrg();
    await fund(org, 1200); // holds the plan (922) and two small files, but not the big file (about 1,844)
    const f = await fake();
    const job = o.createJob({ orgId: org, brief: "A landing page for a bakery" });
    await o.runJob(job.id, f.deps);
    o.approveJob(org, job.id, 100_000);
    await o.runJob(job.id, f.deps);
    const paused = s.getJob(org, job.id)!;
    assert.deepEqual([paused.status, paused.pauseReason], ["paused", "insufficient_credits"]);
    assert.equal(s.getSteps(job.id).filter((x) => x.status === "completed").length, 3, "the plan and two files are kept");
    assert.equal(c.getWallet(org).reservedUnits, 0, "nothing is left held");
    await fund(org, 100_000);
    o.resumeJob(org, job.id);
    await o.runJob(job.id, f.deps);
    const done = s.getJob(org, job.id)!;
    assert.equal(done.status, "completed");
    assert.equal(done.spentUnits, 315 + 16 + 16 + 315, "each step was paid once");
    assert.equal(f.calls.filter((x) => x.system.includes("SILPI_JOB_FILE")).length, 3, "finished files were not regenerated");
    assert.deepEqual(c.auditWallets(), []);
  });
  it("a provider that keeps failing pauses the build without charging; resuming tries again", async () => {
    const { o, s, c } = await mods();
    const org = await newOrg();
    await fund(org, 1_000_000);
    let down = false;
    const f = await fake({ failFiles: () => down });
    const job = o.createJob({ orgId: org, brief: "A landing page for a bakery" });
    await o.runJob(job.id, f.deps);
    o.approveJob(org, job.id);
    down = true;
    await o.runJob(job.id, f.deps);
    const paused = s.getJob(org, job.id)!;
    assert.deepEqual([paused.status, paused.pauseReason], ["paused", "error"]);
    assert.equal(paused.spentUnits, 315, "the failed step cost nothing");
    assert.equal(c.getWallet(org).reservedUnits, 0);
    assert.equal(s.getSteps(job.id).filter((x) => x.status === "failed").length, 1);
    down = false;
    o.resumeJob(org, job.id);
    await o.runJob(job.id, f.deps);
    assert.equal(s.getJob(org, job.id)!.status, "completed");
  });
  it("an unusable plan is retried once, then the build fails and the plan's cost is refunded", async () => {
    const { o, s, c } = await mods();
    const org = await newOrg();
    await fund(org, 1_000_000);
    const f = await fake({ plan: () => "I cannot do that, sorry." });
    const job = o.createJob({ orgId: org, brief: "A landing page for a bakery" });
    await o.runJob(job.id, f.deps);
    const failed = s.getJob(org, job.id)!;
    assert.equal(failed.status, "failed");
    assert.equal(f.calls.length, 2, "one retry");
    assert.match(failed.message, /refunded/);
    assert.equal(c.getWallet(org).balanceUnits, 1_000_000, "the customer is back to where they started");
    assert.deepEqual(c.auditWallets(), []);
  });
  it("a plan with an unsafe path fails the same way: the path is never used", async () => {
    const { o, s } = await mods();
    const org = await newOrg();
    await fund(org, 1_000_000);
    const f = await fake({ plan: () => JSON.stringify({ summary: "x", files: [{ path: "../../secrets.env", purpose: "p", complexity: "low" }] }) });
    const job = o.createJob({ orgId: org, brief: "A landing page for a bakery" });
    await o.runJob(job.id, f.deps);
    assert.equal(s.getJob(org, job.id)!.status, "failed");
    assert.equal(s.getSteps(job.id).filter((x) => x.kind === "file").length, 0);
  });
  it("a build the server lost track of is shown as interrupted and can be resumed", async () => {
    const { o, s } = await mods();
    const org = await newOrg();
    await fund(org, 1_000_000);
    const f = await fake();
    const job = o.createJob({ orgId: org, brief: "A landing page for a bakery" }); // never started: no runner holds it
    assert.equal(o.reconcileJobs(org), 1);
    const lost = s.getJob(org, job.id)!;
    assert.deepEqual([lost.status, lost.pauseReason], ["paused", "interrupted"]);
    assert.equal(o.reconcileJobs(org), 0, "repeating is harmless");
    o.resumeJob(org, job.id);
    await o.runJob(job.id, f.deps);
    assert.equal(s.getJob(org, job.id)!.status, "awaiting_approval");
  });
  it("two runners for one build cannot run at once", async () => {
    const { o, s } = await mods();
    const org = await newOrg();
    await fund(org, 1_000_000);
    const f = await fake();
    const job = o.createJob({ orgId: org, brief: "A landing page for a bakery" });
    await Promise.all([o.runJob(job.id, f.deps), o.runJob(job.id, f.deps)]);
    assert.equal(f.calls.length, 1, "the plan was asked for once");
    assert.equal(s.getJob(org, job.id)!.spentUnits, 315);
  });
});

// =================================================================================================
describe("5. cancelling", () => {
  it("stops after the step in progress; later steps are never run or charged", async () => {
    const { o, s, c } = await mods();
    const org = await newOrg();
    await fund(org, 1_000_000);
    let cancelNow = () => {};
    const f = await fake({ onFile: () => cancelNow() });
    const job = o.createJob({ orgId: org, brief: "A landing page for a bakery" });
    await o.runJob(job.id, f.deps);
    o.approveJob(org, job.id);
    cancelNow = () => { cancelNow = () => {}; o.cancelJob(org, job.id); };
    await o.runJob(job.id, f.deps);
    const j = s.getJob(org, job.id)!;
    assert.equal(j.status, "cancelled");
    assert.equal(j.spentUnits, 315 + 16, "the plan and the one file that was already running");
    assert.deepEqual(s.getSteps(job.id).map((x) => x.status), ["completed", "completed", "skipped", "skipped"]);
    assert.equal(c.getWallet(org).reservedUnits, 0);
    assert.equal(await err(() => o.cancelJob(org, job.id)), "state", "already finished");
  });
  it("a build nobody is running is cancelled at once", async () => {
    const { o, s } = await mods();
    const org = await newOrg();
    const job = o.createJob({ orgId: org, brief: "A landing page for a bakery" });
    o.reconcileJobs(org);
    assert.equal(o.cancelJob(org, job.id).status, "cancelled");
    assert.deepEqual(s.getSteps(job.id).map((x) => x.status), ["skipped"]);
  });
});

// =================================================================================================
describe("6. limits and tenancy", () => {
  it("validates the brief, the quality, and caps unfinished builds per organization", async () => {
    const { o } = await mods();
    const org = await newOrg();
    assert.equal(await err(() => o.createJob({ orgId: org, brief: "short" })), "other");
    assert.equal(await err(() => o.createJob({ orgId: org, brief: "x".repeat(4001) })), "other");
    assert.equal(await err(() => o.createJob({ orgId: org, brief: "A landing page for a bakery", quality: "ultra" })), "other");
    assert.equal(await err(() => o.createJob({ orgId: "org_missing", brief: "A landing page for a bakery" })), "other");
    for (let i = 0; i < 3; i++) o.createJob({ orgId: org, brief: `Project number ${i} for testing` });
    assert.equal(await err(() => o.createJob({ orgId: org, brief: "A fourth project for testing" })), "state");
  });
  it("one organization can neither see nor change another's build", async () => {
    const { o, s } = await mods();
    const [a, b] = [await newOrg(), await newOrg()];
    await fund(a, 1_000_000);
    const f = await fake();
    const job = o.createJob({ orgId: a, brief: "A landing page for a bakery" });
    await o.runJob(job.id, f.deps);
    assert.equal(s.getJob(b, job.id), null);
    assert.equal(s.getFiles(b, job.id), null);
    assert.equal(s.listJobs(b).length, 0);
    for (const action of [() => o.approveJob(b, job.id), () => o.resumeJob(b, job.id), () => o.cancelJob(b, job.id)]) assert.equal(await err(action), "not-found");
    assert.equal(s.getJob(a, job.id)!.status, "awaiting_approval", "untouched");
  });
});

// =================================================================================================
describe("7. the HTTP API", () => {
  type Init = { method?: string; body?: unknown; cookie?: string; origin?: string | null; headers?: Record<string, string> };
  function req(url: string, init: Init = {}): NextRequest {
    const headers: Record<string, string> = { host: "localhost:3000", "x-forwarded-for": `10.3.0.${++seq % 250}`, ...(init.headers ?? {}) };
    if (init.origin !== null) headers.origin = init.origin ?? "http://localhost:3000";
    if (init.cookie) headers.cookie = init.cookie;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  }
  const admin = { authorization: `Bearer ${ADMIN}` };
  const routes = async () => ({
    jobs: await import("@/app/api/workspace/jobs/route"),
    job: await import("@/app/api/workspace/jobs/[id]/route"),
    approve: await import("@/app/api/workspace/jobs/[id]/approve/route"),
    resume: await import("@/app/api/workspace/jobs/[id]/resume/route"),
    cancel: await import("@/app/api/workspace/jobs/[id]/cancel/route"),
    files: await import("@/app/api/workspace/jobs/[id]/files/route"),
    step: await import("@/app/api/workspace/jobs/[id]/steps/[seq]/route"),
    users: await import("@/app/api/admin/users/route"),
    login: await import("@/app/api/auth/login/route"),
  });
  const ctx = (id: string, extra: Record<string, string> = {}) => ({ params: Promise.resolve({ id, seq: "0", ...extra }) });
  async function member(name: string, role?: string, orgId?: string) {
    const r = await routes();
    const email = `${role ?? "owner"}@${name}.example`;
    const body = orgId ? { email, name: email, password: PASSWORD, orgId, role } : { email, name: email, password: PASSWORD, newOrg: { name, type: "agency" } };
    const made = await r.users.POST(req("/api/admin/users", { method: "POST", headers: admin, body }));
    assert.equal(made.status, 200, await made.clone().text());
    const org = (await made.json()).organization.id as string;
    const res = await r.login.POST(req("/api/auth/login", { method: "POST", body: { email, password: PASSWORD } }));
    return { org, cookie: `silpi_session=${/silpi_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]}` };
  }
  const until = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 30)); } assert.fail("timed out"); };
  beforeEach(() => resetLoginAttempts());

  it("runs a demo build from brief to files, and only the owner organization can see it", async () => {
    const r = await routes();
    const owner = await member("jobs-api");
    const outsider = await member("jobs-other");
    const state = async (id: string, cookie = owner.cookie) => (await (await r.job.GET(req(`/api/workspace/jobs/${id}`, { cookie }), ctx(id))).json());

    const made = await r.jobs.POST(req("/api/workspace/jobs", { method: "POST", cookie: owner.cookie, body: { brief: "A landing page for a bakery", quality: "demo" } }));
    assert.equal(made.status, 200);
    const id = (await made.json()).job.id as string;
    await until(async () => (await state(id)).job.status === "awaiting_approval");
    const waiting = await state(id);
    assert.equal(waiting.steps.length, 4);
    assert.equal(waiting.estimate.steps.length, 3, "the estimate is shown while waiting");
    assert.equal(waiting.estimate.maxUnits, 0, "demo costs nothing");

    assert.equal((await r.job.GET(req(`/api/workspace/jobs/${id}`, { cookie: outsider.cookie }), ctx(id))).status, 404, "another organization cannot see it");
    assert.equal((await r.approve.POST(req(`/api/workspace/jobs/${id}/approve`, { method: "POST", cookie: outsider.cookie, body: {} }), ctx(id))).status, 404);
    assert.equal((await r.approve.POST(req(`/api/workspace/jobs/${id}/approve`, { method: "POST", cookie: owner.cookie, body: {} }), ctx(id))).status, 200);
    await until(async () => (await state(id)).job.status === "completed");

    const files = await (await r.files.GET(req(`/api/workspace/jobs/${id}/files`, { cookie: owner.cookie }), ctx(id))).json();
    assert.deepEqual(files.files.map((f: { path: string }) => f.path), ["index.html", "styles.css", "app.js"]);
    assert.equal((await r.files.GET(req(`/api/workspace/jobs/${id}/files`, { cookie: outsider.cookie }), ctx(id))).status, 404);
    const plan = await (await r.step.GET(req(`/api/workspace/jobs/${id}/steps/1`, { cookie: owner.cookie }), ctx(id, { seq: "1" }))).json();
    assert.match(plan.output, /Demo plan/);
    assert.equal((await r.step.GET(req(`/api/workspace/jobs/${id}/steps/1`, { cookie: outsider.cookie }), ctx(id, { seq: "1" }))).status, 404);
    const list = await (await r.jobs.GET(req("/api/workspace/jobs", { cookie: owner.cookie }))).json();
    assert.equal(list.jobs.length, 1);
    assert.equal((await (await r.jobs.GET(req("/api/workspace/jobs", { cookie: outsider.cookie }))).json()).jobs.length, 0);
  });
  it("needs a signed-in member who may use AI; viewers can look but not start or change; cross-site is blocked", async () => {
    const r = await routes();
    const owner = await member("jobs-roles");
    const viewer = await member("jobs-roles", "viewer", owner.org);
    const body = { brief: "A landing page for a bakery", quality: "demo" };
    assert.equal((await r.jobs.POST(req("/api/workspace/jobs", { method: "POST", body }))).status, 401);
    assert.equal((await r.jobs.POST(req("/api/workspace/jobs", { method: "POST", cookie: viewer.cookie, body }))).status, 403);
    assert.equal((await r.jobs.GET(req("/api/workspace/jobs", { cookie: viewer.cookie }))).status, 200);
    assert.equal((await r.jobs.POST(req("/api/workspace/jobs", { method: "POST", cookie: owner.cookie, body, origin: "http://evil.example" }))).status, 403);
    assert.equal((await r.jobs.POST(req("/api/workspace/jobs", { method: "POST", cookie: owner.cookie, body: { brief: "tiny" } }))).status, 400);
    const made = await r.jobs.POST(req("/api/workspace/jobs", { method: "POST", cookie: owner.cookie, body }));
    const id = (await made.json()).job.id as string;
    assert.equal((await r.cancel.POST(req(`/api/workspace/jobs/${id}/cancel`, { method: "POST", cookie: viewer.cookie, body: {} }), ctx(id))).status, 403);
    await until(async () => (await (await r.job.GET(req(`/api/workspace/jobs/${id}`, { cookie: owner.cookie }), ctx(id))).json()).job.status === "awaiting_approval");
    assert.equal((await r.cancel.POST(req(`/api/workspace/jobs/${id}/cancel`, { method: "POST", cookie: owner.cookie, body: {} }), ctx(id))).status, 200);
    assert.equal((await r.resume.POST(req(`/api/workspace/jobs/${id}/resume`, { method: "POST", cookie: owner.cookie, body: {} }), ctx(id))).status, 409, "a finished build cannot be resumed");
  });
});

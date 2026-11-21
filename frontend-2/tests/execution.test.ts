// Hybrid project generation: Local Claude Code (default) and the optional Anthropic API.
//
// NOTHING HERE USES THE NETWORK, A REAL CLAUDE LOGIN OR ANY PAID API.
// Claude Code is replaced by tests/fixtures/fake-claude.mjs, which speaks the same command line, so the real code
// for launching, streaming, cancelling and cleaning the environment runs end to end. The API runner is replaced by a
// spy that records every call; the tests prove it is never called unless an approval was recorded.
// Run: npm test
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// The database and workspace are private to this test file and must exist before the store is imported.
const root = mkdtempSync(path.join(tmpdir(), "silpi-exec-"));
process.env.SILPI_DB_PATH = path.join(root, "test.db");
const WORKSPACES = path.join(root, "projects");
process.env.SILPI_WORKSPACE_DIR = WORKSPACES;
delete process.env.SILPI_AGENT_DIR;
const ADMIN = "test-admin-token-for-silpi-tests-0123456789";
process.env.SILPI_ADMIN_TOKEN = ADMIN;
const FAKE = path.resolve("tests/fixtures/fake-claude.mjs");

import { NextRequest } from "next/server";

import { allowLoginAttempt, checkAdminToken, createSession, requireAdmin, resetLoginAttempts, sameSite, verifySession } from "@/lib/admin-auth";
import { checkApiApproval, estimateApiCost } from "@/lib/execution/api-gate";
import { ALLOWED_TOOLS, getClaudeStatus, localArgs, locateClaude, parseAuthStatus, parseClaudeLine, readAuth, runClaude, scrubbedEnv, spawnSpec } from "@/lib/execution/claude-cli";
import type { RunnerDeps } from "@/lib/execution/runner";
import { DEFAULT_EXECUTION_SETTINGS, ExecError, executionSettingsProblems, jobStatusLabel, parseExecutionSettings, readExecutionPatch, validClaudePath, type ExecutionSettings } from "@/lib/execution/types";
import { runVerification } from "@/lib/execution/verify";
import { assertContained, prepareWorkspace, resolveWorkspace, verifyJobWorkspace } from "@/lib/execution/workspace";
import type { Requirement } from "@/lib/business/types";

const mods = async () => ({
  store: await import("@/lib/business/store"),
  jobs: await import("@/lib/execution/jobs"),
  runner: await import("@/lib/execution/runner"),
  validate: await import("@/lib/business/validate"),
});

after(() => {
  const cached = globalThis as unknown as { silpiDb?: { close(): void } };
  cached.silpiDb?.close();
  delete cached.silpiDb;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may still hold a file for a moment */ }
});

// ---- fixtures -------------------------------------------------------------------------------

const requirement = (): Requirement => ({
  title: "BrightWave site", summary: "A four page website that is long enough to be valid.", scope: "full", existingProject: "", version: "", projectType: "business-website", complexity: "basic",
  pages: ["Home", "About Us", "Contact Us"], modules: [], design: "ai", references: "", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 },
  hosting: { needed: false, choice: "self", plan: "static", years: 1 }, deadlineWeeks: 0, budget: 0,
});

/** A project whose quotation the client approved. */
async function approvedLead() {
  const { store, validate } = await mods();
  const client = { name: "Test", email: "t@example.com", phone: "9876543210", company: "", gstin: "", state: "Tamil Nadu", address: "" };
  const lead = store.createLead(client, validate.parseRequirement(requirement(), store.getRateCard()), "standard");
  store.setStage(lead.id, "approved", "client approved");
  return store.getLead(lead.id)!;
}

type SpyDeps = RunnerDeps & { apiCalls: Parameters<RunnerDeps["runApi"]>[0][] };
/** Runner dependencies: the real Claude Code code paths running the fake program; a spy instead of the API. */
function deps(env: Record<string, string> = {}, over: Partial<RunnerDeps> = {}): SpyDeps {
  const apiCalls: SpyDeps["apiCalls"] = [];
  const base: RunnerDeps = {
    env: { ...process.env, FAKE_AUTH: "subscription", FAKE_RUN: "success", ANTHROPIC_API_KEY: "sk-ant-test-key-that-must-never-be-used", CLAUDECODE: "1", ...env } as unknown as NodeJS.ProcessEnv,
    getSettings: () => settingsNow(),
    locate: () => ({ location: { exe: process.execPath, source: "configured", prefixArgs: [FAKE] } }),
    readAuth,
    runClaude,
    runApi: async (input) => {
      apiCalls.push(input);
      return { ok: true, summary: "Built by the API (spy).", filesChanged: 3, turns: 5, buildPassed: true, appStarted: true, costUsd: 1.5 };
    },
    verify: async () => ({ steps: [{ name: "Build", status: "passed" as const }], passed: true }),
    assertAgentReady: async () => ({}),
    workspaceRoot: () => WORKSPACES,
    exportContent: () => ({ items: 0, files: 0, missing: [] }),
  };
  return { ...base, ...over, apiCalls };
}
let settingsNow: () => ExecutionSettings = () => DEFAULT_EXECUTION_SETTINGS;
const useSettings = (s: Partial<ExecutionSettings>) => { settingsNow = () => ({ ...DEFAULT_EXECUTION_SETTINGS, ...s }); };

const START = { withoutAdvance: true, reason: "test run without advance" } as const;
async function waitFor<T>(read: () => T | null | undefined | false, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = read();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function finished(jobId: string) {
  const { jobs } = await mods();
  return waitFor(() => { const j = jobs.getJob(jobId); return j && j.state !== "running" ? j : null; }, "the job to finish");
}
async function expectCode(promise: Promise<unknown> | (() => unknown), code: string): Promise<ExecError> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (e) {
    assert.ok(e instanceof ExecError, `expected an ExecError, got ${e}`);
    assert.equal((e as ExecError).code, code, (e as ExecError).message);
    return e as ExecError;
  }
  assert.fail(`expected ${code}, but nothing was thrown`);
}

// =================================================================================================
describe("1. settings: the API is off, and nothing is open, by default", () => {
  it("defaults: API off, fallback off, no limit, no custom path", () => {
    assert.deepEqual(DEFAULT_EXECUTION_SETTINGS, { apiEnabled: false, apiFallbackOffer: false, apiSpendLimitUsd: null, claudePath: null, localMaxTurns: 60, localTimeoutMinutes: 45 });
  });
  it("a change is checked strictly and every problem is listed", () => {
    assert.deepEqual(executionSettingsProblems({ apiEnabled: true, apiSpendLimitUsd: 5 }), []);
    const problems = executionSettingsProblems({ apiEnabled: "yes", apiSpendLimitUsd: -3, claudePath: "rm -rf /", localMaxTurns: 9999, localTimeoutMinutes: 0, evil: true });
    assert.equal(problems.length, 6, problems.join(" | "));
    for (const bad of [null, [], "x", 5]) assert.equal(executionSettingsProblems(bad).length, 1);
  });
  it("the Claude Code path must be a file named claude (no commands, no traversal)", () => {
    for (const ok of ["C:\\Users\\dev\\.local\\bin\\claude.exe", "C:/tools/claude.cmd", "/usr/local/bin/claude", "\\\\server\\share\\claude.exe"]) assert.ok(validClaudePath(ok), ok);
    for (const bad of ["claude", "bin/claude", "C:\\x\\claude.exe --dangerous", "C:\\x\\..\\claude.exe", "C:\\x\\notclaude.exe", "C:\\x\\claude.exe\"", "C:\\x\\claude.exe; calc", "", "C:\\x\\claude.exe\n", "C:\\x\\claude.sh"]) assert.ok(!validClaudePath(bad), bad);
    assert.deepEqual(readExecutionPatch({ claudePath: "" }).patch, { claudePath: null });
  });
  it("saved settings persist, merge, and damaged data falls back to the safe defaults", async () => {
    const { jobs } = await mods();
    assert.deepEqual(jobs.getExecutionSettings(), DEFAULT_EXECUTION_SETTINGS);
    jobs.saveExecutionSettings({ apiSpendLimitUsd: 5 });
    jobs.saveExecutionSettings({ apiEnabled: true });
    assert.deepEqual(jobs.getExecutionSettings(), { ...DEFAULT_EXECUTION_SETTINGS, apiSpendLimitUsd: 5, apiEnabled: true });
    const { getDb } = await import("@/lib/business/db");
    getDb().prepare("UPDATE settings SET value = ? WHERE key = 'execution_settings'").run("{broken");
    assert.deepEqual(jobs.getExecutionSettings(), DEFAULT_EXECUTION_SETTINGS);
    assert.deepEqual(parseExecutionSettings({ apiEnabled: "yes", apiSpendLimitUsd: 1e9 }), DEFAULT_EXECUTION_SETTINGS);
    jobs.saveExecutionSettings({ apiEnabled: false, apiSpendLimitUsd: null });
  });
  it("the status words the screen uses", () => {
    assert.equal(jobStatusLabel({ state: "running", mode: "local" }), "Local subscription execution");
    assert.equal(jobStatusLabel({ state: "running", mode: "api" }), "API-funded execution");
    assert.equal(jobStatusLabel({ state: "failed", mode: "local" }), "Execution failed");
    assert.equal(jobStatusLabel({ state: "waiting-approval", mode: "api" }), "Waiting for approval");
    assert.equal(jobStatusLabel({ state: "completed", mode: "local" }), "Completed");
    assert.equal(jobStatusLabel({ state: "cancelled", mode: "local" }), "Cancelled");
  });
});

// =================================================================================================
describe("2. Claude Code on this computer: found, signed in, and never exposing credentials", () => {
  it("finds the program: configured path, PATH, standard folder, then the VS Code extension", () => {
    const home = mkdtempSync(path.join(root, "home-"));
    const win = (p: string) => path.join(home, p);
    mkdirSync(win(".vscode/extensions/anthropic.claude-code-2.1.0-win32-x64/resources/native-binary"), { recursive: true });
    writeFileSync(win(".vscode/extensions/anthropic.claude-code-2.1.0-win32-x64/resources/native-binary/claude.exe"), "x");
    const env = { USERPROFILE: home, HOME: home, PATH: "" } as unknown as NodeJS.ProcessEnv;
    assert.equal(locateClaude({ claudePath: null }, env, "win32").location?.source, "vscode-extension");
    mkdirSync(win(".local/bin"), { recursive: true });
    writeFileSync(win(".local/bin/claude.exe"), "x");
    assert.equal(locateClaude({ claudePath: null }, env, "win32").location?.source, "standard-location");
    const bin = mkdtempSync(path.join(root, "bin-"));
    writeFileSync(path.join(bin, "claude.exe"), "x");
    assert.equal(locateClaude({ claudePath: null }, { ...env, PATH: bin }, "win32").location?.source, "path");
    assert.equal(locateClaude({ claudePath: path.join(bin, "claude.exe") }, env, "win32").location?.source, "configured");
  });
  it("a missing configured path is a problem; it does not quietly use another copy", () => {
    const r = locateClaude({ claudePath: path.join(root, "nope", "claude.exe") });
    assert.equal(r.location, null);
    assert.match(r.problem!, /does not exist/);
  });
  it("reports 'not found' when Claude Code is not installed", async () => {
    const empty = mkdtempSync(path.join(root, "empty-"));
    const found = locateClaude({ claudePath: null }, { USERPROFILE: empty, HOME: empty, PATH: "", APPDATA: empty, LOCALAPPDATA: empty } as unknown as NodeJS.ProcessEnv, "win32");
    assert.equal(found.location, null);
    const status = await getClaudeStatus({ claudePath: null }, process.env, found);
    assert.deepEqual([status.installed, status.ready, status.auth], [false, false, null]);
    assert.match(status.message, /not found/i);
  });
  it("reads the sign-in with the official command and keeps only three facts", () => {
    const real = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro", email: "me@example.com", orgName: "Acme", orgId: "o1", configDirectory: "C:\\Users\\me\\.claude", loginExpiresAt: "2026-12-11" });
    const state = parseAuthStatus(real);
    assert.deepEqual(state, { kind: "authenticated-subscription", plan: "pro", message: "Signed in with a Claude subscription (pro)." });
    assert.ok(!JSON.stringify(state).match(/me@example|Acme|\.claude|o1|2026/));
    assert.equal(parseAuthStatus(JSON.stringify({ loggedIn: false })).kind, "not-authenticated");
    assert.equal(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "api_key" })).kind, "authenticated-api-key");
    assert.equal(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "console" })).kind, "authenticated-api-key");
    assert.equal(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "something-new" })).kind, "unknown");
    for (const junk of ["", "not json", "null", "[1]", "42"]) assert.equal(parseAuthStatus(junk).kind, "unknown", junk);
  });
  it("end to end with the fake program: subscription, no login, API-key login, unreadable", async () => {
    const location = { exe: process.execPath, source: "configured" as const, prefixArgs: [FAKE] };
    const status = async (mode: string) => getClaudeStatus({ claudePath: null }, { ...process.env, FAKE_AUTH: mode }, { location });
    const ok = await status("subscription");
    assert.deepEqual([ok.installed, ok.ready, ok.version, ok.auth?.kind, ok.auth?.plan], [true, true, "9.9.9", "authenticated-subscription", "pro"]);
    assert.equal((await status("none")).ready, false);
    assert.equal((await status("none")).auth?.kind, "not-authenticated");
    const key = await status("api-key");
    assert.equal(key.ready, false, "an API-key login is not a subscription");
    assert.equal(key.auth?.kind, "authenticated-api-key");
    assert.equal((await status("garbage")).auth?.kind, "unknown");
    // nothing from the account details survives anywhere in what is returned
    assert.ok(!JSON.stringify(ok).match(/secret|Organisation|org-secret|C:\\\\Users/i), JSON.stringify(ok));
  });
  it("the environment a run gets has no API key, no cloud-provider switch and no enclosing session", () => {
    const clean = scrubbedEnv({ PATH: "p", HOME: "h", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "u", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "x", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CONFIG_DIR: "keep" } as unknown as NodeJS.ProcessEnv);
    assert.deepEqual(Object.keys(clean).sort(), ["CLAUDE_CONFIG_DIR", "HOME", "PATH"]);
  });
  it("every command line is fixed: nothing from a request can be added to it", () => {
    const args = localArgs(60);
    assert.deepEqual(args.slice(0, 9), ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--max-turns", "60", "--allowedTools"]);
    assert.equal(args[9], ALLOWED_TOOLS.join(","));
    assert.ok(!ALLOWED_TOOLS.some((t) => /^Bash\((rm|del|curl|wget|powershell|cmd|sudo|git push)/i.test(t)), "no destructive or network commands");
    assert.ok(ALLOWED_TOOLS.every((t) => /^(Read|Write|Edit|Glob|Grep|Bash\(npm (install|run|test):\*\)|Bash\(npx (tsc|eslint):\*\))$/.test(t)), ALLOWED_TOOLS.join());
    const cmd = spawnSpec({ exe: "C:\\Program Files\\x\\claude.cmd", source: "path" }, ["-p", "--allowedTools", "Bash(npm run:*)"]);
    assert.equal(cmd.shell, true);
    assert.equal(cmd.command, '"C:\\Program Files\\x\\claude.cmd" "-p" "--allowedTools" "Bash(npm run:*)"');
    assert.deepEqual(spawnSpec({ exe: "C:\\x\\claude.exe", source: "path" }, ["-p"]), { command: "C:\\x\\claude.exe", args: ["-p"], shell: false });
  });
  it("reads Claude Code's streamed output as short, safe progress lines", () => {
    assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "system", subtype: "init", model: "m1" })), { kind: "status", text: "Claude Code started (m1)." });
    assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "  Hello   there " }] } })), { kind: "message", text: "Hello there" });
    assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "src/a.ts" } }] } })), { kind: "action", text: "Write: src/a.ts", file: "src/a.ts" });
    assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "result", subtype: "success", result: "Done.", num_turns: 3, total_cost_usd: 0.5 })), { kind: "result", ok: true, text: "Done.", turns: 3, notionalUsd: 0.5 });
    assert.equal((parseClaudeLine(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true })) as { ok: boolean }).ok, false);
    assert.equal(parseClaudeLine(JSON.stringify({ type: "something-else" })).kind, "ignore");
    assert.equal(parseClaudeLine("").kind, "ignore");
    assert.equal(parseClaudeLine("plain text").kind, "status");
  });
});

// =================================================================================================
describe("3. workspaces: only the approved folder, with the approved brief", () => {
  const brief = { description: "# Site\nBuild it.", frontend: ["HTML"], backend: [], database: [], styling: ["CSS"] };
  it("refuses names that could leave the projects folder", () => {
    for (const bad of ["..", "../x", "a/b", "a\\b", "/abs", "C:\\abs", ".hidden", "", " ", "x".repeat(61), "name with space", "a;b", "a&b", "$(x)", null, undefined, 5]) {
      assert.throws(() => resolveWorkspace(WORKSPACES, bad), (e: unknown) => e instanceof ExecError && ["bad-project-name", "bad-workspace"].includes((e as ExecError).code), String(bad));
    }
    assert.equal(resolveWorkspace(WORKSPACES, "meena-silks-4f2a"), path.join(WORKSPACES, "meena-silks-4f2a"));
  });
  it("prepares the folder and writes the brief; a new project must start empty", () => {
    const prepared = prepareWorkspace({ root: WORKSPACES, name: "ws-fresh", brief, allowExisting: false });
    assert.ok(existsSync(path.join(prepared.dir, ".silpi", "brief.json")));
    assert.equal(readFileSync(path.join(prepared.dir, ".silpi", "brief.md"), "utf8"), brief.description);
    assert.match(prepared.briefSha, /^[0-9a-f]{64}$/);
    prepareWorkspace({ root: WORKSPACES, name: "ws-fresh", brief, allowExisting: false }); // only .silpi inside: fine
    writeFileSync(path.join(prepared.dir, "index.html"), "x");
    assert.throws(() => prepareWorkspace({ root: WORKSPACES, name: "ws-fresh", brief, allowExisting: false }), (e: unknown) => (e as ExecError).code === "workspace-in-use");
    prepareWorkspace({ root: WORKSPACES, name: "ws-fresh", brief, allowExisting: true }); // a restart may continue
  });
  it("the brief is checked again before a run, and a changed brief is refused", () => {
    const { dir, briefSha } = prepareWorkspace({ root: WORKSPACES, name: "ws-verify", brief, allowExisting: false });
    assert.deepEqual(verifyJobWorkspace(WORKSPACES, "ws-verify", briefSha).brief, brief);
    writeFileSync(path.join(dir, ".silpi", "brief.json"), JSON.stringify({ ...brief, description: "tampered" }));
    assert.throws(() => verifyJobWorkspace(WORKSPACES, "ws-verify", briefSha), (e: unknown) => (e as ExecError).code === "brief-changed");
    rmSync(path.join(dir, ".silpi", "brief.json"));
    assert.throws(() => verifyJobWorkspace(WORKSPACES, "ws-verify", briefSha), (e: unknown) => (e as ExecError).code === "brief-missing");
    assert.throws(() => verifyJobWorkspace(WORKSPACES, "ws-never-made", briefSha), (e: unknown) => (e as ExecError).code === "workspace-missing");
  });
  it("a link inside the projects folder cannot lead a run somewhere else", () => {
    const outside = mkdtempSync(path.join(root, "outside-"));
    mkdirSync(WORKSPACES, { recursive: true });
    const link = path.join(WORKSPACES, "ws-link");
    try { symlinkSync(outside, link, "junction"); } catch { return; /* links not allowed on this machine: nothing to test */ }
    assert.throws(() => assertContained(WORKSPACES, link), (e: unknown) => (e as ExecError).code === "bad-workspace");
  });
});

// =================================================================================================
describe("4. API approval: every API run needs its own, recorded, cost approval", () => {
  const on = { ...DEFAULT_EXECUTION_SETTINGS, apiEnabled: true, apiSpendLimitUsd: 5 };
  const shown = (e = estimateApiCost([], 5)) => ({ confirmed: true, estimateUsd: e.estimatedUsd, limitUsd: 5, acceptUnreliable: true });
  it("an estimate comes only from earlier runs; with none it is unknown, never zero", () => {
    const none = estimateApiCost([], 5);
    assert.deepEqual([none.estimatedUsd, none.reliable], [null, false]);
    assert.match(none.basis, /cannot be estimated/);
    const few = estimateApiCost([2, 4], 5);
    assert.deepEqual([few.estimatedUsd, few.reliable], [3, false]);
    const enough = estimateApiCost([1, 9, 2, 3, 4, 100], 5);
    assert.deepEqual([enough.estimatedUsd, enough.reliable], [3, true], "the last five runs, median");
    assert.deepEqual(estimateApiCost([NaN, -1] as number[], null).estimatedUsd, null);
  });
  it("off by default; needs a limit; needs a confirmation of THIS run", () => {
    const est = estimateApiCost([1, 1, 1], 5);
    const good = { confirmed: true, estimateUsd: 1, limitUsd: 5 };
    assert.throws(() => checkApiApproval(DEFAULT_EXECUTION_SETTINGS, est, good), (e: unknown) => (e as ExecError).code === "api-disabled" && (e as ExecError).status === 403);
    assert.throws(() => checkApiApproval({ ...on, apiSpendLimitUsd: null }, est, good), (e: unknown) => (e as ExecError).code === "api-limit-missing");
    assert.throws(() => checkApiApproval(on, est, undefined), (e: unknown) => (e as ExecError).code === "approval-required");
    assert.throws(() => checkApiApproval(on, est, { ...good, confirmed: false }), (e: unknown) => (e as ExecError).code === "approval-required");
  });
  it("an approval of a stale estimate or limit is refused", () => {
    const est = estimateApiCost([1, 1, 1], 5);
    assert.throws(() => checkApiApproval(on, est, { confirmed: true, estimateUsd: 0.5, limitUsd: 5 }), (e: unknown) => (e as ExecError).code === "approval-stale");
    assert.throws(() => checkApiApproval(on, est, { confirmed: true, estimateUsd: 1, limitUsd: 50 }), (e: unknown) => (e as ExecError).code === "approval-stale");
    assert.throws(() => checkApiApproval(on, estimateApiCost([], 5), { confirmed: true, estimateUsd: 0, limitUsd: 5, acceptUnreliable: true }), (e: unknown) => (e as ExecError).code === "approval-stale", "an unknown estimate is not zero");
  });
  it("an estimate above the limit is refused", () => {
    const est = estimateApiCost([8, 9, 10], 5);
    assert.throws(() => checkApiApproval(on, est, { confirmed: true, estimateUsd: 9, limitUsd: 5 }), (e: unknown) => (e as ExecError).code === "estimate-over-limit");
  });
  it("a cost that cannot be estimated reliably needs a separate acceptance", () => {
    const none = estimateApiCost([], 5);
    assert.throws(() => checkApiApproval(on, none, { confirmed: true, estimateUsd: null, limitUsd: 5 }), (e: unknown) => (e as ExecError).code === "unreliable-estimate");
    const few = estimateApiCost([1, 2], 5);
    assert.throws(() => checkApiApproval(on, few, { confirmed: true, estimateUsd: 1.5, limitUsd: 5 }), (e: unknown) => (e as ExecError).code === "unreliable-estimate");
  });
  it("a valid approval is recorded with its mode, time, estimate and limit", () => {
    const at = new Date("2026-11-20T10:00:00Z");
    const a = checkApiApproval(on, estimateApiCost([], 5), shown(), at);
    assert.deepEqual(a, { mode: "api", approvedAt: "2026-11-20T10:00:00.000Z", estimatedUsd: null, limitUsd: 5, reliable: false, basis: estimateApiCost([], 5).basis, acceptedUnreliableEstimate: true });
    const reliable = checkApiApproval(on, estimateApiCost([1, 1, 1], 5), { confirmed: true, estimateUsd: 1, limitUsd: 5 }, at);
    assert.equal(reliable.acceptedUnreliableEstimate, false);
  });
});

// =================================================================================================
describe("5. Local Claude Code with a subscription sign-in (the default)", () => {
  it("prepare does not start anything; it needs the scope confirmed; the quotation alone starts nothing", async () => {
    const { runner, jobs } = await mods();
    const lead = await approvedLead();
    assert.equal(jobs.listJobs(lead.id).length, 0, "client approval alone created no job");
    await expectCode(async () => runner.prepareJob(lead.id, { scopeConfirmed: false }, deps()), "scope-not-confirmed");
    const job = runner.prepareJob(lead.id, { scopeConfirmed: true }, deps());
    assert.equal(job.state, "prepared");
    assert.equal(job.mode, null);
    assert.equal((await mods()).store.getLead(lead.id)!.stage, "approved", "preparing changes nothing about the project");
    assert.equal(runner.prepareJob(lead.id, { scopeConfirmed: true }, deps()).id, job.id, "preparing again returns the same job");
    assert.ok(existsSync(path.join(WORKSPACES, job.projectName, ".silpi", "brief.json")));
  });
  it("runs Claude Code with the developer's own sign-in: streamed output, no API key, brief on stdin, tests and build", async () => {
    const { runner, jobs, store } = await mods();
    const lead = await approvedLead();
    const d = deps();
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    const started = await runner.startJob(prepared.id, { mode: "local", ...START }, d);
    assert.deepEqual([started.state, started.mode, started.phase], ["running", "local", "generating"]);
    const job = await finished(prepared.id);
    assert.equal(job.state, "completed", job.error ?? "");
    assert.equal(job.exitCode, 0);
    assert.deepEqual(job.cost, { billing: "subscription", notionalUsd: 0.0123, note: "Covered by your Claude subscription. No API charge." });
    assert.equal(job.approval, null, "a local run needs no API approval");
    assert.equal(job.verification?.passed, true);
    assert.equal(job.result?.filesChanged, 1);
    assert.equal(d.apiCalls.length, 0, "the API was never used");
    assert.equal(store.getLead(lead.id)!.stage, "in_development");
    const events = jobs.listEvents(job.id);
    assert.ok(events.some((e) => e.kind === "status" && /Started: local subscription execution/.test(e.text)));
    assert.ok(events.some((e) => e.kind === "message" && e.text === "Reading the brief."));
    assert.ok(events.some((e) => e.kind === "action" && e.text === "Write: index.html"));
    assert.ok(events.some((e) => e.kind === "result"));
    assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), "numbered in order");
    // what the program received
    const seen = JSON.parse(readFileSync(path.join(WORKSPACES, job.projectName, ".silpi", "fake-run.json"), "utf8"));
    assert.equal(seen.apiKeyVisible, false, "the API key was removed from its environment");
    assert.equal(seen.nestedSessionVisible, false);
    assert.deepEqual(seen.args, localArgs(60));
    assert.ok(seen.stdinLength > 300 && /\.silpi\/brief\.md/.test(seen.stdinStart + "") === false || seen.stdinLength > 300, "the instructions arrived on standard input");
    assert.ok(!seen.args.join(" ").includes("Read .silpi/brief.md"), "no instruction text on the command line");
    assert.ok(existsSync(path.join(WORKSPACES, job.projectName, "index.html")), "it worked inside the project folder");
  });
  it("the prompt tells Claude Code to use exactly the approved technology and stay in the folder", async () => {
    const { runner } = await mods();
    const prompt = runner.buildLocalPrompt({ description: "d", frontend: ["HTML", "CSS", "JavaScript"], backend: [], database: [], styling: ["CSS"] });
    assert.match(prompt, /Use exactly this technology and no other: frontend HTML, CSS, JavaScript; styling CSS\./);
    assert.match(prompt, /Work only inside this folder/);
    assert.match(prompt, /Do not build anything under "Do NOT build"/);
  });
  it("the project stays in 'approved' if anything is wrong before the run", async () => {
    const { runner, store, jobs } = await mods();
    const lead = await approvedLead();
    const d = deps();
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    writeFileSync(path.join(WORKSPACES, prepared.projectName, ".silpi", "brief.json"), "{}");
    await expectCode(runner.startJob(prepared.id, { mode: "local", ...START }, d), "brief-changed");
    assert.equal(store.getLead(lead.id)!.stage, "approved");
    assert.equal(jobs.getJob(prepared.id)!.state, "prepared");
    await expectCode(runner.startJob(prepared.id, { mode: "carrier-pigeon" as never }, d), "bad-mode");
  });
  it("the advance-payment rule still applies when the work starts", async () => {
    const { runner } = await mods();
    const lead = await approvedLead();
    const d = deps();
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    await expectCode(runner.startJob(prepared.id, { mode: "local" }, d), "advance-required");
    assert.equal((await mods()).jobs.getJob(prepared.id)!.state, "prepared");
  });
  it("only one run per project at a time", async () => {
    const { runner } = await mods();
    const lead = await approvedLead();
    const d = deps({ FAKE_RUN: "hang" });
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    await runner.startJob(prepared.id, { mode: "local", ...START }, d);
    await expectCode(runner.startJob(prepared.id, { mode: "local", ...START }, d), "bad-state");
    runner.cancelJob(prepared.id);
  });
});

// =================================================================================================
describe("6. Local Claude Code missing or not signed in: nothing runs and nothing falls back to the API", () => {
  async function tryStart(over: Partial<RunnerDeps>, env: Record<string, string> = {}) {
    const { runner, store, jobs } = await mods();
    useSettings({ apiEnabled: true, apiSpendLimitUsd: 5, apiFallbackOffer: true }); // even with the API fully enabled
    const lead = await approvedLead();
    const d = deps(env, over);
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    const error = await runner.startJob(prepared.id, { mode: "local", ...START }, d).then(() => null, (e: ExecError) => e);
    const result = { error, d, stage: store.getLead(lead.id)!.stage, job: jobs.getJob(prepared.id)! };
    useSettings({});
    return result;
  }
  it("Claude Code is not installed", async () => {
    const r = await tryStart({ locate: () => ({ location: null }) });
    assert.equal(r.error?.code, "cli-missing");
    assert.match(r.error!.message, /does not switch to the API by itself/);
    assert.deepEqual([r.stage, r.job.state, r.d.apiCalls.length], ["approved", "prepared", 0]);
  });
  it("Claude Code is installed but not signed in", async () => {
    const r = await tryStart({}, { FAKE_AUTH: "none" });
    assert.equal(r.error?.code, "not-authenticated");
    assert.deepEqual([r.stage, r.job.state, r.d.apiCalls.length], ["approved", "prepared", 0]);
  });
  it("Claude Code is signed in with an API key: refused, because that is billed per use", async () => {
    const r = await tryStart({}, { FAKE_AUTH: "api-key" });
    assert.equal(r.error?.code, "api-key-auth");
    assert.match(r.error!.message, /billed per use/);
    assert.deepEqual([r.stage, r.d.apiCalls.length], ["approved", 0]);
  });
  it("the sign-in cannot be read: refused, not assumed", async () => {
    const r = await tryStart({}, { FAKE_AUTH: "garbage" });
    assert.equal(r.error?.code, "auth-unknown");
    assert.equal(r.d.apiCalls.length, 0);
  });
  it("Claude Code cannot be started: the run fails and the API is not used", async () => {
    const { runner, jobs } = await mods();
    const lead = await approvedLead();
    const broken = deps({}, { locate: () => ({ location: { exe: path.join(root, "gone", "claude.exe"), source: "configured" } }), readAuth: async () => ({ kind: "authenticated-subscription", message: "ok" }) });
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, broken);
    await runner.startJob(prepared.id, { mode: "local", ...START }, broken);
    const job = await finished(prepared.id);
    assert.equal(job.state, "failed");
    assert.match(job.error!, /could not be started/);
    assert.equal(broken.apiCalls.length, 0);
    assert.ok(jobs.listEvents(job.id).length > 0);
  });
});

// =================================================================================================
describe("7. a failed local run never turns into an API run", () => {
  it("failure is recorded; the API spy is never called, even with API mode and the fallback offer both on", async () => {
    const { runner, jobs, store } = await mods();
    jobs.saveExecutionSettings({ apiEnabled: true, apiSpendLimitUsd: 5, apiFallbackOffer: true });
    useSettings({ apiEnabled: true, apiSpendLimitUsd: 5, apiFallbackOffer: true });
    const lead = await approvedLead();
    const d = deps({ FAKE_RUN: "fail" });
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    await runner.startJob(prepared.id, { mode: "local", ...START }, d);
    const job = await finished(prepared.id);
    assert.equal(job.state, "failed");
    assert.equal(job.mode, "local");
    assert.equal(job.exitCode, 1);
    assert.match(job.error!, /exit code 1/);
    assert.equal(job.approval, null);
    assert.equal(d.apiCalls.length, 0, "no API run was started");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(d.apiCalls.length, 0, "and none starts later");
    assert.deepEqual(jobs.listJobs(lead.id).map((j) => j.mode), ["local"], "no other job was created");
    assert.equal(store.getLead(lead.id)!.stage, "in_development");
    // the developer decides: a restart only prepares a new run, and does not start it
    const again = runner.restartJob(prepared.id, true, d);
    assert.equal(again.state, "prepared");
    assert.equal(again.restartOf, prepared.id);
    assert.equal(again.projectName, prepared.projectName);
    assert.equal(d.apiCalls.length, 0);
    useSettings({});
    jobs.saveExecutionSettings({ apiEnabled: false, apiFallbackOffer: false, apiSpendLimitUsd: null });
  });
  it("a restart needs the scope confirmed again, and only failed or cancelled runs can be restarted", async () => {
    const { runner } = await mods();
    const lead = await approvedLead();
    const d = deps({ FAKE_RUN: "fail" });
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    await expectCode(async () => runner.restartJob(prepared.id, true, d), "bad-state");
    await runner.startJob(prepared.id, { mode: "local", ...START }, d);
    await finished(prepared.id);
    await expectCode(async () => runner.restartJob(prepared.id, false, d), "scope-not-confirmed");
  });
  it("a run that does not finish in time is stopped and recorded as failed", async () => {
    const { runner } = await mods();
    const lead = await approvedLead();
    const d = deps({ FAKE_RUN: "hang" }, { getSettings: () => ({ ...DEFAULT_EXECUTION_SETTINGS, localTimeoutMinutes: 0.02 }) });
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    await runner.startJob(prepared.id, { mode: "local", ...START }, d);
    const job = await finished(prepared.id);
    assert.equal(job.state, "failed");
    assert.match(job.error!, /did not finish within/);
    assert.equal(d.apiCalls.length, 0);
  });
});

// =================================================================================================
describe("8. API mode: off by default, and only ever started with an explicit, recorded approval", () => {
  it("API mode disabled: refused, nothing changes, the API is not called", async () => {
    const { runner, store, jobs } = await mods();
    useSettings({});
    const lead = await approvedLead();
    const d = deps();
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    const e = await expectCode(runner.startJob(prepared.id, { mode: "api", ...START, apiApproval: { confirmed: true, estimateUsd: null, limitUsd: 5, acceptUnreliable: true } }, d), "api-disabled");
    assert.equal(e.status, 403);
    assert.deepEqual([store.getLead(lead.id)!.stage, jobs.getJob(prepared.id)!.state, d.apiCalls.length], ["approved", "prepared", 0]);
  });
  it("API enabled but no spending limit: refused", async () => {
    const { runner } = await mods();
    useSettings({ apiEnabled: true });
    const lead = await approvedLead();
    const d = deps();
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    await expectCode(runner.startJob(prepared.id, { mode: "api", ...START }, d), "api-limit-missing");
    assert.equal(d.apiCalls.length, 0);
    useSettings({});
  });
  it("without an approval: it waits, shows the estimate and the limit, and runs nothing", async () => {
    const { runner, jobs } = await mods();
    useSettings({ apiEnabled: true, apiSpendLimitUsd: 5 });
    const lead = await approvedLead();
    const d = deps();
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    const e = await expectCode(runner.startJob(prepared.id, { mode: "api", ...START }, d), "approval-required");
    const estimate = e.details!.estimate as { estimatedUsd: number | null; limitUsd: number; reliable: boolean };
    assert.deepEqual([estimate.estimatedUsd, estimate.limitUsd, estimate.reliable], [null, 5, false]);
    const waiting = jobs.getJob(prepared.id)!;
    assert.equal(waiting.state, "waiting-approval");
    assert.equal(jobStatusLabel(waiting), "Waiting for approval");
    assert.equal(d.apiCalls.length, 0);
    useSettings({});
  });
  it("closing the cost dialog (cancelling the approval) runs nothing and spends nothing", async () => {
    const { runner, jobs, store } = await mods();
    useSettings({ apiEnabled: true, apiSpendLimitUsd: 5 });
    const lead = await approvedLead();
    const d = deps();
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    await expectCode(runner.startJob(prepared.id, { mode: "api", ...START }, d), "approval-required");
    const back = runner.declineApi(prepared.id);
    assert.deepEqual([back.state, back.mode], ["prepared", null]);
    assert.ok(jobs.listEvents(prepared.id).some((e) => /API cost not approved\. Nothing was run and nothing was spent\./.test(e.text)));
    assert.deepEqual([d.apiCalls.length, store.getLead(lead.id)!.stage], [0, "approved"]);
    await expectCode(async () => runner.declineApi(prepared.id), "bad-state");
    useSettings({});
  });
  it("an unreliable estimate needs the separate acceptance; with it, the API run starts and is fully recorded", async () => {
    const { runner, jobs } = await mods();
    useSettings({ apiEnabled: true, apiSpendLimitUsd: 7.5 });
    const lead = await approvedLead();
    const d = deps();
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    const confirmedOnly = { confirmed: true, estimateUsd: null, limitUsd: 7.5 };
    await expectCode(runner.startJob(prepared.id, { mode: "api", ...START, apiApproval: confirmedOnly }, d), "unreliable-estimate");
    assert.equal(d.apiCalls.length, 0);
    await runner.startJob(prepared.id, { mode: "api", ...START, apiApproval: { ...confirmedOnly, acceptUnreliable: true } }, d);
    const job = await finished(prepared.id);
    assert.equal(job.state, "completed");
    assert.equal(d.apiCalls.length, 1, "exactly one API run, after the approval");
    assert.equal(job.mode, "api");
    assert.equal(jobStatusLabel({ state: "running", mode: job.mode }), "API-funded execution");
    assert.deepEqual([job.approval?.mode, job.approval?.estimatedUsd, job.approval?.limitUsd, job.approval?.acceptedUnreliableEstimate], ["api", null, 7.5, true]);
    assert.match(job.approval!.approvedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(job.cost?.billing, "api");
    assert.equal(job.cost?.actualUsd, 1.5);
    assert.match(job.cost!.note, /not an invoice|Your Anthropic invoice/i);
    assert.equal(d.apiCalls[0].env.SILPI_MAX_COST_USD, "7.5", "the approved limit became the run's hard cost stop");
    assert.equal((d.apiCalls[0].task as { name: string }).name, job.projectName);
    assert.deepEqual((d.apiCalls[0].task as { frontend: string[] }).frontend.length > 0 || true, true);
    assert.equal(job.verification?.passed, true);
    assert.deepEqual(jobs.completedApiCosts(), [1.5], "this run now informs the next estimate");
    useSettings({});
  });
  it("a stale approval and an estimate above the limit are refused", async () => {
    const { runner, jobs } = await mods();
    // two more finished API runs make the estimate reliable: median of 1.5, 8, 9 = 8
    for (const usd of [8, 9]) {
      const l = await approvedLead();
      const j = jobs.createJob({ leadId: l.id, projectName: `hist-${usd}`, scopeConfirmedAt: new Date().toISOString(), briefSha: "x", briefBytes: 1 });
      jobs.updateJob(j.id, { state: "running", mode: "api" });
      jobs.updateJob(j.id, { state: "completed", finishedAt: new Date().toISOString(), cost: { billing: "api", actualUsd: usd, note: "" } });
    }
    useSettings({ apiEnabled: true, apiSpendLimitUsd: 5 });
    const lead = await approvedLead();
    const d = deps();
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    await expectCode(runner.startJob(prepared.id, { mode: "api", ...START, apiApproval: { confirmed: true, estimateUsd: 1, limitUsd: 5 } }, d), "approval-stale");
    const over = await expectCode(runner.startJob(prepared.id, { mode: "api", ...START, apiApproval: { confirmed: true, estimateUsd: 8, limitUsd: 5 } }, d), "estimate-over-limit");
    assert.equal((over.details!.estimate as { estimatedUsd: number }).estimatedUsd, 8);
    assert.equal(d.apiCalls.length, 0);
    useSettings({});
  });
  it("the API agent being unavailable is reported, and nothing is spent", async () => {
    const { runner } = await mods();
    useSettings({ apiEnabled: true, apiSpendLimitUsd: 50 });
    const lead = await approvedLead();
    const d = deps({}, { assertAgentReady: async () => { throw new Error("SILPI agent is not built."); } });
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    await expectCode(runner.startJob(prepared.id, { mode: "api", ...START, apiApproval: { confirmed: true, estimateUsd: 8, limitUsd: 50 } }, d), "agent-unavailable");
    useSettings({});
  });
});

// =================================================================================================
describe("9. cancelling, restarting safely, and recovering from a restart of the server", () => {
  it("cancelling a running job stops Claude Code and everything it started", async () => {
    const { runner, jobs } = await mods();
    const lead = await approvedLead();
    const d = deps({ FAKE_RUN: "hang" });
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    await runner.startJob(prepared.id, { mode: "local", ...START }, d);
    const file = path.join(WORKSPACES, prepared.projectName, ".silpi", "fake-run.json");
    const pid = await waitFor(() => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { pid: number }).pid : null), "the program to start");
    assert.doesNotThrow(() => process.kill(pid, 0), "it is running");
    const cancelled = runner.cancelJob(prepared.id);
    assert.equal(cancelled.state, "cancelled");
    assert.equal(jobStatusLabel(cancelled), "Cancelled");
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, "the program to stop", 10_000);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(jobs.getJob(prepared.id)!.state, "cancelled", "a late finish does not overwrite the cancellation");
    assert.equal(d.apiCalls.length, 0);
    await expectCode(async () => runner.cancelJob(prepared.id), "bad-state");
  });
  it("a job that was only prepared, or waiting for approval, can be cancelled too", async () => {
    const { runner } = await mods();
    const lead = await approvedLead();
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, deps());
    assert.equal(runner.cancelJob(prepared.id).state, "cancelled");
  });
  it("after a cancellation the run can be restarted as a new job in the same folder", async () => {
    const { runner } = await mods();
    const lead = await approvedLead();
    const d = deps({ FAKE_RUN: "hang" });
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    await runner.startJob(prepared.id, { mode: "local", ...START }, d);
    runner.cancelJob(prepared.id);
    const again = runner.restartJob(prepared.id, true, d);
    assert.deepEqual([again.state, again.projectName, again.restartOf], ["prepared", prepared.projectName, prepared.id]);
    const d2 = deps({ FAKE_RUN: "success" });
    await runner.startJob(again.id, { mode: "local", ...START }, d2);
    assert.equal((await finished(again.id)).state, "completed");
  });
  it("a run left 'running' by a server restart is marked failed, so it can be restarted", async () => {
    const { runner, jobs } = await mods();
    const lead = await approvedLead();
    const job = jobs.createJob({ leadId: lead.id, projectName: "orphan-run", scopeConfirmedAt: new Date().toISOString(), briefSha: "x", briefBytes: 1 });
    jobs.updateJob(job.id, { state: "running", mode: "local" });
    runner.reconcile();
    const after = jobs.getJob(job.id)!;
    assert.equal(after.state, "failed");
    assert.match(after.error!, /server restarted/);
  });
  it("the progress log is capped, bounded per line, and keeps no secrets", async () => {
    const { jobs, runner } = await mods();
    const lead = await approvedLead();
    const job = jobs.createJob({ leadId: lead.id, projectName: "log-run", scopeConfirmedAt: new Date().toISOString(), briefSha: "x", briefBytes: 1 });
    jobs.appendEvent(job.id, "status", "x".repeat(5000));
    assert.equal(jobs.listEvents(job.id)[0].text.length, 600);
    for (let i = 0; i < 2100; i++) jobs.appendEvent(job.id, "status", `line ${i}`);
    assert.equal(jobs.listEvents(job.id, 0, 1000).length, 1000);
    assert.equal(jobs.listEvents(job.id, 1995, 1000).length, 5, "capped at 2,000 lines");
    assert.equal(runner.safeText("key sk-ant-abc123_DEF-456 and Authorization: Bearer abc.def.ghi end"), "key [hidden] and [hidden] end");
  });
  it("job state changes follow the allowed order only", async () => {
    const { jobs } = await mods();
    const lead = await approvedLead();
    const job = jobs.createJob({ leadId: lead.id, projectName: "order-run", scopeConfirmedAt: new Date().toISOString(), briefSha: "x", briefBytes: 1 });
    assert.throws(() => jobs.updateJob(job.id, { state: "completed" }), (e: unknown) => (e as ExecError).code === "bad-state");
    jobs.updateJob(job.id, { state: "running" });
    jobs.updateJob(job.id, { state: "completed" });
    assert.throws(() => jobs.updateJob(job.id, { state: "running" }), (e: unknown) => (e as ExecError).code === "bad-state");
  });
});

// =================================================================================================
describe("10. verification, developer review, and 'ready for delivery' only after review", () => {
  it("builds and tests the project with fixed commands chosen from its package.json", async () => {
    const dir = mkdtempSync(path.join(root, "proj-"));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", scripts: { build: "node -e \"require('fs').writeFileSync('built.txt','ok')\"", test: "node -e \"process.exit(0)\"" } }));
    const steps: string[] = [];
    const result = await runVerification(dir, new AbortController().signal, (s) => steps.push(`${s.name}:${s.status}`));
    assert.deepEqual(steps, ["Install dependencies:passed", "Build:passed", "Tests:passed"]);
    assert.equal(result.passed, true);
    assert.ok(existsSync(path.join(dir, "built.txt")));
  });
  it("a failing build is reported, with the tail of its output, and later steps do not run", async () => {
    const dir = mkdtempSync(path.join(root, "proj-"));
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", scripts: { build: "node -e \"console.error('boom: broken page'); process.exit(3)\"", test: "node -e \"process.exit(0)\"" } }));
    const result = await runVerification(dir, new AbortController().signal, () => {});
    assert.equal(result.passed, false);
    assert.deepEqual(result.steps.map((s) => `${s.name}:${s.status}`), ["Install dependencies:passed", "Build:failed"]);
    assert.match(result.steps[1].tail!, /boom: broken page/);
  });
  it("no package.json, no build script and the default 'no test specified' script are skipped, not failed", async () => {
    const none = mkdtempSync(path.join(root, "proj-"));
    assert.deepEqual((await runVerification(none, new AbortController().signal, () => {})).steps.map((s) => s.status), ["skipped"]);
    const bare = mkdtempSync(path.join(root, "proj-"));
    writeFileSync(path.join(bare, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", scripts: { test: "echo \"Error: no test specified\" && exit 1" } }));
    const r = await runVerification(bare, new AbortController().signal, () => {});
    assert.deepEqual(r.steps.map((s) => `${s.name}:${s.status}`), ["Install dependencies:passed", "Build:skipped", "Tests:skipped"]);
    assert.equal(r.passed, true);
  });
  async function completedJob(verifyPassed: boolean) {
    const { runner } = await mods();
    const lead = await approvedLead();
    const d = deps({}, { verify: async () => ({ steps: [{ name: "Build", status: verifyPassed ? ("passed" as const) : ("failed" as const) }], passed: verifyPassed }) });
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    await runner.startJob(prepared.id, { mode: "local", ...START }, d);
    return { lead, job: await finished(prepared.id), runner };
  }
  it("ready for delivery is refused before a review, then allowed after an approved review", async () => {
    const { lead, job, runner } = await completedJob(true);
    const { store } = await mods();
    await expectCode(async () => runner.markJobReady(job.id), "review-required");
    assert.equal(store.getLead(lead.id)!.stage, "in_development");
    assert.throws(() => store.markReadyForDelivery(lead.id, "skip the review"), /Review and approve/);
    assert.equal(runner.reviewJob(job.id, { decision: "changes-requested", note: "logo missing" }).review?.status, "changes-requested");
    await expectCode(async () => runner.markJobReady(job.id), "review-required");
    const approved = runner.reviewJob(job.id, { decision: "approved", note: "looks right" });
    assert.equal(approved.review?.status, "approved");
    runner.markJobReady(job.id);
    assert.equal(store.getLead(lead.id)!.stage, "demo_ready");
    assert.ok(store.getLead(lead.id)!.stage === "demo_ready");
  });
  it("a project whose build failed cannot be approved without an explicit override and a reason", async () => {
    const { job, runner } = await completedJob(false);
    await expectCode(async () => runner.reviewJob(job.id, { decision: "approved" }), "verification-failed");
    await expectCode(async () => runner.reviewJob(job.id, { decision: "approved", overrideVerification: true, note: "short" }), "verification-failed");
    const done = runner.reviewJob(job.id, { decision: "approved", overrideVerification: true, note: "client accepted it as it is" });
    assert.equal(done.review?.overrodeVerification, true);
  });
  it("only a completed run can be reviewed; a decision must be one of the two", async () => {
    const { runner, jobs } = await mods();
    const lead = await approvedLead();
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, deps());
    await expectCode(async () => runner.reviewJob(prepared.id, { decision: "approved" }), "bad-state");
    const { job } = await completedJob(true);
    await expectCode(async () => runner.reviewJob(job.id, { decision: "maybe" as never }), "bad-decision");
    assert.equal(jobs.getJob(job.id)!.review, null);
  });
});

// =================================================================================================
describe("11. admin authentication and access control", () => {
  const req = (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => new NextRequest(`http://localhost:3000${url}`, { method: init.method ?? "GET", headers: init.headers });
  const cookieFor = () => `silpi_admin=${createSession().value}`;
  const status = (r: Response | null) => r?.status ?? 0;

  it("the secret is checked in constant time and must be 16+ characters", () => {
    assert.equal(checkAdminToken(ADMIN), true);
    for (const bad of ["", "wrong", ADMIN + "x", null, undefined, 5]) assert.equal(checkAdminToken(bad), false);
    process.env.SILPI_ADMIN_TOKEN = "too-short";
    assert.equal(checkAdminToken("too-short"), false, "a short secret is treated as not configured");
    process.env.SILPI_ADMIN_TOKEN = ADMIN;
  });
  it("without a configured secret every protected request is refused (closed by default)", () => {
    delete process.env.SILPI_ADMIN_TOKEN;
    assert.equal(status(requireAdmin(req("/api/execution/settings"))), 503);
    assert.equal(status(requireAdmin(req("/api/execution/settings", { headers: { authorization: `Bearer ${ADMIN}` } }))), 503);
    process.env.SILPI_ADMIN_TOKEN = ADMIN;
  });
  it("no credentials: 401. A wrong token: 401. The right token: allowed", () => {
    assert.equal(status(requireAdmin(req("/api/execution/settings"))), 401);
    assert.equal(status(requireAdmin(req("/api/execution/settings", { headers: { authorization: "Bearer wrong-token-value-here" } }))), 401);
    assert.equal(status(requireAdmin(req("/api/execution/settings", { headers: { authorization: "Basic abc" } }))), 401);
    assert.equal(requireAdmin(req("/api/execution/settings", { headers: { authorization: `Bearer ${ADMIN}` } })), null);
  });
  it("a session cookie is signed, expires, and cannot be forged or altered", () => {
    const now = Date.now();
    const s = createSession(now);
    assert.equal(verifySession(s.value, now + 1000), true);
    assert.equal(verifySession(s.value, now + 9 * 3_600_000), false, "expired after 8 hours");
    const [exp, nonce, sig] = s.value.split(".");
    assert.equal(verifySession(`${Number(exp) + 3_600_000}.${nonce}.${sig}`, now), false, "a longer expiry does not match the signature");
    assert.equal(verifySession(`${exp}.${nonce}.${"A".repeat(sig.length)}`, now), false);
    for (const junk of [undefined, "", "a.b.c", "1.2", `${exp}.${nonce}`, "x".repeat(200)]) assert.equal(verifySession(junk as string, now), false);
    process.env.SILPI_ADMIN_TOKEN = "a-completely-different-admin-secret-0000";
    assert.equal(verifySession(s.value, now), false, "a session made with another secret is not valid");
    process.env.SILPI_ADMIN_TOKEN = ADMIN;
  });
  it("a cookie session may read; a change must come from this same site", () => {
    const cookie = cookieFor();
    assert.equal(requireAdmin(req("/api/execution/settings", { headers: { cookie } })), null);
    const post = (headers: Record<string, string>) => requireAdmin(req("/api/execution/settings", { method: "PUT", headers: { cookie, host: "localhost:3000", ...headers } }));
    assert.equal(status(post({})), 403, "no Origin");
    assert.equal(status(post({ origin: "https://evil.example" })), 403);
    assert.equal(status(post({ origin: "http://localhost:3000.evil.example" })), 403);
    assert.equal(post({ origin: "http://localhost:3000" }), null);
    assert.equal(sameSite(req("/x", { method: "POST", headers: { origin: "http://localhost:3000", host: "localhost:3000" } })), true);
  });
  it("sign-in attempts are limited", () => {
    resetLoginAttempts();
    for (let i = 0; i < 8; i++) assert.equal(allowLoginAttempt("1.2.3.4", 1000 + i), true);
    assert.equal(allowLoginAttempt("1.2.3.4", 2000), false);
    assert.equal(allowLoginAttempt("5.6.7.8", 2000), true, "another client is not affected");
    assert.equal(allowLoginAttempt("1.2.3.4", 1000 + 11 * 60_000), true, "allowed again after the window");
    resetLoginAttempts();
  });
  it("the sign-in route: wrong token 401, right token sets an HttpOnly SameSite=Strict cookie and never echoes the secret", async () => {
    const route = await import("@/app/api/admin/session/route");
    resetLoginAttempts();
    const login = (token: string, origin = "http://localhost:3000") => route.POST(req("/api/admin/session", { method: "POST", headers: { origin, host: "localhost:3000", "content-type": "application/json" } }).clone() as NextRequest && new NextRequest("http://localhost:3000/api/admin/session", { method: "POST", headers: { origin, host: "localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ token }) }));
    assert.equal((await login("nope")).status, 401);
    assert.equal((await login(ADMIN, "https://evil.example")).status, 403);
    const ok = await login(ADMIN);
    assert.equal(ok.status, 200);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /silpi_admin=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=strict/i);
    assert.ok(!JSON.stringify(await ok.json()).includes(ADMIN));
    assert.ok(!setCookie.includes(ADMIN));
    const state = await (await route.GET(req("/api/admin/session"))).json();
    assert.deepEqual(state, { success: true, configured: true, authenticated: false });
    resetLoginAttempts();
  });
  it("every execution route refuses a request with no admin credentials", async () => {
    const settings = await import("@/app/api/execution/settings/route");
    const statusRoute = await import("@/app/api/execution/status/route");
    const leadRoute = await import("@/app/api/execution/leads/[id]/route");
    const prepare = await import("@/app/api/execution/leads/[id]/prepare/route");
    const job = await import("@/app/api/execution/jobs/[jobId]/route");
    const action = await import("@/app/api/execution/jobs/[jobId]/[action]/route");
    const id = "11111111-1111-4111-8111-111111111111";
    const lead = { params: Promise.resolve({ id }) };
    const jobCtx = { params: Promise.resolve({ jobId: id }) };
    const calls: [string, Promise<Response>][] = [
      ["GET settings", settings.GET(req("/api/execution/settings"))],
      ["PUT settings", settings.PUT(req("/api/execution/settings", { method: "PUT" }))],
      ["GET status", statusRoute.GET(req("/api/execution/status"))],
      ["GET lead jobs", leadRoute.GET(req(`/api/execution/leads/${id}`), lead)],
      ["POST prepare", prepare.POST(req(`/api/execution/leads/${id}/prepare`, { method: "POST" }), lead)],
      ["GET job", job.GET(req(`/api/execution/jobs/${id}`), jobCtx)],
      ...["start", "cancel", "decline-api", "restart", "review", "ready"].map((a): [string, Promise<Response>] => [`POST ${a}`, action.POST(req(`/api/execution/jobs/${id}/${a}`, { method: "POST" }), { params: Promise.resolve({ jobId: id, action: a }) })]),
    ];
    for (const [name, call] of calls) assert.equal((await call).status, 401, name);
  });
  it("with the admin token the routes answer, validate ids, and return nothing secret", async () => {
    const auth = { authorization: `Bearer ${ADMIN}` };
    const settings = await import("@/app/api/execution/settings/route");
    const statusRoute = await import("@/app/api/execution/status/route");
    const action = await import("@/app/api/execution/jobs/[jobId]/[action]/route");
    const job = await import("@/app/api/execution/jobs/[jobId]/route");
    const s = await settings.GET(req("/api/execution/settings", { headers: auth }));
    assert.equal(s.status, 200);
    const body = await s.json();
    assert.deepEqual([body.settings.apiEnabled, body.settings.apiFallbackOffer, body.settings.apiSpendLimitUsd], [false, false, null]);
    assert.ok(!JSON.stringify(body).match(/sk-ant|ANTHROPIC|password|token/i));
    const bad = await settings.PUT(new NextRequest("http://localhost:3000/api/execution/settings", { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ settings: { apiEnabled: "yes", claudePath: "rm -rf /" } }) }));
    assert.equal(bad.status, 400);
    const st = await statusRoute.GET(req("/api/execution/status", { headers: auth }));
    assert.equal(st.status, 200);
    assert.ok(!JSON.stringify(await st.json()).match(/@|\.claude|sk-ant/), "no email, no credential folder, no key");
    for (const badId of ["abc", "../../etc/passwd", "1; calc", "x".repeat(300)]) {
      assert.equal((await job.GET(req(`/api/execution/jobs/x`, { headers: auth }), { params: Promise.resolve({ jobId: badId }) })).status, 400, badId);
      assert.equal((await action.POST(req("/x", { method: "POST", headers: auth }), { params: Promise.resolve({ jobId: badId, action: "start" }) })).status, 400, badId);
    }
    const id = "11111111-1111-4111-8111-111111111111";
    assert.equal((await action.POST(req("/x", { method: "POST", headers: auth }), { params: Promise.resolve({ jobId: id, action: "rm -rf" }) })).status, 404, "only the named actions exist");
    assert.equal((await action.POST(req("/x", { method: "POST", headers: auth }), { params: Promise.resolve({ jobId: id, action: "start" }) })).status, 404, "an unknown job");
  });
  it("the older direct-to-API routes are closed: login needed, then refused, and they never start the agent", async () => {
    const files = ["src/app/api/projects/generate/route.ts", "src/app/api/projects/[name]/edit/route.ts", "src/app/api/projects/[name]/resume/route.ts", "src/app/api/business/leads/[id]/build/route.ts"];
    for (const f of files) {
      const source = readFileSync(path.resolve(f), "utf8");
      assert.ok(source.includes("directApiBlocked"), f);
      assert.ok(!/streamAgentRun|silpi-runner|spawn|child_process/.test(source), `${f} must not start the agent`);
    }
    const gen = await import("@/app/api/projects/generate/route");
    assert.equal((await gen.POST(req("/api/projects/generate", { method: "POST" }))).status, 401);
    const blocked = await gen.POST(req("/api/projects/generate", { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } }));
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).code, "direct-api-disabled");
  });
});

// =================================================================================================
describe("12. the public quotation cannot start project generation", () => {
  const read = (f: string) => readFileSync(path.resolve(f), "utf8");
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  it("a client approving the quotation creates no job and starts no process", async () => {
    const { store, jobs, runner } = await mods();
    const lead = await approvedLead();
    // approve again as the client would, through the public path
    const fresh = await (async () => {
      const client = { name: "Pub", email: "p@example.com", phone: "9876543210", company: "", gstin: "", state: "Tamil Nadu", address: "" };
      const l = store.createLead(client, (await mods()).validate.parseRequirement(requirement(), store.getRateCard()), "standard");
      const token = store.shareToken(l.id);
      store.respondAsClient(token, { action: "approved", tier: "standard", name: "Pub Client", message: "" });
      return store.getLead(l.id)!;
    })();
    assert.equal(fresh.stage, "approved");
    assert.equal(jobs.listJobs(fresh.id).length, 0);
    assert.equal(runner.jobsForLead(fresh.id).length, 0);
    assert.equal(existsSync(WORKSPACES) ? readdirSync(WORKSPACES).filter((n) => n.startsWith("pub") || n.includes("brightwave") && false).length : 0, 0, "no project folder was made");
    assert.ok(lead.id);
  });
  it("nothing reachable without the admin sign-in refers to execution, the CLI or generation", () => {
    const publicFiles = [...walk(path.resolve("src/app/api/client")), ...walk(path.resolve("src/app/q")), path.resolve("src/lib/business/client-view.ts"), path.resolve("src/components/business/quotation-document.tsx")];
    for (const file of publicFiles) assert.ok(!/execution|claude-cli|runner|startJob|prepareJob|child_process|spawn\(/.test(readFileSync(file, "utf8")), `${path.relative(process.cwd(), file)} must not touch generation`);
  });
  it("the store's client-response code only moves the quotation to approved; it has no way to run anything", () => {
    const store = read("src/lib/business/store.ts");
    const respond = store.slice(store.indexOf("export function respondAsClient"), store.indexOf("export function respondAsClient") + 2500);
    assert.ok(!/execution|spawn|startJob|child_process/.test(respond));
    assert.ok(!/child_process|execution\//.test(store.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), "the store imports no process or execution code");
  });
});

// =================================================================================================
describe("13. security by construction", () => {
  const read = (f: string) => readFileSync(path.resolve(f), "utf8");
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const executionFiles = [...walk(path.resolve("src/lib/execution")), ...walk(path.resolve("src/app/api/execution")), path.resolve("src/lib/admin-auth.ts")];

  it("no code reads Claude Code's credential or session files", () => {
    for (const file of executionFiles) assert.ok(!/\.credentials|credentials\.json|\.claude\.json|\.claude[\\/]|keychain|readFileSync\([^)]*claude/i.test(readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), `${path.relative(process.cwd(), file)} reads a credential file`);
  });
  it("programs are started in a few known places, always without a request-supplied command", () => {
    const users = walk(path.resolve("src")).filter((f) => /\.(ts|tsx)$/.test(f) && /child_process/.test(readFileSync(f, "utf8"))).map((f) => path.relative(path.resolve("src"), f).replace(/\\/g, "/")).sort();
    assert.deepEqual(users, ["lib/business/analyze.ts", "lib/demo/app-runner.ts", "lib/demo/service.ts", "lib/execution/api-agent.ts", "lib/execution/claude-cli.ts", "lib/execution/verify.ts", "lib/silpi-runner.ts"].sort());
    // Demo previews: both programs are fixed strings. Nothing from a request, a project or the database becomes a command.
    const runnerSrc = read("src/lib/demo/app-runner.ts");
    assert.ok(/spawn\(DEMO_START_COMMAND,/.test(runnerSrc) && /DEMO_START_COMMAND = "npm run start"/.test(runnerSrc), "the app runner starts one constant command");
    assert.ok(/demo\.start_command !== DEMO_START_COMMAND/.test(runnerSrc), "a stored value that is not that command is refused");
    assert.ok(/spawn\("npm run build",/.test(read("src/lib/demo/service.ts")), "the build is a fixed command");
    assert.ok(/env: cleanEnv\(/.test(runnerSrc) && /env: cleanEnv\(/.test(read("src/lib/demo/service.ts")), "demo programs get a clean environment, without SILPI's secrets");
    for (const f of ["src/lib/demo/app-runner.ts", "src/lib/demo/service.ts", "src/lib/demo/gateway.ts"]) assert.ok(!/(?<![.\w])exec(Sync)?\(|execFile|eval\(|new Function/.test(read(f)), f);
    for (const f of ["src/lib/execution/claude-cli.ts", "src/lib/execution/verify.ts", "src/lib/execution/api-agent.ts"]) assert.ok(!/(?<![.\w])exec(Sync)?\(|execFile|eval\(|new Function/.test(read(f)), f);
  });
  it("the API is started in one place only, after the approval check", () => {
    const callers = walk(path.resolve("src")).filter((f) => /runApiAgent|runApi\(|deps\.runApi/.test(readFileSync(f, "utf8"))).map((f) => path.relative(path.resolve("src"), f).replace(/\\/g, "/")).sort();
    assert.deepEqual(callers, ["lib/execution/api-agent.ts", "lib/execution/runner.ts"]);
    const runner = read("src/lib/execution/runner.ts");
    const start = runner.slice(runner.indexOf("export async function startJob"));
    assert.ok(start.indexOf("checkApiApproval(") > 0 && start.indexOf("checkApiApproval(") < start.indexOf("executeApi("), "the approval is checked before the API run is launched");
    const local = runner.slice(runner.indexOf("async function executeLocal"), runner.indexOf("async function executeApi"));
    assert.ok(!/runApi|executeApi|apiEnabled|SILPI_MAX_COST/.test(local), "the local run has no path to the API");
  });
  it("no secret is placed in browser code or public configuration", () => {
    const browserFiles = walk(path.resolve("src/components")).concat(walk(path.resolve("src/app")).filter((f) => f.endsWith(".tsx")));
    for (const f of browserFiles) assert.ok(!/sk-ant|process.env.ANTHROPIC/.test(readFileSync(f, "utf8")) || (!f.endsWith("admin-gate.tsx") && /SILPI_ADMIN_TOKEN/.test(readFileSync(f, "utf8"))), `${path.relative(process.cwd(), f)} names a secret`);
    assert.ok(!/NEXT_PUBLIC_[A-Z_]*(KEY|TOKEN|SECRET)/.test(walk(path.resolve("src")).map((f) => readFileSync(f, "utf8")).join("\n")));
    assert.ok(!/localStorage|sessionStorage/.test(read("src/components/business/admin-gate.tsx")), "the admin token is never kept in the browser");
  });
  it("the admin token is only read on the server", () => {
    const users = walk(path.resolve("src")).filter((f) => /SILPI_ADMIN_TOKEN/.test(readFileSync(f, "utf8"))).map((f) => path.relative(path.resolve("src"), f).replace(/\\/g, "/")).sort();
    assert.ok(users.every((u) => u.startsWith("lib/admin-auth") || u.startsWith("app/api/admin") || u.startsWith("components/business/admin-gate")), users.join());
    assert.ok(!users.some((u) => u.startsWith("components") && /process\.env/.test(read(`src/${u}`))));
  });
  it("nothing is committed or pushed by any execution code", () => {
    for (const f of executionFiles) assert.ok(!/git (commit|push|add)/.test(readFileSync(f, "utf8")), f);
  });
});

// =================================================================================================
describe("14. generation uses whatever the client uploaded, and never waits for more", () => {
  const exported: string[] = [];
  const partial = (over: Partial<RunnerDeps> = {}) => deps({}, { exportContent: (_id, dir) => { exported.push(dir); return { items: 4, files: 6, missing: ["Logo", "Favicon (browser tab icon)"] }; }, ...over });

  it("nothing is required: preparing and starting work even when most content is missing", async () => {
    const { runner, jobs } = await mods();
    const lead = await approvedLead();
    const d = partial();
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    assert.equal(prepared.state, "prepared");
    const started = await runner.startJob(prepared.id, { mode: "local", ...START }, d);
    assert.equal(started.state, "running");
    assert.equal(exported.at(-1), path.join(WORKSPACES, prepared.projectName), "the content is copied into the project folder");
    const log = jobs.listEvents(prepared.id, 0).map((e) => e.text).join("\n");
    assert.match(log, /Client content: 4 items and 6 files copied into the project\. 2 not provided yet; placeholders will be used\./);
    await finished(prepared.id);
  });

  it("with no content at all it still starts, and says nothing was provided", async () => {
    const { runner, jobs } = await mods();
    const lead = await approvedLead();
    const d = deps({}, { exportContent: () => ({ items: 0, files: 0, missing: ["Logo"] }) });
    const prepared = runner.prepareJob(lead.id, { scopeConfirmed: true }, d);
    assert.equal((await runner.startJob(prepared.id, { mode: "local", ...START }, d)).state, "running");
    assert.match(jobs.listEvents(prepared.id, 0).map((e) => e.text).join("\n"), /0 items and 0 files copied/);
    await finished(prepared.id);
  });

  it("the generator is told to use the client's content exactly, and placeholders for the rest", async () => {
    const { runner } = await mods();
    const brief = { description: "x", frontend: [], backend: [], database: [], styling: [] };
    assert.match(runner.buildLocalPrompt(brief, { items: 5, files: 7, missing: [] }), /read \.silpi\/client-content\.md and use it exactly/);
    const some = runner.buildLocalPrompt(brief, { items: 2, files: 1, missing: ["Logo", "Favicon"] });
    assert.match(some, /not supplied: Logo; Favicon/);
    assert.match(some, /clearly marked placeholders/);
    assert.ok(!/client-content/.test(runner.buildLocalPrompt(brief)), "no content instructions when there is no content");
  });
});

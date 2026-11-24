import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { contentItemCount, exportContent, type ContentExport } from "@/lib/business/asset-store";
import { buildBrief, projectNameFor } from "@/lib/business/brief";
import { getLead, getRateCard, markReadyForDelivery, StageError, startDevelopment } from "@/lib/business/store";
import type { Lead } from "@/lib/business/types";
import type { AgentEvent } from "@/types";
import { assertAgentReady } from "@/lib/silpi-runner";

import { checkApiApproval, estimateApiCost } from "./api-gate";
import { runApiAgent, type ApiOutcome } from "./api-agent";
import { localArgs, locateClaude, readAuth, runClaude, type ClaudeEvent, type ClaudeLocation, type LocateResult, type RunClaudeOptions, type RunClaudeResult } from "./claude-cli";
import { activeJobFor, appendEvent, completedApiCosts, createJob, getExecutionSettings, getJob, interruptOrphans, listEvents, listJobs, updateJob } from "./jobs";
import { ExecError, type ApiApprovalRequest, type AuthState, type ExecMode, type ExecutionSettings, type Job, type JobEvent, type Verification, type VerificationStep } from "./types";
import { runVerification } from "./verify";
import { sliceDesignImages } from "./design-images";
import { renderSite, type RenderResult } from "./render";
import { prepareWorkspace, resolveWorkspace, verifyJobWorkspace, workspaceRoot, type BriefPayload } from "./workspace";

/**
 * Project generation workflow (server-only).
 *
 *   prepare  -> the developer confirmed the approved scope; the folder and the brief are ready
 *   start    -> the developer chose Local Claude Code (default) or, with a separate cost approval, the API
 *   running  -> output is streamed into the job log; it can be cancelled
 *   finished -> tests and build ran; the developer reviews; only then can it be marked ready for delivery
 *
 * A failed local run NEVER starts an API run. The only path to the API is `startJob` with mode "api" and a valid approval.
 */

export type ApiRunInput = { task: Record<string, unknown>; env: NodeJS.ProcessEnv; signal: AbortSignal; onEvent: (event: AgentEvent) => void };

export type RunnerDeps = {
  env: NodeJS.ProcessEnv;
  getSettings: () => ExecutionSettings;
  locate: (settings: ExecutionSettings) => LocateResult;
  readAuth: (location: ClaudeLocation, env: NodeJS.ProcessEnv) => Promise<AuthState>;
  runClaude: (options: RunClaudeOptions) => Promise<RunClaudeResult>;
  runApi: (input: ApiRunInput) => Promise<ApiOutcome>;
  verify: (dir: string, signal: AbortSignal, onStep: (step: VerificationStep) => void) => Promise<Verification>;
  assertAgentReady: () => Promise<unknown>;
  workspaceRoot: () => string | null;
  /** How many content items the client (or the team for them) has uploaded. */
  contentCount: (leadId: string) => number;
  /** Copies the client's content into the project folder for the generator to use. */
  exportContent: (leadId: string, dir: string) => ContentExport;
  /** Pictures of the built site (desktop and phone), for the design check. Null when it cannot be done here. */
  render?: (dir: string, signal: AbortSignal) => Promise<RenderResult | null>;
  /** Cuts very tall design pictures into readable parts; returns the list of pictures the generator should open. */
  sliceDesign?: (dir: string, design: string[]) => Promise<string[]>;
};

export const realDeps = (): RunnerDeps => ({
  env: process.env,
  getSettings: getExecutionSettings,
  locate: (s) => locateClaude(s),
  readAuth,
  runClaude,
  runApi: runApiAgent,
  verify: (dir, signal, onStep) => runVerification(dir, signal, onStep),
  assertAgentReady,
  workspaceRoot: () => workspaceRoot(),
  contentCount: contentItemCount,
  exportContent,
  render: (dir, signal) => renderSite(dir, signal),
  sliceDesign: sliceDesignImages,
});

// ---- processes that are running now (survives hot reloads) -----------------------------------------------

const registry = globalThis as unknown as { silpiLiveJobs?: Map<string, AbortController> };
const live = () => (registry.silpiLiveJobs ??= new Map<string, AbortController>());

/** Jobs marked running whose process is gone (a server restart) are marked failed so they can be restarted. */
export function reconcile(): void {
  interruptOrphans((id) => live().has(id));
}

/** Keep secrets and long output out of anything stored or shown. */
export const safeText = (text: string, max = 400): string =>
  text.replace(/sk-ant-[\w-]+/g, "[hidden]").replace(/(authorization:\s*)?bearer\s+[\w.-]+/gi, "[hidden]").replace(/\s+/g, " ").trim().slice(0, max);

// "testing" and "demo_ready" are included so a finished project can be built again when the client sends more content.
const STAGES_FOR_GENERATION = ["approved", "advance_paid", "in_development", "testing", "demo_ready"];

// ---- 1. prepare ---------------------------------------------------------------------------------------------

/**
 * A project is built from the client's own content, so there has to be some before anything is prepared or started. Partial is fine:
 * what is missing becomes a placeholder. Nothing at all is refused.
 */
function assertHasContent(leadId: string, deps: RunnerDeps): void {
  if (deps.contentCount(leadId) > 0) return;
  throw new ExecError("content-needed", "Collect the client's files first. Upload at least one file or some content (partial is fine), then generate the project.", 409);
}

export function prepareJob(leadId: string, options: { scopeConfirmed: boolean; restartOf?: string }, deps: RunnerDeps = realDeps()): Job {
  reconcile();
  const lead = getLead(leadId);
  if (!lead || !lead.quotation) throw new ExecError("lead-not-found", "That project or its quotation does not exist.", 404);
  if (!STAGES_FOR_GENERATION.includes(lead.stage)) {
    throw new ExecError("bad-stage", "Generation can start only after the client approves the quotation.", 409);
  }
  if (options.scopeConfirmed !== true) {
    throw new ExecError("scope-not-confirmed", "Confirm the approved scope before the workspace is prepared.", 400);
  }
  const existing = activeJobFor(leadId);
  if (existing && !options.restartOf) return existing;
  assertHasContent(leadId, deps);
  if (existing && options.restartOf) throw new ExecError("busy", "Another run for this project is still active.", 409);

  const root = deps.workspaceRoot();
  if (!root) throw new ExecError("no-workspace-root", "The projects folder is not configured. Set SILPI_AGENT_DIR (or SILPI_WORKSPACE_DIR) in frontend-2/.env.local.", 409);

  const previous = options.restartOf ? getJob(options.restartOf) : null;
  if (options.restartOf && (!previous || previous.leadId !== leadId)) throw new ExecError("job-not-found", "The run to restart does not exist.", 404);
  const req = lead.quotation.requirement ?? lead.requirement;
  const projectName = previous?.projectName ?? lead.projectName ?? projectNameFor(req.title, randomBytes(2).toString("hex"));

  // The brief is what the client approved: the same code that always produced it.
  const brief: BriefPayload = buildBrief(lead, getRateCard());
  const prepared = prepareWorkspace({ root, name: projectName, brief, allowExisting: Boolean(previous || lead.projectName) });
  const job = createJob({ leadId, projectName, scopeConfirmedAt: new Date().toISOString(), briefSha: prepared.briefSha, briefBytes: prepared.briefBytes, restartOf: options.restartOf ?? null });
  appendEvent(job.id, "status", `Scope confirmed. Workspace "${projectName}" and the approved brief (${prepared.briefBytes} bytes) are ready.${previous ? " This restarts an earlier run." : ""}`);
  return job;
}

// ---- 2. start -------------------------------------------------------------------------------------------------------

/** Local Claude Code must be installed and signed in with a subscription. Never falls back to anything else. */
export async function assertLocalReady(settings: ExecutionSettings, deps: RunnerDeps): Promise<ClaudeLocation> {
  const found = deps.locate(settings);
  if (!found.location) {
    throw new ExecError("cli-missing", found.problem ?? "Claude Code was not found on this computer. Install it, sign in with claude auth login, then try again. SILPI does not switch to the API by itself.", 409);
  }
  const auth = await deps.readAuth(found.location, deps.env);
  if (auth.kind === "authenticated-subscription") return found.location;
  const code = auth.kind === "not-authenticated" ? "not-authenticated" : auth.kind === "authenticated-api-key" ? "api-key-auth" : "auth-unknown";
  throw new ExecError(code, `${auth.message} SILPI does not switch to the API by itself.`, 409);
}

export type StartInput = { mode: ExecMode; withoutAdvance?: boolean; reason?: string; apiApproval?: ApiApprovalRequest };

export async function startJob(jobId: string, input: StartInput, deps: RunnerDeps = realDeps()): Promise<Job> {
  reconcile();
  const job = getJob(jobId);
  if (!job) throw new ExecError("job-not-found", "That job does not exist.", 404);
  if (job.state !== "prepared" && job.state !== "waiting-approval") throw new ExecError("bad-state", `This job is "${job.state}" and cannot be started.`, 409);
  if (input.mode !== "local" && input.mode !== "api") throw new ExecError("bad-mode", "Choose Local Claude Code or the Anthropic API.", 400);

  const lead = getLead(job.leadId);
  if (!lead || !lead.quotation) throw new ExecError("lead-not-found", "That project or its quotation does not exist.", 404);
  if (!STAGES_FOR_GENERATION.includes(lead.stage)) throw new ExecError("bad-stage", "Generation can start only after the client approves the quotation.", 409);

  const settings = deps.getSettings();
  const others = listJobs(job.leadId).filter((j) => j.id !== job.id && j.state === "running");
  if (others.length) throw new ExecError("busy", "Another run for this project is already running.", 409);

  // Every check below happens BEFORE anything changes, so a refusal leaves the project exactly as it was.
  let location: ClaudeLocation | undefined;
  let approval = null as Job["approval"];
  if (input.mode === "local") {
    location = await assertLocalReady(settings, deps);
  } else {
    if (!settings.apiEnabled) throw new ExecError("api-disabled", "API execution is turned off. Turn on API mode in Execution settings first, or use Local Claude Code.", 403);
    const estimate = estimateApiCost(completedApiCosts(), settings.apiSpendLimitUsd);
    try {
      approval = checkApiApproval(settings, estimate, input.apiApproval);
    } catch (e) {
      if (e instanceof ExecError && e.code === "approval-required" && job.state === "prepared") {
        updateJob(job.id, { state: "waiting-approval", mode: "api" });
        appendEvent(job.id, "status", "Waiting for the developer to approve the API cost.");
      }
      throw e;
    }
    await deps.assertAgentReady().catch((e: Error) => {
      throw new ExecError("agent-unavailable", e.message, 409);
    });
  }
  const root = deps.workspaceRoot();
  if (!root) throw new ExecError("no-workspace-root", "The projects folder is not configured.", 409);
  const { dir, brief } = verifyJobWorkspace(root, job.projectName, job.briefSha);

  // Whatever the client uploaded goes into the project; the rest gets placeholders. With nothing uploaded, nothing starts.
  assertHasContent(lead.id, deps);
  const exported = deps.exportContent(lead.id, dir);
  const content = exported.design?.length && deps.sliceDesign ? { ...exported, design: await deps.sliceDesign(dir, exported.design) } : exported;

  // The same advance-payment rules as before apply when the work starts.
  try {
    // A project that is already built (testing or demo ready) is being rebuilt: its stage does not move backwards.
    if (lead.stage !== "testing" && lead.stage !== "demo_ready") startDevelopment(lead.id, { withoutAdvance: input.withoutAdvance === true, reason: typeof input.reason === "string" ? input.reason.slice(0, 300) : "", suffix: "", nameFor: () => job.projectName });
  } catch (e) {
    if (e instanceof StageError) throw new ExecError("advance-required", e.message, 409);
    throw e;
  }

  const started = updateJob(job.id, { state: "running", mode: input.mode, phase: "generating", startedAt: new Date().toISOString(), finishedAt: null, error: null, approval });
  appendEvent(job.id, "status", input.mode === "local" ? "Started: local subscription execution (Claude Code on this computer)." : `Started: API-funded execution, approved up to $${approval!.limitUsd.toFixed(2)}.`);

  const placeholders = content.missing.length ? ` ${content.missing.length} not provided yet; placeholders will be used.` : "";
  appendEvent(job.id, "status", `Client content: ${content.items} item${content.items === 1 ? "" : "s"} and ${content.files} file${content.files === 1 ? "" : "s"} copied into the project.${placeholders}`);
  if (content.design?.length) {
    const cut = exported.design && content.design.length !== exported.design.length;
    appendEvent(job.id, "status", `Design reference: ${content.design.length} picture${content.design.length === 1 ? "" : "s"} will be followed${cut ? " (long pictures were cut into readable parts)" : ""}.`);
  } else {
    appendEvent(job.id, "status", "No design reference was uploaded, so the website gets a generic modern design. Upload the design under Client files, Design, to make it look like a specific design.");
  }

  const controller = new AbortController();
  live().set(job.id, controller);
  void (input.mode === "local" ? executeLocal(started, dir, brief, location!, settings, controller.signal, deps, content) : executeApi(started, dir, brief, settings, controller.signal, deps)).finally(() => live().delete(job.id));
  return started;
}

// ---- local run --------------------------------------------------------------------------------------------------------

/** The look every generated site must have: current design practice, applied with the client's own brand. */
export const DESIGN_STANDARD: string[] = [
  "Design standard (the site must look like a modern, premium product made this year, never like a template or a 2015 website):",
  "- Use the client's brand colours and fonts as design tokens (CSS variables). If none were supplied, choose one refined palette: a confident primary, a neutral scale, one accent, with AA contrast.",
  "- Layout: mobile-first and fully responsive; a clear grid; generous whitespace; bento-style card grids and asymmetric sections where they help; sticky, slightly translucent header with a clear primary call to action; a strong hero with a real headline, supporting text and two actions.",
  "- Type: a large, expressive heading scale using fluid sizes (clamp), tight tracking on headings, comfortable line length and line height for body text; at most two font families.",
  "- Surfaces: rounded corners, soft layered shadows, subtle gradients or glass effects used sparingly, consistent 8px spacing, consistent icon set (no emoji as icons).",
  "- Motion: small, purposeful micro-interactions (hover, focus, scroll-reveal) with CSS or IntersectionObserver, and respect prefers-reduced-motion.",
  "- Support light and dark appearance where the brand allows, via prefers-color-scheme and the same tokens.",
  "- Quality: semantic HTML, visible focus states, alt text, optimised images (next/image for Next.js), no layout shift, empty/loading/error states for every data view, and real-looking sample data (never lorem ipsum) clearly marked as sample.",
  "- Everything must be visible and aligned: text and icons need at least 4.5:1 contrast against their background (never blue icons on a blue bar), and grids fill their rows with no empty cells or uneven edges.",
  "- Every page has a distinct, finished layout; do not repeat one template across pages. Dashboards and portals use a clean sidebar or top-nav shell, data tables with filters, and clear status badges.",
];

/**
 * What the agent does with a design reference. A reference built from only by glancing at it comes out about 60% complete, so the
 * work is split: list EVERYTHING in the reference first, build every item of that list, then check the list against the reference.
 */
export function designRules(design: string[]): string[] {
  return [
    "DESIGN REFERENCE: the client chose a design. Reproduce it completely. Building only part of it is a failure.",
    `- The reference images: ${design.join(", ")}. Open every one with the Read tool and study it in full before writing any code. Each file is a page or a screen (its name says which); a phone-sized image, if given, is the phone layout.`,
    "- Files named like `name-part-01.png`, `name-part-02.png` are consecutive slices of ONE long page picture: open them in order and treat them together as that one page, top to bottom (each slice starts a little above where the previous one ended, so do not count the overlap twice).",
    "- Step 1, before any code: write `.silpi/design-spec.md`, a numbered inventory of the reference from top to bottom. For every section list every element: each line of text, link, icon, button, badge, rating, form field, picture and logo; the layout (columns, order, alignment, spacing, card sizes, how cards of different heights fit together); the colours; the fonts (name any script or display font and pick the closest Google Font). Be exhaustive: the utility bar with its links and social icons, navigation items with their dropdown arrows, the hero, promotional banners, product carousels with ratings and badges, brand strips, newsletter, every footer column, payment icons, the back-to-top button.",
    "- Step 2: build every numbered item. Nothing in the spec may be skipped, merged or simplified. Keep the reference's layout and proportions. Grids and masonry layouts must fill their rows: use explicit CSS grid areas so no cell is left empty or uneven.",
    "- Words and pages: use the client's real content and the brief's pages for texts and menu labels. Where the reference shows something the client has not supplied, keep the element and fill it with clearly marked sample text; a picture that was not supplied becomes a plain placeholder box with the same size and position as in the reference. Never drop a section.",
    "- Everything must be visible: text and icons need enough contrast against their background (never blue icons on a blue bar).",
    "- Step 3, before you finish: open the reference again and go through `.silpi/design-spec.md` item by item. Write `.silpi/design-checklist.md` marking each item done, with the file it is built in, and fix every item that is not done before you end.",
  ];
}

/** The second pass: a fresh look at the reference against what was built, to fill whatever the first pass left out. */
export function buildDesignReviewPrompt(design: string[]): string {
  return [
    "A website was just built in this folder from a design reference. Your only job now is to find what is missing or wrong compared with the reference, and fix it.",
    `Open each reference image (${design.join(", ")}) with the Read tool, then read .silpi/design-spec.md and the site's source files.`,
    "Go through the reference section by section, from the top. For every element confirm that it exists in the code with the right text, icon, position, size and colour. Look especially for: elements that are missing; sections in the wrong order; grids with empty cells or wrong proportions; links, icons, badges or buttons that are absent; low contrast (invisible icons or text); sections that were simplified.",
    "Write the result in `.silpi/design-checklist.md` as numbered items marked done, fixed, or not possible (with the reason). Fix every item that is not done. Do not remove or redesign anything that already matches the reference.",
    "Then run the build once, as one simple command such as `npm --prefix frontend run build` (never chained, never with cd), and fix any error you caused. Work only inside this folder.",
    "Finish with one short paragraph: how many items were missing and what you fixed.",
  ].join("\n");
}

/** The check with real pictures: the page as it looks now, set beside the reference. This is what finds overlaps, gaps and wrong sizes. */
export function buildVisualReviewPrompt(design: string[], shots: string[]): string {
  return [
    "A website was just built in this folder from a design reference, and it was started and photographed. Your only job now is to compare the real page with the reference, and fix every difference.",
    `Open the reference images (${design.join(", ")}) and the pictures of the built site (${shots.join(", ")}) with the Read tool. Also read .silpi/design-spec.md.`,
    "Compare them section by section, from the top, as a person would put the two pictures side by side. Write down every difference: a section or element that is missing; a card or banner that is missing from a grid; empty areas where the reference shows a picture (each needs a visible placeholder box of the same size); a different layout, order, proportion or alignment; text, icons or buttons that are hidden, cut off, overlapping or covered by something (a hover-only bar must stay hidden until hover); headings, text or buttons that are much larger or smaller than in the reference; links, icons, badges, ratings, carousel dots, social icons or payment icons that are absent; colours that are different without a reason; low contrast.",
    "Where the client's brand colours or fonts are given in .silpi/client-content.md they win; everything else follows the reference. The reference's words are only sample text: keep the client's own content and the brief's pages.",
    "Write the list in `.silpi/design-checklist.md` as numbered items marked fixed or not possible (with the reason), and fix every item. Do not remove or redesign anything that already matches the reference.",
    "Then run the build once, as one simple command such as `npm --prefix frontend run build` (never chained, never with cd), and fix any error you caused. Work only inside this folder.",
    "Finish with one short paragraph: how many differences you found and what you fixed.",
  ].join("\n");
}

export function buildLocalPrompt(brief: BriefPayload, content?: { items: number; files: number; missing: string[]; design?: string[] }, changes = false): string {
  const tech = [
    brief.frontend.length ? `frontend ${brief.frontend.join(", ")}` : "",
    brief.backend.length ? `backend ${brief.backend.join(", ")}` : "",
    brief.database.length ? `database ${brief.database.join(", ")}` : "",
    brief.styling.length ? `styling ${brief.styling.join(", ")}` : "",
  ].filter(Boolean);
  return [
    "You are building a client project in the current folder.",
    "Read .silpi/brief.md first. It is the approved scope of an accepted quotation.",
    "",
    "Rules:",
    "- Build exactly what the brief lists. Do not build anything under \"Do NOT build\".",
    tech.length ? `- Use exactly this technology and no other: ${tech.join("; ")}.` : "- Use the technology named in the brief.",
    ...(content && content.items > 0
      ? ["- The client supplied their original content: read .silpi/client-content.md and use it exactly (their wording, logo, favicon and images from .silpi/client-assets). Copy the files you need into the site; do not invent replacements for anything they supplied. If it lists brand colours and fonts, use them as the site's palette and typography (define them once as CSS variables and load the fonts as described)."]
      : []),
    ...(content && content.missing.length > 0 ? [`- These required items were not supplied: ${content.missing.join("; ")}. Use clearly marked placeholders for them, never invented real-looking content.`] : []),
    ...(changes ? ["- This project already exists in this folder. Read .silpi/change-request.md: the developer reviewed the earlier result and asked for those changes. Apply them to the existing code, keep everything else, and do not start over."] : []),
    ...(content?.design?.length ? designRules(content.design) : []),
    ...DESIGN_STANDARD,
    "- Build with ONE simple command per step, run from this folder, for example `npm --prefix frontend run build`. Never chain commands with ; or &&, never use cd or Set-Location, and never pipe the output: chained commands are refused and then the build is never verified.",
    "- Never hard-code a port in package.json scripts (no `next start -p 3000`, no `--port 3000`): servers must read the port from the PORT environment variable, because the site is started on a port chosen at run time.",
    "- Work only inside this folder. Never write real secrets: use a .env.example with placeholders.",
    "- Install dependencies, run the build (and the tests if the project has them), and fix every error you caused before you finish.",
    "- Include a README.md (what it is, the stack, how to run it) and a .gitignore.",
    "- When you are done, answer with one short plain-text paragraph about what you built, then how to run it and anything you could not verify.",
  ].join("\n");
}

const eventKind = (e: ClaudeEvent): JobEvent["kind"] => (e.kind === "result" ? "result" : e.kind === "action" ? "action" : e.kind === "message" ? "message" : "status");

function finish(jobId: string, patch: Parameters<typeof updateJob>[1]): void {
  const current = getJob(jobId);
  if (!current || current.state === "cancelled" || current.state === "completed" || current.state === "failed") return; // already decided (for example cancelled)
  updateJob(jobId, { phase: null, finishedAt: new Date().toISOString(), ...patch });
}

async function executeLocal(job: Job, dir: string, brief: BriefPayload, location: ClaudeLocation, settings: ExecutionSettings, signal: AbortSignal, deps: RunnerDeps, content?: ContentExport): Promise<void> {
  try {
    const onEvent = (e: ClaudeEvent) => { if (e.kind !== "ignore") appendEvent(job.id, eventKind(e), e.text); };
    const out = await deps.runClaude({
      location,
      cwd: dir,
      prompt: buildLocalPrompt(brief, content, existsSync(path.join(dir, CHANGE_REQUEST_FILE)) && readFileSync(path.join(dir, CHANGE_REQUEST_FILE), "utf8").trim().length > 0),
      args: localArgs(settings.localMaxTurns),
      env: deps.env,
      timeoutMs: settings.localTimeoutMinutes * 60_000,
      signal,
      onEvent,
    });
    if (out.cancelled || signal.aborted) return;
    if (out.spawnError) return finish(job.id, { state: "failed", error: "Claude Code could not be started on this computer.", exitCode: out.exitCode });
    if (out.timedOut) return finish(job.id, { state: "failed", error: `Claude Code did not finish within ${settings.localTimeoutMinutes} minutes and was stopped.`, exitCode: out.exitCode });
    if (out.exitCode !== 0 || out.result?.ok === false) {
      const detail = safeText(out.result?.text || out.stderrTail || "");
      appendEvent(job.id, "error", `Claude Code stopped with exit code ${out.exitCode ?? "unknown"}.${detail ? ` ${detail}` : ""}`);
      // A failure stays a failure. SILPI does not try the API; the developer decides what to do next.
      return finish(job.id, { state: "failed", error: `Claude Code stopped with exit code ${out.exitCode ?? "unknown"}.${detail ? ` ${detail}` : ""}`, exitCode: out.exitCode });
    }
    const logStep = (step: VerificationStep) => appendEvent(job.id, step.status === "failed" ? "error" : "status", `${step.name}: ${step.status}${step.note ? ` (${safeText(step.note, 120)})` : ""}`);
    updateJob(job.id, { phase: "verifying" });
    appendEvent(job.id, "status", "Claude Code finished. Building and testing the project.");
    let verification = await deps.verify(dir, signal, logStep);
    if (signal.aborted) return;

    // With a design reference, the real page is photographed and compared with the reference, and whatever was left out or looks
    // wrong is fixed. Without a browser the same check reads the code against the reference.
    if (content?.design?.length) {
      const shots = verification.passed && deps.render ? await deps.render(dir, signal) : null;
      if (signal.aborted) return;
      appendEvent(job.id, "status", shots?.files.length ? "Built. Comparing the real page with the design reference and filling any gaps." : "Checking the build against the design reference and filling any gaps.");
      updateJob(job.id, { phase: "generating" });
      const review = await deps.runClaude({
        location,
        cwd: dir,
        prompt: shots?.files.length ? buildVisualReviewPrompt(content.design, shots.files) : buildDesignReviewPrompt(content.design),
        args: localArgs(Math.min(settings.localMaxTurns, 40)),
        env: deps.env,
        timeoutMs: settings.localTimeoutMinutes * 60_000,
        signal,
        onEvent,
      });
      if (review.cancelled || signal.aborted) return;
      // The first build already works, so a check that fails does not fail the job: it says so and the team reviews as usual.
      if (review.spawnError || review.timedOut || review.exitCode !== 0 || review.result?.ok === false) {
        appendEvent(job.id, "error", "The design check did not finish. The first build is kept; compare the site with the reference before approving.");
      }
      // The fixes must still build and pass.
      updateJob(job.id, { phase: "verifying" });
      appendEvent(job.id, "status", "Building and testing again after the design fixes.");
      verification = await deps.verify(dir, signal, logStep);
      if (signal.aborted) return;
    }
    finish(job.id, {
      state: "completed",
      exitCode: out.exitCode,
      verification,
      cost: { billing: "subscription", ...(out.result?.notionalUsd !== undefined ? { notionalUsd: out.result.notionalUsd } : {}), note: "Covered by your Claude subscription. No API charge." },
      result: { summary: safeText(out.result?.text ?? "", 800), filesChanged: out.filesChanged.length, turns: out.result?.turns },
    });
    appendEvent(job.id, "result", verification.passed ? "Completed. The project builds. Review it before marking it ready." : "Completed, but the build or tests failed. Review the project before going on.");
  } catch (e) {
    finish(job.id, { state: "failed", error: safeText((e as Error).message) });
  }
}

// ---- API run (only ever reached with a recorded approval) ------------------------------------------------------------------

async function executeApi(job: Job, dir: string, brief: BriefPayload, settings: ExecutionSettings, signal: AbortSignal, deps: RunnerDeps): Promise<void> {
  try {
    const limit = job.approval?.limitUsd ?? settings.apiSpendLimitUsd ?? 0;
    let lastTurn = 0;
    const out = await deps.runApi({
      task: { mode: "create", name: job.projectName, ...brief, designUrl: "", attachments: [] },
      // The approved limit becomes the agent's own hard cost stop.
      env: { ...deps.env, SILPI_MAX_COST_USD: String(limit) },
      signal,
      onEvent: (e) => {
        if (e.type === "status") appendEvent(job.id, "status", e.message);
        else if (e.type === "message") appendEvent(job.id, "message", e.text);
        else if (e.type === "action") appendEvent(job.id, "action", e.label);
        else if (e.type === "result" && !e.ok) appendEvent(job.id, "status", `${e.label} failed`);
        else if (e.type === "usage" && e.turn - lastTurn >= 5) { lastTurn = e.turn; appendEvent(job.id, "status", `Turn ${e.turn}: $${e.totalCostUsd.toFixed(2)} so far (limit $${limit.toFixed(2)}).`); }
        else if (e.type === "error") appendEvent(job.id, "error", e.message);
      },
    });
    if (out.cancelled || signal.aborted) return;
    const cost = { billing: "api" as const, ...(out.costUsd !== undefined ? { actualUsd: out.costUsd } : {}), note: "Calculated by the SILPI agent from token usage. Your Anthropic invoice is the billed amount." };
    if (!out.ok) return finish(job.id, { state: "failed", error: safeText(out.error ?? "The SILPI agent did not finish."), exitCode: out.exitCode ?? null, cost });
    const steps: VerificationStep[] = [
      { name: "Build (SILPI agent)", status: out.buildPassed === null || out.buildPassed === undefined ? "skipped" : out.buildPassed ? "passed" : "failed" },
      { name: "App start check", status: out.appStarted === null || out.appStarted === undefined ? "skipped" : out.appStarted ? "passed" : "failed" },
    ];
    finish(job.id, {
      state: "completed",
      exitCode: out.exitCode ?? 0,
      cost,
      verification: { steps, passed: !steps.some((s) => s.status === "failed") },
      result: { summary: safeText(out.summary ?? "", 800), filesChanged: out.filesChanged, turns: out.turns },
    });
    appendEvent(job.id, "result", "Completed. Review the project before marking it ready.");
  } catch (e) {
    finish(job.id, { state: "failed", error: safeText((e as Error).message) });
  }
}

// ---- cancel, decline, restart -------------------------------------------------------------------------------------------------

export function cancelJob(jobId: string): Job {
  reconcile();
  const job = getJob(jobId);
  if (!job) throw new ExecError("job-not-found", "That job does not exist.", 404);
  if (job.state === "completed" || job.state === "failed" || job.state === "cancelled") throw new ExecError("bad-state", `This job is already ${job.state}.`, 409);
  live().get(jobId)?.abort();
  const cancelled = updateJob(jobId, { state: "cancelled", phase: null, finishedAt: new Date().toISOString(), error: "Cancelled by the developer." });
  appendEvent(jobId, "status", "Cancelled by the developer.");
  return cancelled;
}

/** The developer closed the API cost dialog without approving: nothing runs and nothing is spent. */
export function declineApi(jobId: string): Job {
  const job = getJob(jobId);
  if (!job) throw new ExecError("job-not-found", "That job does not exist.", 404);
  if (job.state !== "waiting-approval") throw new ExecError("bad-state", "There is no API approval waiting for this job.", 409);
  appendEvent(jobId, "status", "API cost not approved. Nothing was run and nothing was spent.");
  return updateJob(jobId, { state: "prepared", mode: null });
}

/** Always added when a finished project is built again: the client may have uploaded more since. */
const REFRESH_NOTE = "The client's content may have been added to or changed since the last run. Read .silpi/client-content.md again. Wherever a page, section, logo or image was a placeholder and real content now exists, replace the placeholder with it. Pages that were built from earlier content must follow the updated content.";

/** Where the developer's requested changes are written, inside the project folder, for the next run to read. */
export const CHANGE_REQUEST_FILE = path.join(".silpi", "change-request.md");

export function restartJob(jobId: string, scopeConfirmed: boolean, deps: RunnerDeps = realDeps(), changes?: string): Job {
  reconcile();
  const job = getJob(jobId);
  if (!job) throw new ExecError("job-not-found", "That job does not exist.", 404);
  // A finished run can be built again: with requested changes, or because the client added or changed content.
  const rebuild = job.state === "completed";
  const applyChanges = rebuild && job.review?.status === "changes-requested";
  if (job.state !== "failed" && job.state !== "cancelled" && !rebuild) {
    throw new ExecError("bad-state", "Only a failed, cancelled or finished run can be started again.", 409);
  }
  const asked = (typeof changes === "string" && changes.trim() ? changes : job.review?.note ?? "").trim().slice(0, 2000);
  if (applyChanges && asked.length < 3) throw new ExecError("note-required", "Describe the changes you want so they can be applied.", 400);
  const wanted = rebuild ? [asked, REFRESH_NOTE].filter(Boolean).join("\n\n") : asked;
  const next = prepareJob(job.leadId, { scopeConfirmed, restartOf: job.id }, deps);
  if (rebuild) {
    // The requested changes travel with the project folder; the next run reads them (see buildLocalPrompt).
    const root = deps.workspaceRoot();
    if (root) {
      const dir = resolveWorkspace(root, job.projectName);
      mkdirSync(path.join(dir, ".silpi"), { recursive: true });
      writeFileSync(path.join(dir, CHANGE_REQUEST_FILE), `# Changes requested by the developer\n\n${wanted}\n`, "utf8");
      appendEvent(next.id, "status", applyChanges ? "Requested changes and the latest client content will be applied to the existing project in this run." : "The latest client content will be applied to the existing project in this run.");
    }
  }
  return next;
}

// ---- 3. review, then ready for delivery ----------------------------------------------------------------------------------------------

export function reviewJob(jobId: string, input: { decision: "approved" | "changes-requested"; note?: string; overrideVerification?: boolean }): Job {
  const job = getJob(jobId);
  if (!job) throw new ExecError("job-not-found", "That job does not exist.", 404);
  if (job.state !== "completed") throw new ExecError("bad-state", "Only a completed run can be reviewed.", 409);
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : "";
  if (input.decision !== "approved" && input.decision !== "changes-requested") throw new ExecError("bad-decision", "Choose approve or request changes.", 400);
  const failedChecks = job.verification && !job.verification.passed;
  if (input.decision === "approved" && failedChecks) {
    if (input.overrideVerification !== true || note.length < 10) {
      throw new ExecError("verification-failed", "The build or tests failed. Fix the project, or approve anyway with a note of at least 10 characters explaining why.", 409);
    }
  }
  if (input.decision === "changes-requested" && note.length < 3) throw new ExecError("note-required", "Describe the changes you want so they can be applied.", 400);
  appendEvent(jobId, "status", input.decision === "approved" ? "Developer review: approved." : "Developer review: changes requested.");
  return updateJob(jobId, { review: { status: input.decision, at: new Date().toISOString(), note, ...(input.decision === "approved" && failedChecks ? { overrodeVerification: true } : {}) } });
}

export function markJobReady(jobId: string): { job: Job } {
  const job = getJob(jobId);
  if (!job) throw new ExecError("job-not-found", "That job does not exist.", 404);
  if (job.state !== "completed" || job.review?.status !== "approved") throw new ExecError("review-required", "Review and approve the generated project before it can be marked ready for delivery.", 409);
  try {
    markReadyForDelivery(job.leadId, `Generated project reviewed and approved (job ${job.id.slice(0, 8)})`);
  } catch (e) {
    if (e instanceof StageError) throw new ExecError("bad-stage", e.message, 409);
    throw e;
  }
  appendEvent(jobId, "status", "Marked ready for delivery.");
  return { job: getJob(jobId)! };
}

// ---- reading ---------------------------------------------------------------------------------------------------------------------------------

export function jobWithEvents(jobId: string, after = 0): { job: Job; events: JobEvent[] } {
  reconcile();
  const job = getJob(jobId);
  if (!job) throw new ExecError("job-not-found", "That job does not exist.", 404);
  return { job, events: listEvents(jobId, after) };
}

export function jobsForLead(leadId: string): Job[] {
  reconcile();
  return listJobs(leadId);
}

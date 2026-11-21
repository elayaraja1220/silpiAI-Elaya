import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import http from "node:http";

import { getLead } from "@/lib/business/store";
import { ValidationError } from "@/lib/business/validate";
import { assertContained, resolveWorkspace, workspaceRoot } from "@/lib/execution/workspace";
import { ExecError } from "@/lib/execution/types";

import { cleanEnv, startApp, stopApp } from "./app-runner";
import { detectProject, hasBuildScript } from "./detect";
import { readEnvValues, resolveStatic, scanForSecrets } from "./files";
import { gatewayStatus, startGateway } from "./gateway";
import { crawlSite, snapshotSite, staticFetcher, type PageFetch } from "./snapshot";
import {
  clientDemoFor, clientLink, demoPort, getDemo, insertDemo, isLocalBase, listDemosForLead, listLiveDemos, parseReport, previewLink, publicBase, purgeLeadDemos, removeDemoFiles, revokeDemo, siteDir, statusOf,
  type DemoReport, type DemoRow, type DemoStatus,
} from "./store";

/** Creating, listing and stopping demos (server-only). */

export const MAX_LIVE_PER_LEAD = 3;

export type DemoView = {
  id: string; leadId: string; label: string; mode: "static" | "app"; framework: string; projectName: string;
  status: DemoStatus; createdAt: string; expiresAt: string; views: number; lastViewAt: string | null;
  protected: boolean; showToClient: boolean; url: string; previewUrl: string; report: DemoReport;
};

export function toView(row: DemoRow): DemoView {
  const port = gatewayStatus().port ?? demoPort();
  return {
    id: row.id, leadId: row.lead_id, label: row.label, mode: row.mode === "app" ? "app" : "static", framework: row.framework, projectName: row.project_name,
    status: statusOf(row), createdAt: row.created_at, expiresAt: row.expires_at, views: row.views, lastViewAt: row.last_view_at,
    protected: row.password_hash !== "", showToClient: row.show_to_client === 1, url: clientLink(row), previewUrl: previewLink(row, port), report: parseReport(row.report),
  };
}

export type CreateOptions = { days?: unknown; password?: unknown; label?: unknown; showToClient?: unknown };

export type DemoDeps = {
  workspaceRoot: () => string | null;
  /** Builds the project when nothing is built yet. */
  build: (dir: string) => Promise<{ ok: boolean; message: string }>;
};

/** `npm run build` in a clean environment (no SILPI secrets), with a time limit. */
export function runBuild(dir: string, timeoutMs = 5 * 60_000): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    let tail = "";
    const child = spawn("npm run build", { cwd: dir, shell: true, windowsHide: true, env: cleanEnv({}), stdio: ["ignore", "pipe", "pipe"] });
    const keep = (c: Buffer) => { tail = (tail + c.toString("utf8")).slice(-600); };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, message: "The build took longer than 5 minutes and was stopped." }); }, timeoutMs);
    child.once("error", (e) => { clearTimeout(timer); resolve({ ok: false, message: e.message }); });
    child.once("exit", (code) => { clearTimeout(timer); resolve({ ok: code === 0, message: tail.trim() }); });
  });
}

export const realDemoDeps = (): DemoDeps => ({ workspaceRoot: () => workspaceRoot(), build: runBuild });

/** Reads pages of a running app over HTTP (for the link check). */
function httpFetcher(port: number): PageFetch {
  return (urlPath) =>
    new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: urlPath, headers: { "accept-encoding": "identity" }, timeout: 10_000 }, (res) => {
        const type = String(res.headers["content-type"] ?? "");
        const html = /html/i.test(type);
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => { size += c.length; if (html && size < 2 * 1024 * 1024) chunks.push(c); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, type, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(null));
    });
}

function readOptions(options: CreateOptions, defaultLabel: string) {
  const days = options.days === undefined || options.days === "" ? 7 : Number(options.days);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new ValidationError("The demo can stay open for 1 to 30 days.");
  const password = typeof options.password === "string" ? options.password.trim() : "";
  if (password && (password.length < 4 || password.length > 64)) throw new ValidationError("The password must be 4 to 64 characters, or leave it empty.");
  const label = (typeof options.label === "string" && options.label.trim() ? options.label.trim() : defaultLabel).replace(/[\u0000-\u001f]/g, "").slice(0, 80);
  if (!label) throw new ValidationError("Give the demo a name.");
  return { days, password, label, showToClient: options.showToClient !== false };
}

/**
 * Makes a private, expiring demo of a lead's generated project. Static sites are copied (only the built output, secrets replaced,
 * checked for keys); sites that need a server are started on demand. Every internal link is followed and the broken ones reported.
 */
export async function createDemo(leadId: string, options: CreateOptions, deps: DemoDeps = realDemoDeps()): Promise<DemoView> {
  const lead = getLead(leadId);
  if (!lead) throw new ValidationError("That project was not found.");
  if (!lead.projectName) throw new ValidationError("Generate the project first. There is nothing to show yet.");
  const opts = readOptions(options, lead.client.company || lead.client.name);
  if (listDemosForLead(leadId).filter((d) => statusOf(d) === "live").length >= MAX_LIVE_PER_LEAD) {
    throw new ValidationError(`This project already has ${MAX_LIVE_PER_LEAD} live demos. Stop an old one first.`);
  }

  const root = deps.workspaceRoot();
  if (!root) throw new ValidationError("The projects folder is not configured.");
  let dir: string;
  try {
    dir = resolveWorkspace(root, lead.projectName);
    if (!existsSync(dir)) throw new ValidationError("The project folder was not found on this computer.");
    assertContained(root, dir);
  } catch (e) {
    if (e instanceof ExecError) throw new ValidationError(e.message);
    throw e;
  }

  let found = detectProject(dir);
  if (found.mode === "none" && hasBuildScript(dir)) {
    const built = await deps.build(dir);
    if (!built.ok) throw new ValidationError(`The project could not be built for the demo. ${built.message.slice(-300)}`.trim());
    found = detectProject(dir);
  }
  if (found.mode === "none") throw new ValidationError(found.reason);

  const id = randomUUID();
  const base: DemoReport = { framework: found.framework, files: 0, bytes: 0, redactions: 0, warnings: [], pages: 0, broken: [], unverified: [], truncated: false, checked: true };

  if (found.mode === "static") {
    const dest = siteDir(id);
    try {
      const copy = snapshotSite(found.outputDir, dest, readEnvValues(dir));
      if (resolveStatic(dest, "/").kind !== "file") throw new ValidationError("The built website has no home page (index.html).");
      const hits = scanForSecrets(dest);
      const blocking = hits.filter((h) => h.severity === "block");
      if (blocking.length) {
        const what = [...new Set(blocking.map((h) => `${h.kind} in ${h.file}`))].slice(0, 4).join("; ");
        throw new ValidationError(`The demo was not created because the website contains ${what}. Remove it, build again, and try again.`);
      }
      const crawl = await crawlSite(staticFetcher(dest, found.spa));
      const report: DemoReport = {
        ...base, files: copy.files, bytes: copy.bytes, redactions: copy.redactions, pages: crawl.pages, broken: crawl.broken, unverified: crawl.unverified, truncated: crawl.truncated,
        warnings: [...hits.filter((h) => h.severity === "warn").map((h) => `${h.file} has ${h.kind}.`), ...(copy.redactions ? [`${copy.redactions} private value${copy.redactions === 1 ? "" : "s"} from the project's .env file were replaced with a placeholder.`] : [])],
      };
      const row = insertDemo({ id, leadId, label: opts.label, mode: "static", framework: found.framework, projectName: lead.projectName, spa: found.spa, password: opts.password, showToClient: opts.showToClient, days: opts.days, report });
      await startGateway();
      return toView(row);
    } catch (error) {
      removeDemoFiles(id);
      throw error;
    }
  }

  // A framework that needs a running server: start it privately, check it, leave it to start again on demand.
  const entry = { id, app_dir: dir, start_command: found.startCommand };
  try {
    const port = await startApp(entry, { timeoutMs: 120_000 });
    const crawl = await crawlSite(httpFetcher(port), 150);
    const report: DemoReport = {
      ...base, pages: crawl.pages, broken: crawl.broken, unverified: crawl.unverified, truncated: crawl.truncated,
      warnings: ["This site runs as an app. It was started with demo settings only (no real keys), but its files cannot be scanned for secrets like a static site."],
    };
    const row = insertDemo({ id, leadId, label: opts.label, mode: "app", framework: found.framework, projectName: lead.projectName, spa: false, appDir: dir, startCommand: found.startCommand, password: opts.password, showToClient: opts.showToClient, days: opts.days, report });
    await startGateway();
    return toView(row);
  } catch (error) {
    stopApp(id);
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`The app could not be started for the demo: ${(error as Error).message}`);
  }
}

/** Stops a demo: the link stops working at once, the app stops, the copy is deleted. */
export function stopDemo(id: string): DemoView {
  const row = getDemo(id);
  if (!row) throw new ValidationError("That demo was not found.");
  revokeDemo(id);
  stopApp(id);
  if (row.mode === "static") rmSync(siteDir(id), { recursive: true, force: true });
  return toView(getDemo(id)!);
}

/** A lead is deleted: its demos stop and their copies go. */
export function removeLeadDemos(leadId: string): void {
  for (const row of listDemosForLead(leadId)) stopApp(row.id);
  purgeLeadDemos(leadId);
}

/** What a client may be shown about their demo. Only when the link can actually be opened from outside this computer. */
export function clientDemoInfo(leadId: string): { url: string; expiresAt: string; protected: boolean } | null {
  const row = clientDemoFor(leadId);
  if (!row || isLocalBase(publicBase())) return null;
  return { url: clientLink(row), expiresAt: row.expires_at, protected: row.password_hash !== "" };
}

export const demosOfLead = (leadId: string): DemoView[] => listDemosForLead(leadId).map(toView);
export const liveDemos = (): DemoView[] => listLiveDemos().map(toView);

export function overview() {
  const status = gatewayStatus();
  const base = publicBase(status.port ?? undefined);
  return { gateway: status, publicBase: base, local: isLocalBase(base), port: status.port ?? demoPort() };
}

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEMO_START_COMMAND, startApp, stopApp } from "@/lib/demo/app-runner";

import { appDirOf } from "./app-dir";
import { killTree } from "./claude-cli";

/**
 * Takes real screenshots of a built site (server-only), so the design check can compare the page as it actually looks with
 * the design reference, not only its code. The site is started the same private way a demo is (a free local port, a clean
 * environment, stopped afterwards) and a headless browser saves a picture of it. Nothing here is sent anywhere.
 * If there is no browser, or the site has no start script, it says nothing and the check falls back to reading the code.
 */

export type RenderResult = { /** Paths inside the project folder. */ files: string[] };

const CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/** A Chrome, Edge or Chromium on this computer: the one named in SILPI_CHROME_PATH, or a standard location. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env): string | null {
  const own = env.SILPI_CHROME_PATH;
  if (own && path.isAbsolute(own) && /(chrome|chromium|msedge)(\.exe)?$/i.test(own) && existsSync(own)) return own;
  const local = env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")] : [];
  return [...local, ...CANDIDATES].find((p) => existsSync(p)) ?? null;
}

/** Fixed arguments only. The address is always this computer, the size and file are made here. */
export function screenshotArgs(profile: string, url: string, out: string, width: number, height: number): string[] {
  return ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, `--window-size=${Math.trunc(width)},${Math.trunc(height)}`, "--virtual-time-budget=12000", `--screenshot=${out}`, url];
}

function runBrowser(browser: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(browser, args, { shell: false, windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => killTree(child), timeoutMs);
    const onAbort = () => killTree(child);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    const end = (ok: boolean) => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(ok); };
    child.once("error", () => end(false));
    child.once("exit", (code) => end(code === 0));
  });
}

const SHOTS = [
  { name: "desktop.png", width: 1440, height: 4200 },
  { name: "phone.png", width: 390, height: 3200 },
] as const;

/** Pictures of the home page on a computer and on a phone, saved in `.silpi/render/`. Null when it cannot be done. */
export async function renderSite(projectDir: string, signal: AbortSignal, browser: string | null = findBrowser()): Promise<RenderResult | null> {
  if (!browser) return null;
  const appDir = appDirOf(projectDir);
  try {
    const pkg = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8")) as { scripts?: { start?: unknown } };
    if (typeof pkg.scripts?.start !== "string") return null;
  } catch {
    return null;
  }
  const outDir = path.join(projectDir, ".silpi", "render");
  mkdirSync(outDir, { recursive: true });
  const profile = mkdtempSync(path.join(tmpdir(), "silpi-render-"));
  const id = `render-${randomUUID()}`;
  const files: string[] = [];
  try {
    const port = await startApp({ id, app_dir: appDir, start_command: DEMO_START_COMMAND }, { timeoutMs: 90_000 });
    if (signal.aborted) return null;
    for (const shot of SHOTS) {
      const out = path.join(outDir, shot.name);
      rmSync(out, { force: true });
      await runBrowser(browser, screenshotArgs(profile, `http://127.0.0.1:${port}/`, out, shot.width, shot.height), 60_000, signal);
      if (existsSync(out) && statSync(out).size > 1000) files.push(`.silpi/render/${shot.name}`);
    }
    return files.length ? { files } : null;
  } catch {
    return files.length ? { files } : null;
  } finally {
    stopApp(id);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold a file for a moment */ }
  }
}

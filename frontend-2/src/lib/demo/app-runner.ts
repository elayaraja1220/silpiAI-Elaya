import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";

import type { DemoRow } from "./store";

/**
 * Frameworks that need a running server (Next.js, Nuxt, SvelteKit, Remix, Express...) are started privately, one process per demo,
 * on a port only this computer can reach. They start when the first visitor arrives and stop when nobody has looked for a while,
 * and only a few run at once, so many demos can exist without many processes running. (server-only)
 */

export const MAX_RUNNING_APPS = 3;
/** The only command a demo ever runs. It is a constant: nothing from a request or from the database is run as a command. */
export const DEMO_START_COMMAND = "npm run start";
export const IDLE_STOP_MS = 20 * 60 * 1000;
const START_TIMEOUT_MS = 90_000;

type Running = { child: ChildProcess | null; port: number; lastUsed: number; ready: Promise<number>; failed?: string };
const registry = globalThis as unknown as { silpiDemoApps?: Map<string, Running>; silpiDemoSweep?: NodeJS.Timeout };
const apps = () => (registry.silpiDemoApps ??= new Map<string, Running>());

/** The environment a demo app gets: the basics it needs to run, and none of SILPI's own secrets. */
export function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "COMSPEC", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "WINDIR", "LANG"];
  const env: Record<string, string | undefined> = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, NODE_ENV: "production", CI: "1", WEB3FORMS_ACCESS_KEY: "demo-disabled", SITE_URL: "http://localhost", ...extra } as NodeJS.ProcessEnv;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let exited = false;
    child.once("exit", () => { exited = true; });
    const attempt = () => {
      if (exited) return reject(new Error("The demo app stopped while starting."));
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error("The demo app did not start in time."));
        else setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

/** Stops a process and everything it started (on Windows a shell leaves children behind otherwise). */
export function killTree(child: ChildProcess | null): void {
  if (!child || !child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

export function stopApp(id: string): void {
  const running = apps().get(id);
  if (!running) return;
  apps().delete(id);
  killTree(running.child);
}
export function stopAllApps(): void { for (const id of [...apps().keys()]) stopApp(id); }
export const runningAppIds = (): string[] => [...apps().keys()];
export const touchApp = (id: string): void => { const r = apps().get(id); if (r) r.lastUsed = Date.now(); };

function sweep(): void {
  const cutoff = Date.now() - IDLE_STOP_MS;
  for (const [id, r] of apps()) if (r.lastUsed < cutoff) stopApp(id);
}
function ensureSweeper(): void {
  if (registry.silpiDemoSweep) return;
  registry.silpiDemoSweep = setInterval(sweep, 60_000);
  registry.silpiDemoSweep.unref();
  process.once("exit", stopAllApps);
}

/**
 * Starts the demo's app if it is not running. Resolves with its port once it accepts connections. If the machine is already
 * running the maximum, the one used longest ago is stopped first.
 */
export function startApp(demo: Pick<DemoRow, "id" | "app_dir" | "start_command">, opts: { timeoutMs?: number } = {}): Promise<number> {
  if (demo.start_command !== DEMO_START_COMMAND) return Promise.reject(new Error("This demo has no valid start command."));
  const existing = apps().get(demo.id);
  if (existing && !existing.failed) { existing.lastUsed = Date.now(); return existing.ready; }
  if (existing?.failed) apps().delete(demo.id);
  ensureSweeper();

  while (apps().size >= MAX_RUNNING_APPS) {
    const oldest = [...apps().entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    stopApp(oldest[0]);
  }

  // Registered before anything is awaited, so a second visitor arriving at the same moment waits for this start.
  const entry: Running = { child: null, port: 0, lastUsed: Date.now(), ready: Promise.resolve(0) };
  apps().set(demo.id, entry);
  entry.ready = (async () => {
    const port = await freePort();
    entry.port = port;
    const child = spawn(DEMO_START_COMMAND, {
      cwd: demo.app_dir,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: "ignore",
      env: cleanEnv({ PORT: String(port), HOST: "127.0.0.1", HOSTNAME: "127.0.0.1" }),
    });
    entry.child = child;
    child.once("exit", () => { if (apps().get(demo.id) === entry) apps().delete(demo.id); });
    await waitForPort(port, child, opts.timeoutMs ?? START_TIMEOUT_MS);
    return port;
  })().catch((error: Error) => {
    entry.failed = error.message;
    if (apps().get(demo.id) === entry) stopApp(demo.id);
    throw error;
  });
  return entry.ready;
}

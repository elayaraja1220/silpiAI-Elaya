import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { appDirOf } from "./app-dir";
import { killTree, scrubbedEnv } from "./claude-cli";
import type { Verification, VerificationStep } from "./types";

/**
 * After a project is generated, SILPI builds it and runs its tests itself (server-only).
 * Only three fixed commands are ever run, chosen from what the project's package.json defines.
 * Nothing the browser sends reaches a command line, and API keys are removed from the environment.
 */

type Timeouts = { install: number; build: number; test: number };
const DEFAULT_TIMEOUTS: Timeouts = { install: 15 * 60_000, build: 10 * 60_000, test: 10 * 60_000 };

function runNpm(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal): Promise<{ code: number | null; tail: string; timedOut: boolean; error?: string }> {
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    let tail = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ code, tail: tail.trim().slice(-600), timedOut, ...(error ? { error } : {}) });
    };
    // Fixed arguments only; the command shell is needed on Windows for npm.cmd.
    const child = spawn(win ? "npm.cmd" : "npm", args, { cwd, shell: win, env: scrubbedEnv(env), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const onAbort = () => killTree(child);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    const keep = (d: Buffer) => { tail = (tail + d.toString("utf8")).slice(-2000); };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code));
  });
}

export async function runVerification(
  dir: string,
  signal: AbortSignal,
  onStep: (step: VerificationStep) => void,
  env: NodeJS.ProcessEnv = process.env,
  timeouts: Timeouts = DEFAULT_TIMEOUTS,
): Promise<Verification> {
  const steps: VerificationStep[] = [];
  const add = (step: VerificationStep) => { steps.push(step); onStep(step); };

  // A full-stack project keeps its website in a sub-folder such as frontend/: build that one.
  const root = dir;
  dir = appDirOf(root);
  if (dir !== root) add({ name: "Website folder", status: "passed", note: `Building ${path.basename(dir)}/ (the project has no package.json at its top).` });

  const file = path.join(dir, "package.json");
  if (!existsSync(file)) {
    add({ name: "Install, build and test", status: "skipped", note: "There is no package.json, so there is nothing to build." });
    return { steps, passed: true };
  }
  let scripts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, unknown> };
    scripts = parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};
  } catch {
    add({ name: "Install, build and test", status: "failed", note: "package.json could not be read." });
    return { steps, passed: false };
  }

  const run = async (name: string, args: string[], ms: number): Promise<boolean> => {
    const r = await runNpm(args, dir, env, ms, signal);
    const ok = r.code === 0;
    add({ name, status: ok ? "passed" : "failed", exitCode: r.code, ...(ok ? {} : { note: r.timedOut ? "Timed out." : r.error ?? "Failed.", tail: r.tail }) });
    return ok;
  };

  // Scripts of the project itself are not run while installing: that is where unwanted code would run first.
  if (!(await run("Install dependencies", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], timeouts.install))) return { steps, passed: false };

  if (typeof scripts.build === "string") {
    if (!(await run("Build", ["run", "build"], timeouts.build))) return { steps, passed: false };
  } else {
    add({ name: "Build", status: "skipped", note: "The project has no build script." });
  }

  const test = typeof scripts.test === "string" ? scripts.test : "";
  if (test && !/no test specified/i.test(test)) {
    if (!(await run("Tests", ["test"], timeouts.test))) return { steps, passed: false };
  } else {
    add({ name: "Tests", status: "skipped", note: "The project has no tests." });
  }
  return { steps, passed: true };
}

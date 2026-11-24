import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { AuthState, ClaudeSource, ClaudeStatus, ExecutionSettings } from "./types";

/**
 * Local Claude Code integration (server-only).
 *
 * SILPI starts the developer's own Claude Code and lets it use the developer's own sign-in. It never reads
 * Claude Code's credential files, never passes a token, and never holds the subscription login: it only asks the
 * official `claude auth status` command whether a login exists, and keeps just three facts from the answer
 * (signed in or not, subscription or API-key sign-in, plan name).
 *
 * Nothing the browser sends is ever placed on a command line. Every argument below is fixed; the project brief
 * goes in through standard input.
 */

export type ClaudeLocation = {
  exe: string;
  source: ClaudeSource;
  /** Extra leading arguments. Only used in tests, to run a stand-in program. */
  prefixArgs?: string[];
};
export type LocateResult = { location: ClaudeLocation | null; problem?: string };

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Finds Claude Code: the configured path, the PATH, the usual install folders, then the VS Code extension's copy. */
export function locateClaude(settings: Pick<ExecutionSettings, "claudePath">, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): LocateResult {
  if (settings.claudePath) {
    return isFile(settings.claudePath)
      ? { location: { exe: settings.claudePath, source: "configured" } }
      : { location: null, problem: "The Claude Code path in the settings does not exist." };
  }
  const win = platform === "win32";
  const names = win ? ["claude.exe", "claude.cmd"] : ["claude"];
  // A plain wrapper, not an alias of path.win32.join: webpack's static analysis chokes on aliasing a path function.
  const join = (...parts: string[]): string => (win ? path.win32.join(...parts) : path.posix.join(...parts));

  for (const dir of (env.PATH ?? env.Path ?? "").split(win ? ";" : ":").filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (isFile(candidate)) return { location: { exe: candidate, source: "path" } };
    }
  }

  const home = (win ? env.USERPROFILE : env.HOME) ?? "";
  const standard = win
    ? [join(home, ".local", "bin", "claude.exe"), join(home, ".claude", "local", "claude.exe"), join(home, ".claude", "local", "claude.cmd"), join(env.APPDATA ?? "", "npm", "claude.cmd"), join(env.LOCALAPPDATA ?? "", "Programs", "claude", "claude.exe")]
    : [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude"), "/usr/local/bin/claude"];
  for (const candidate of standard) if (home && isFile(candidate)) return { location: { exe: candidate, source: "standard-location" } };

  // The Claude Code extension for VS Code ships the same program inside its own folder.
  try {
    const root = join(home, ".vscode", "extensions");
    const folders = readdirSync(root).filter((f) => /^anthropic\.claude-code-/i.test(f)).sort().reverse();
    for (const folder of folders) {
      const candidate = join(root, folder, "resources", "native-binary", win ? "claude.exe" : "claude");
      if (isFile(candidate)) return { location: { exe: candidate, source: "vscode-extension" } };
    }
  } catch {
    /* no extensions folder */
  }
  return { location: null };
}

// ---- environment: never let an API key or another provider take over -----------------------------

const SCRUB = /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)|CLAUDECODE|CLAUDE_PID|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_(ENTRYPOINT|SESSION.*|CHILD.*|MESSAGING.*|EMIT.*|ENABLE_SDK.*|ENABLE_TASKS|QUESTION.*|STARTUP.*))$/;

/**
 * The environment Claude Code is started with. API keys and cloud-provider switches are removed so the run can only
 * use the developer's own Claude sign-in (and can never bill an API key by accident); markers of an enclosing
 * Claude Code session are removed so this is a fresh, independent session.
 */
export function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !SCRUB.test(key))) as NodeJS.ProcessEnv;
}

// ---- fixed command lines ---------------------------------------------------------------------------

/** What Claude Code may do while it builds: edit files in the project folder and run the project's own npm scripts. */
export const ALLOWED_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash(npm install:*)", "Bash(npm run:*)", "Bash(npm test:*)", "Bash(npm --prefix:*)", "Bash(npx tsc:*)", "Bash(npx eslint:*)",
  // On Windows Claude Code uses PowerShell instead of Bash: the same fixed npm commands, nothing else.
  "PowerShell(npm install:*)", "PowerShell(npm run:*)", "PowerShell(npm test:*)", "PowerShell(npm --prefix:*)"];

export function localArgs(maxTurns: number): string[] {
  return ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--max-turns", String(Math.round(maxTurns)), "--allowedTools", ALLOWED_TOOLS.join(",")];
}

export type SpawnSpec = { command: string; args: string[]; shell: boolean };

/** A program is started directly; an npm `.cmd` wrapper needs the command shell, so its (fixed) arguments are quoted. */
export function spawnSpec(location: ClaudeLocation, args: string[]): SpawnSpec {
  const all = [...(location.prefixArgs ?? []), ...args];
  if (/\.(cmd|bat)$/i.test(location.exe)) {
    const quote = (s: string) => `"${s.replace(/"/g, "")}"`;
    return { command: [quote(location.exe), ...all.map(quote)].join(" "), args: [], shell: true };
  }
  return { command: location.exe, args: all, shell: false };
}

// ---- killing a process and everything it started ---------------------------------------------------------

export function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 3000).unref();
}

// ---- short, bounded commands: version and sign-in status ----------------------------------------------------

type Captured = { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string };

function capture(location: ClaudeLocation, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Captured> {
  return new Promise((resolve) => {
    const spec = spawnSpec(location, args);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, { shell: spec.shell, env: scrubbedEnv(env), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout, stderr, timedOut, error: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { if (stdout.length < 20_000) stdout += d.toString("utf8"); });
    child.stderr?.on("data", (d: Buffer) => { if (stderr.length < 4_000) stderr += d.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, stdout, stderr, timedOut, error: e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

export async function readVersion(location: ClaudeLocation, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const r = await capture(location, ["--version"], env, 15_000);
  return /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1];
}

/**
 * Reads the output of `claude auth status --json` and keeps only: signed in or not, subscription or API-key sign-in,
 * and the plan name. The email, organisation and folders in that output are discarded and never returned.
 */
export function parseAuthStatus(text: string): AuthState {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { kind: "unknown", message: "Claude Code did not answer clearly. Run claude auth login in a terminal." };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { kind: "unknown", message: "Claude Code did not answer clearly. Run claude auth login in a terminal." };
  const d = data as Record<string, unknown>;
  if (d.loggedIn !== true) return { kind: "not-authenticated", message: "Claude Code is not signed in. Run claude auth login in a terminal, then refresh." };
  const method = typeof d.authMethod === "string" ? d.authMethod.toLowerCase() : "";
  const plan = typeof d.subscriptionType === "string" && /^[a-z0-9 _-]{1,20}$/i.test(d.subscriptionType) ? d.subscriptionType : undefined;
  if (method === "claude.ai" || method === "claudeai" || method === "subscription") {
    return { kind: "authenticated-subscription", ...(plan ? { plan } : {}), message: `Signed in with a Claude subscription${plan ? ` (${plan})` : ""}.` };
  }
  if (method.includes("api") || method.includes("console") || method.includes("key")) {
    return { kind: "authenticated-api-key", message: "Claude Code is signed in with an API key, which is billed per use. Local generation needs a subscription sign-in: run claude auth login and choose your Claude account." };
  }
  return { kind: "unknown", message: "Claude Code is signed in, but the sign-in type could not be recognised." };
}

export async function readAuth(location: ClaudeLocation, env: NodeJS.ProcessEnv = process.env): Promise<AuthState> {
  const r = await capture(location, ["auth", "status", "--json"], env, 20_000);
  if (r.timedOut) return { kind: "unknown", message: "Claude Code did not answer in time." };
  if (r.error) return { kind: "unknown", message: "Claude Code could not be started to check the sign-in." };
  return parseAuthStatus(r.stdout);
}

/** Installed? Signed in with a subscription? Never includes a credential, an email or a folder. */
export async function getClaudeStatus(settings: Pick<ExecutionSettings, "claudePath">, env: NodeJS.ProcessEnv = process.env, overrideLocation?: LocateResult): Promise<ClaudeStatus> {
  const found = overrideLocation ?? locateClaude(settings, env);
  if (!found.location) {
    return { installed: false, auth: null, ready: false, message: found.problem ?? "Claude Code was not found. Install it from the official Claude Code instructions, then sign in with claude auth login." };
  }
  const [version, auth] = await Promise.all([readVersion(found.location, env), readAuth(found.location, env)]);
  const ready = auth.kind === "authenticated-subscription";
  return { installed: true, source: found.location.source, version, auth, ready, message: ready ? "Claude Code is installed and signed in with your subscription." : auth.message };
}

// ---- reading Claude Code's streamed output ------------------------------------------------------------------

export type ClaudeEvent =
  | { kind: "status"; text: string }
  | { kind: "message"; text: string }
  | { kind: "action"; text: string; file?: string }
  | { kind: "result"; ok: boolean; text: string; turns?: number; notionalUsd?: number }
  | { kind: "ignore" };

const clip = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");

/** One line of `--output-format stream-json` as a short, safe progress event. */
export function parseClaudeLine(line: string): ClaudeEvent {
  let data: Record<string, any>;
  try {
    data = JSON.parse(line);
  } catch {
    return line.trim() ? { kind: "status", text: clip(line, 300) } : { kind: "ignore" };
  }
  if (data.type === "system" && data.subtype === "init") return { kind: "status", text: `Claude Code started${data.model ? ` (${clip(data.model, 60)})` : ""}.` };
  if (data.type === "assistant" && Array.isArray(data.message?.content)) {
    for (const block of data.message.content) {
      if (block.type === "text" && clip(block.text, 1)) return { kind: "message", text: clip(block.text, 500) };
      if (block.type === "tool_use") {
        const input = block.input ?? {};
        const file = typeof input.file_path === "string" ? input.file_path : undefined;
        const target = file ?? clip(input.command, 120) ?? clip(input.pattern, 80);
        return { kind: "action", text: `${clip(block.name, 30)}${target ? `: ${target}` : ""}`, ...(file && (block.name === "Write" || block.name === "Edit") ? { file } : {}) };
      }
    }
    return { kind: "ignore" };
  }
  if (data.type === "user" && Array.isArray(data.message?.content)) {
    const failed = data.message.content.find((b: any) => b.type === "tool_result" && b.is_error);
    return failed ? { kind: "status", text: `A step reported a problem: ${clip(typeof failed.content === "string" ? failed.content : JSON.stringify(failed.content), 200)}` } : { kind: "ignore" };
  }
  if (data.type === "result") {
    const ok = data.subtype === "success" && data.is_error !== true;
    return {
      kind: "result",
      ok,
      text: clip(data.result, 800) || (ok ? "Claude Code finished." : `Claude Code stopped: ${clip(data.subtype, 60)}`),
      ...(typeof data.num_turns === "number" ? { turns: data.num_turns } : {}),
      ...(typeof data.total_cost_usd === "number" ? { notionalUsd: Math.round(data.total_cost_usd * 10_000) / 10_000 } : {}),
    };
  }
  return { kind: "ignore" };
}

// ---- running Claude Code on a project --------------------------------------------------------------------

export type RunClaudeOptions = {
  location: ClaudeLocation;
  cwd: string;
  /** Sent on standard input, never on the command line. */
  prompt: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent: (event: ClaudeEvent) => void;
  onSpawn?: (child: ChildProcess) => void;
};

export type RunClaudeResult = {
  exitCode: number | null;
  result?: { ok: boolean; text: string; turns?: number; notionalUsd?: number };
  filesChanged: string[];
  stderrTail: string;
  timedOut: boolean;
  cancelled: boolean;
  spawnError?: string;
};

export function runClaude(options: RunClaudeOptions): Promise<RunClaudeResult> {
  return new Promise((resolve) => {
    const spec = spawnSpec(options.location, options.args);
    const files = new Set<string>();
    let result: RunClaudeResult["result"];
    let stderrTail = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const done = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, result, filesChanged: [...files], stderrTail: stderrTail.trim().slice(-1500), timedOut, cancelled, ...(spawnError ? { spawnError } : {}) });
    };

    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, { cwd: options.cwd, shell: spec.shell, env: scrubbedEnv(options.env), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ exitCode: null, filesChanged: [], stderrTail: "", timedOut: false, cancelled: false, spawnError: (e as Error).message });
      return;
    }
    options.onSpawn?.(child);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, options.timeoutMs);
    const onAbort = () => { cancelled = true; killTree(child); };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!raw) continue;
        const event = parseClaudeLine(raw);
        if (event.kind === "ignore") continue;
        if (event.kind === "result") result = { ok: event.ok, text: event.text, turns: event.turns, notionalUsd: event.notionalUsd };
        if (event.kind === "action" && event.file) files.add(event.file);
        options.onEvent(event);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-4000); });
    child.on("error", (e) => done(null, e.message));
    child.on("close", (code) => done(code));
    child.stdin?.on("error", () => { /* the program exited before reading its input */ });
    child.stdin?.end(options.prompt);
  });
}

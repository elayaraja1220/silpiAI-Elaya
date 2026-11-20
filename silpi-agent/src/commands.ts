import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { config } from "./config.js";

/**
 * The agent can only run commands from this allowlist. Commands are split on
 * whitespace (no quoting, pipes, redirects or chaining) and every argument is
 * checked against a conservative character set, so no shell syntax ever
 * reaches a shell.
 *
 * Builds still execute code the model wrote (next.config.js, test files,
 * package.json scripts), so the allowlist is a guard, not a sandbox. With
 * SILPI_SANDBOX=docker every command runs in a throwaway container that can
 * only see the project folder.
 */

export type ParsedCommand = {
  program: string;
  args: string[];
  timeoutMs: number;
  /** True for commands whose success means "the project builds". */
  isBuildCheck: boolean;
  /** For `npm run <x>` / `npm test`: the package.json script that will run. */
  npmScript?: string;
};

export type ParseResult = { ok: true; command: ParsedCommand } | { ok: false; error: string };

// Long-running servers/watchers never exit, so they are refused.
const BLOCKED_SCRIPTS = new Set(["dev", "start", "serve", "watch", "preview", "storybook"]);
const BUILD_SCRIPTS = new Set(["build", "typecheck", "type-check", "check", "lint", "test", "compile"]);

const SAFE_ARG = /^[\w@./:=+-]+$/;
// npm package specs may also carry semver range characters.
const SAFE_PACKAGE = /^(@[\w.-]+\/)?[\w.-]+(@[\w.^~*+-]+)?$/;

function invalidArg(arg: string): boolean {
  return !SAFE_ARG.test(arg) || arg.split("/").includes("..") || path.isAbsolute(arg);
}

export function parseCommand(input: string): ParseResult {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const [program, ...args] = tokens;
  if (!program) return { ok: false, error: "Empty command." };

  const fail = (error: string): ParseResult => ({ ok: false, error });
  const ok = (timeoutMs = config.commandTimeoutMs, isBuildCheck = false, npmScript?: string): ParseResult => ({
    ok: true,
    command: { program, args, timeoutMs, isBuildCheck, npmScript },
  });

  switch (program) {
    case "npm": {
      const [sub, ...rest] = args;
      if (sub === "install" || sub === "i" || sub === "uninstall" || sub === "ci") {
        for (const arg of rest) {
          if (arg.startsWith("-")) {
            if (!["--save-dev", "-D", "--save-exact", "-E", "--legacy-peer-deps", "--no-audit", "--no-fund"].includes(arg)) {
              return fail(`npm flag "${arg}" is not allowed.`);
            }
          } else if (sub === "ci" || !SAFE_PACKAGE.test(arg)) {
            return fail(`"${arg}" is not a valid package name.`);
          }
        }
        return ok(config.installTimeoutMs);
      }
      if (sub === "run" || sub === "test") {
        const script = sub === "test" ? "test" : rest[0];
        if (!script || !/^[\w:.-]+$/.test(script)) return fail("Give a script name, e.g. npm run build.");
        if (BLOCKED_SCRIPTS.has(script)) {
          return fail(`"npm run ${script}" starts a long-running server and is not allowed. Use build, lint, typecheck or test.`);
        }
        const extra = sub === "test" ? rest : rest.slice(1);
        if (extra.some(invalidArg)) return fail("Script arguments contain disallowed characters.");
        return ok(config.commandTimeoutMs, BUILD_SCRIPTS.has(script.split(":")[0] ?? script), script);
      }
      return fail(`"npm ${sub ?? ""}" is not allowed. Allowed: npm install/ci/uninstall, npm run <script>, npm test.`);
    }

    case "npx": {
      const [tool, ...rest] = args;
      if (rest.some(invalidArg)) return fail("Arguments contain disallowed characters.");
      if (tool === "tsc") return ok(config.commandTimeoutMs, true);
      if (tool === "prisma" && ["generate", "validate", "format"].includes(rest[0] ?? "")) return ok();
      return fail("Only `npx tsc ...` and `npx prisma generate|validate|format` are allowed.");
    }

    case "composer": {
      const [sub, ...rest] = args;
      if (!["install", "update", "require", "dump-autoload", "validate"].includes(sub ?? "")) {
        return fail("Allowed: composer install|update|require|dump-autoload|validate.");
      }
      if (rest.some(invalidArg)) return fail("Arguments contain disallowed characters.");
      return ok(config.installTimeoutMs);
    }

    case "php": {
      if (args[0] !== "-l" || args.length !== 2 || invalidArg(args[1] ?? "")) {
        return fail("Only `php -l <file>` (syntax check) is allowed.");
      }
      return ok(60_000, true);
    }

    case "python":
    case "python3":
    case "py": {
      const [flag, mod, ...rest] = args;
      if (flag !== "-m" || !["py_compile", "compileall", "pytest"].includes(mod ?? "")) {
        return fail("Allowed: python -m py_compile|compileall|pytest ...");
      }
      if (rest.some(invalidArg)) return fail("Arguments contain disallowed characters.");
      return ok(config.commandTimeoutMs, true);
    }

    case "go": {
      const [sub, ...rest] = args;
      if (!["build", "vet", "test", "mod"].includes(sub ?? "")) return fail("Allowed: go build|vet|test|mod tidy.");
      if (sub === "mod" && rest[0] !== "tidy") return fail("Only `go mod tidy` is allowed.");
      if (rest.some((a) => a !== "./..." && invalidArg(a))) return fail("Arguments contain disallowed characters.");
      return ok(config.commandTimeoutMs, sub !== "mod");
    }

    case "dotnet": {
      const [sub, ...rest] = args;
      if (!["restore", "build", "test"].includes(sub ?? "")) return fail("Allowed: dotnet restore|build|test.");
      if (rest.some(invalidArg)) return fail("Arguments contain disallowed characters.");
      return ok(config.installTimeoutMs, sub !== "restore");
    }

    case "mvn": {
      const goals = args.filter((a) => !a.startsWith("-"));
      if (!goals.length || goals.some((g) => !["compile", "package", "test", "verify"].includes(g))) {
        return fail("Allowed Maven goals: compile, package, test, verify.");
      }
      if (args.some(invalidArg)) return fail("Arguments contain disallowed characters.");
      return ok(config.installTimeoutMs, true);
    }

    default:
      return fail(
        `"${program}" is not an allowed command. Allowed programs: npm, npx (tsc/prisma), composer, php -l, python -m, go, dotnet, mvn.`,
      );
  }
}

// ---------------------------------------------------------------------------
// package.json script guard (local mode)
// ---------------------------------------------------------------------------

/** Programs a package.json script may start with when running outside a sandbox. */
const SCRIPT_PROGRAMS = new Set([
  "next", "vite", "tsc", "vue-tsc", "svelte-check", "svelte-kit", "astro", "nuxt", "nuxi", "ng", "react-scripts",
  "remix", "gatsby", "eslint", "prettier", "stylelint", "jest", "vitest", "mocha", "playwright", "prisma",
  "tsx", "ts-node", "tailwindcss", "postcss", "webpack", "rollup", "esbuild", "parcel", "babel", "tsup", "nest",
  "node", "echo", "serve", "http-server", "json-server", "nodemon",
]);
const SHELL_SYNTAX = /[;`<>\n\r]|\$\(|(?<![|&])[|&](?![|&])/;
const NODE_EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-r", "--require", "--import", "--loader"]);

function readScripts(dir: string): Record<string, string> | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    const scripts: Record<string, string> = {};
    for (const [key, value] of Object.entries(pkg.scripts ?? {})) if (typeof value === "string") scripts[key] = value;
    return scripts;
  } catch {
    return null;
  }
}

/**
 * Checks what `npm run <script>` would actually execute. Returns an error
 * message, or null when the script only calls known build tools.
 */
export function checkNpmScript(dir: string, script: string, depth = 0): string | null {
  const scripts = readScripts(dir);
  const body = scripts?.[script];
  if (body === undefined) return null; // npm itself reports the missing script
  const refuse = (why: string) =>
    `package.json script "${script}" runs \`${body}\`, which is blocked: ${why}. ` +
    "Scripts may only call the project's build tools directly (next, vite, tsc, eslint, jest, vitest, prisma, node <file>, ...), " +
    "optionally chained with &&. Rewrite the script.";

  if (SHELL_SYNTAX.test(body)) return refuse("it uses shell syntax (; | > < ` $( or a single &)");
  if (depth > 3) return refuse("scripts call each other too deeply");

  for (const segment of body.split(/&&|\|\|/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    while (tokens[0] && (/^[A-Z_][A-Z0-9_]*=\S*$/.test(tokens[0]) || tokens[0] === "cross-env")) tokens.shift();
    const [program, ...args] = tokens;
    if (!program) continue;

    if (program === "npm") {
      const nested = args[0] === "run" ? args[1] : args[0] === "test" ? "test" : undefined;
      if (!nested) return refuse(`"npm ${args[0] ?? ""}" is not allowed inside scripts`);
      const error = checkNpmScript(dir, nested, depth + 1);
      if (error) return error;
      continue;
    }
    if (program === "npx") {
      if (!SCRIPT_PROGRAMS.has(args[0] ?? "")) return refuse(`"npx ${args[0] ?? ""}" is not a known build tool`);
      continue;
    }
    if (!SCRIPT_PROGRAMS.has(program)) return refuse(`"${program}" is not a known build tool`);
    if (program === "node" || program === "tsx" || program === "ts-node") {
      if (args.some((a) => NODE_EVAL_FLAGS.has(a) || a.startsWith("--eval") || a.startsWith("--require"))) {
        return refuse(`"${program}" may only run a file from the project, not inline code`);
      }
      const file = args.find((a) => !a.startsWith("-"));
      if (file && (path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))) {
        return refuse(`"${program}" may only run files inside the project`);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/** Locate npm's JS entry next to the running node binary, so npm runs without a shell. */
function findNpmScript(file: "npm-cli.js" | "npx-cli.js"): string | null {
  const dir = path.dirname(process.execPath);
  const candidates = [
    path.join(dir, "node_modules", "npm", "bin", file),
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", file),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const QUIET_ENV: Record<string, string> = {
  CI: "1",
  FORCE_COLOR: "0",
  NO_COLOR: "1",
  NEXT_TELEMETRY_DISABLED: "1",
  npm_config_fund: "false",
  npm_config_audit: "false",
  npm_config_update_notifier: "false",
};

/** Child processes get the environment minus anything that looks like a credential. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/ANTHROPIC|API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...QUIET_ENV, ...extra };
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const HEAD_CHARS = 2_000;
const TAIL_CHARS = 10_000;

export function clip(text: string, head = HEAD_CHARS, tail = TAIL_CHARS): string {
  const clean = text.replace(ANSI_RE, "").replace(/\r\n?/g, "\n");
  if (clean.length <= head + tail) return clean;
  return `${clean.slice(0, head)}\n\n... (${clean.length - head - tail} characters omitted) ...\n\n${clean.slice(-tail)}`;
}

export type CommandResult = { exitCode: number | null; timedOut: boolean; output: string; durationMs: number };

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }
}

let dockerChecked: boolean | null = null;

/** True when the docker CLI is installed and the daemon answers. */
export function dockerAvailable(): boolean {
  if (dockerChecked === null) {
    const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { windowsHide: true, timeout: 15_000 });
    dockerChecked = result.status === 0;
  }
  return dockerChecked;
}

type Launch = { program: string; args: string[]; useShell: boolean; env: NodeJS.ProcessEnv; containerName?: string };

/**
 * Builds the real process to spawn: the command directly on this machine, or
 * wrapped in `docker run` with only the project folder mounted.
 */
function buildLaunch(
  program: string,
  args: string[],
  cwd: string,
  root: string,
  opts: { env?: Record<string, string>; publishPort?: number } = {},
): Launch {
  if (config.sandbox === "docker") {
    const name = `silpi-${randomBytes(5).toString("hex")}`;
    const rel = path.relative(root, cwd).split(path.sep).join("/");
    const dockerArgs = [
      "run", "--rm", "--init", "--name", name,
      "--mount", `type=bind,source=${root},target=/work`,
      "-w", rel ? `/work/${rel}` : "/work",
      "--memory", "4g", "--cpus", "2", "--pids-limit", "1024",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "-e", "HOME=/tmp", "-e", "npm_config_cache=/tmp/.npm",
    ];
    // On Linux/macOS run as the host user so files stay writable and owned by them.
    if (typeof process.getuid === "function" && typeof process.getgid === "function") {
      dockerArgs.push("--user", `${process.getuid()}:${process.getgid()}`);
    }
    for (const [key, value] of Object.entries({ ...QUIET_ENV, ...opts.env })) dockerArgs.push("-e", `${key}=${value}`);
    if (opts.publishPort) dockerArgs.push("-p", `127.0.0.1:${opts.publishPort}:${opts.publishPort}`);
    dockerArgs.push(config.dockerImage, program, ...args);
    return { program: "docker", args: dockerArgs, useShell: false, env: childEnv(), containerName: name };
  }

  let useShell = false;
  if (program === "npm" || program === "npx") {
    const script = findNpmScript(program === "npm" ? "npm-cli.js" : "npx-cli.js");
    if (script) {
      args = [script, ...args];
      program = process.execPath;
    } else {
      useShell = process.platform === "win32";
    }
  } else if (process.platform === "win32" && (program === "composer" || program === "mvn")) {
    // .bat/.cmd launchers need a shell on Windows; arguments were already
    // restricted to SAFE_ARG, which contains no shell metacharacters.
    useShell = true;
  }
  return { program, args, useShell, env: childEnv(opts.env) };
}

function stopLaunch(child: ChildProcess, launch: Launch): void {
  if (launch.containerName) {
    spawn("docker", ["kill", launch.containerName], { windowsHide: true, stdio: "ignore" });
  }
  killTree(child.pid);
}

/** Runs a command to completion. `root` is the project folder (mounted in docker mode). */
export function runCommand(command: ParsedCommand, cwd: string, root: string = cwd): Promise<CommandResult> {
  const started = Date.now();

  if (config.sandbox === "docker" && !dockerAvailable()) {
    return Promise.resolve({
      exitCode: null,
      timedOut: false,
      output: "SILPI_SANDBOX=docker is set but Docker is not running on this machine, so no command can run. The operator must start Docker.",
      durationMs: 0,
    });
  }
  if (config.sandbox === "local" && command.npmScript) {
    const blocked = checkNpmScript(cwd, command.npmScript);
    if (blocked) return Promise.resolve({ exitCode: null, timedOut: false, output: blocked, durationMs: 0 });
  }

  const launch = buildLaunch(command.program, command.args, cwd, root);
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const child = spawn(launch.program, launch.args, {
      cwd,
      env: launch.env,
      shell: launch.useShell,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      // Keep memory bounded on very chatty commands.
      if (output.length > 400_000) output = output.slice(0, HEAD_CHARS) + output.slice(-300_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      stopLaunch(child, launch);
    }, command.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut, output: `Could not start "${command.program}": ${error.message}`, durationMs: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, output: clip(output), durationMs: Date.now() - started });
    });
  });
}

export type ServerHandle = {
  /** Output so far (ANSI stripped, bounded). */
  output: () => string;
  /** Resolves with the exit code once the process ends. */
  exited: Promise<number | null>;
  stop: () => void;
};

/** Starts a long-running process (an app server) and returns a handle to stop it. */
export function startServer(
  program: string,
  args: string[],
  cwd: string,
  root: string,
  opts: { env?: Record<string, string>; publishPort?: number } = {},
): ServerHandle {
  const launch = buildLaunch(program, args, cwd, root, opts);
  let output = "";
  const child = spawn(launch.program, launch.args, {
    cwd,
    env: launch.env,
    shell: launch.useShell,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-60_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", (error) => {
      output += `\nCould not start "${program}": ${error.message}`;
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });
  return { output: () => output.replace(ANSI_RE, ""), exited, stop: () => stopLaunch(child, launch) };
}

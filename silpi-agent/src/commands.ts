import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { config } from "./config.js";

/**
 * The agent can only run commands from this allowlist. Commands are split on
 * whitespace (no quoting, pipes, redirects or chaining) and every argument is
 * checked against a conservative character set, so no shell syntax ever
 * reaches a shell.
 */

export type ParsedCommand = {
  program: string;
  args: string[];
  timeoutMs: number;
  /** True for commands whose success means "the project builds". */
  isBuildCheck: boolean;
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
  const ok = (timeoutMs = config.commandTimeoutMs, isBuildCheck = false): ParseResult => ({
    ok: true,
    command: { program, args, timeoutMs, isBuildCheck },
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
        return ok(config.commandTimeoutMs, BUILD_SCRIPTS.has(script.split(":")[0] ?? script));
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

/** Locate npm's JS entry next to the running node binary, so npm runs without a shell. */
function findNpmScript(file: "npm-cli.js" | "npx-cli.js"): string | null {
  const dir = path.dirname(process.execPath);
  const candidates = [
    path.join(dir, "node_modules", "npm", "bin", file),
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", file),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Child processes get the environment minus anything that looks like a credential. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/ANTHROPIC|API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    CI: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_update_notifier: "false",
  };
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const HEAD_CHARS = 2_000;
const TAIL_CHARS = 10_000;

function clip(text: string): string {
  const clean = text.replace(ANSI_RE, "").replace(/\r\n?/g, "\n");
  if (clean.length <= HEAD_CHARS + TAIL_CHARS) return clean;
  return `${clean.slice(0, HEAD_CHARS)}\n\n... (${clean.length - HEAD_CHARS - TAIL_CHARS} characters omitted) ...\n\n${clean.slice(-TAIL_CHARS)}`;
}

export type CommandResult = { exitCode: number | null; timedOut: boolean; output: string; durationMs: number };

function killTree(pid: number | undefined): void {
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

export function runCommand(command: ParsedCommand, cwd: string): Promise<CommandResult> {
  let program = command.program;
  let args = command.args;
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

  const started = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const child = spawn(program, args, {
      cwd,
      env: childEnv(),
      shell: useShell,
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
      killTree(child.pid);
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

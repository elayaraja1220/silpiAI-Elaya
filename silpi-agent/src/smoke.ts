import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import { checkNpmScript, clip, dockerAvailable, startServer } from "./commands.js";
import { config } from "./config.js";

/**
 * Post-build check: start the generated app, wait until it answers HTTP, then
 * stop it. A passing build only proves the code compiles; this proves the app
 * actually starts and serves a page.
 */

export type SmokeTarget = {
  /** Folder relative to the project root ("" = root). */
  folder: string;
  script: string;
  ok: boolean;
  url?: string;
  status?: number;
  detail: string;
};

export type SmokeResult = {
  /** False when there was nothing SILPI knows how to start (static site, non-Node stack). */
  ran: boolean;
  ok: boolean;
  targets: SmokeTarget[];
  note?: string;
};

const CANDIDATE_FOLDERS = ["", "frontend", "backend", "client", "server", "web", "api"];
const SCRIPT_ORDER = ["start", "preview", "dev"];
const URL_IN_LOG = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/g;

type Pkg = { scripts?: Record<string, string> };

function readPkg(dir: string): Pkg | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Pkg;
  } catch {
    return null;
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Extra CLI flags so common frameworks listen on the port and host we choose. */
export function portArgs(scriptBody: string, port: number, host: string): string[] {
  if (/\bnext\b/.test(scriptBody)) return ["--", "-p", String(port), "-H", host];
  if (/\b(vite|astro)\b/.test(scriptBody)) return ["--", "--port", String(port), "--host", host, "--strictPort"];
  if (/\b(nuxt|nuxi)\b/.test(scriptBody)) return ["--", "--port", String(port), "--host", host];
  return []; // Express, CRA, etc. read PORT from the environment.
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  } catch {
    return null;
  }
}

/** Picks the script to start: the first of start/preview/dev that exists. */
export function pickScript(pkg: Pkg): string | null {
  return SCRIPT_ORDER.find((name) => typeof pkg.scripts?.[name] === "string") ?? null;
}

async function checkTarget(root: string, folder: string, signal?: AbortSignal): Promise<SmokeTarget | null> {
  const dir = path.join(root, folder);
  const pkg = readPkg(dir);
  if (!pkg) return null;
  const script = pickScript(pkg);
  if (!script) return null;

  const base = { folder, script };
  if (!existsSync(path.join(dir, "node_modules"))) {
    return { ...base, ok: false, detail: "Dependencies are not installed (no node_modules). Run npm install in this folder." };
  }
  if (config.sandbox === "local") {
    const blocked = checkNpmScript(dir, script);
    if (blocked) return { ...base, ok: false, detail: blocked };
  }

  const port = await freePort();
  const host = config.sandbox === "docker" ? "0.0.0.0" : "127.0.0.1";
  const body = pkg.scripts?.[script] ?? "";
  const server = startServer("npm", ["run", script, ...portArgs(body, port, host)], dir, root, {
    env: { PORT: String(port), HOST: host, BROWSER: "none", NODE_ENV: script === "dev" ? "development" : "production" },
    publishPort: config.sandbox === "docker" ? port : undefined,
  });

  let exitCode: number | null | undefined;
  void server.exited.then((code) => {
    exitCode = code;
  });

  const deadline = Date.now() + config.smokeTimeoutMs;
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) return { ...base, ok: false, detail: "Check cancelled." };
      if (exitCode !== undefined) {
        return { ...base, ok: false, detail: `\`npm run ${script}\` exited with code ${exitCode} before serving.\n${clip(server.output(), 500, 3_000)}` };
      }
      // Our port first; locally also any port the app printed (some apps ignore PORT).
      const ports = new Set([port]);
      if (config.sandbox === "local") {
        for (const match of server.output().matchAll(URL_IN_LOG)) ports.add(Number(match[1]));
      }
      for (const p of ports) {
        const url = `http://127.0.0.1:${p}/`;
        const status = await probe(url);
        if (status !== null) {
          const ok = status < 500;
          return {
            ...base,
            ok,
            url,
            status,
            detail: ok ? `Answered HTTP ${status}.` : `Answered HTTP ${status} (server error).\n${clip(server.output(), 500, 3_000)}`,
          };
        }
      }
      await sleep(1_500);
    }
    return {
      ...base,
      ok: false,
      detail: `No HTTP answer within ${Math.round(config.smokeTimeoutMs / 1000)}s on port ${port}.\n${clip(server.output(), 500, 3_000)}`,
    };
  } finally {
    server.stop();
    await Promise.race([server.exited, sleep(5_000)]);
  }
}

export async function smokeTest(root: string, signal?: AbortSignal): Promise<SmokeResult> {
  if (config.sandbox === "docker" && !dockerAvailable()) {
    return { ran: false, ok: false, targets: [], note: "Docker is not running, so the app could not be started." };
  }
  const targets: SmokeTarget[] = [];
  // Split projects (frontend/ + backend/) are checked per folder; a root
  // package.json there usually only orchestrates them, so it is skipped.
  for (const folder of CANDIDATE_FOLDERS.slice(1)) {
    const result = await checkTarget(root, folder, signal);
    if (result) targets.push(result);
  }
  if (targets.length === 0) {
    const result = await checkTarget(root, "", signal);
    if (result) targets.push(result);
  }
  if (targets.length === 0) {
    const staticSite = existsSync(path.join(root, "index.html"));
    return {
      ran: false,
      ok: true,
      targets,
      note: staticSite
        ? "Static site: open index.html in a browser, no server needed."
        : "No Node.js start/dev script found, so the app was not started automatically.",
    };
  }
  return { ran: true, ok: targets.every((t) => t.ok), targets };
}

/** Short text for the model / report describing a smoke result. */
export function describeSmoke(result: SmokeResult): string {
  if (!result.ran) return result.note ?? "Not run.";
  return result.targets
    .map((t) => `- ${t.folder || "(root)"}: npm run ${t.script} -> ${t.ok ? "OK" : "FAILED"}${t.url ? ` (${t.url})` : ""}\n  ${t.detail.replace(/\n/g, "\n  ")}`)
    .join("\n");
}

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { DEMO_START_COMMAND } from "./app-runner";
import { countHtmlFiles, isHtmlFile } from "./files";

/**
 * What kind of project is this, and how can it be shown? (server-only)
 *
 *   static  a built folder of HTML/CSS/JS (plain HTML, Vite, React, Vue, Astro, Next "export"...): it is copied and served as it is.
 *   app     a framework that needs a running server (Next.js, Nuxt, SvelteKit, Remix, Express...): it is started privately and proxied.
 *   none    nothing built yet.
 */
export type Detected =
  | { mode: "static"; framework: string; outputDir: string; spa: boolean }
  | { mode: "app"; framework: string; startCommand: string }
  | { mode: "none"; framework: string; reason: string };

/** Built-output folders, in the order they are looked at. */
const OUTPUT_DIRS = ["dist", "build", "out", "public", "_site", "docs"];

const FRAMEWORKS: { name: string; dep: string }[] = [
  { name: "Next.js", dep: "next" }, { name: "Nuxt", dep: "nuxt" }, { name: "SvelteKit", dep: "@sveltejs/kit" }, { name: "Remix", dep: "@remix-run/node" },
  { name: "Astro", dep: "astro" }, { name: "Gatsby", dep: "gatsby" }, { name: "Vite", dep: "vite" }, { name: "Angular", dep: "@angular/core" },
  { name: "React", dep: "react" }, { name: "Vue", dep: "vue" }, { name: "Express", dep: "express" },
];

type Pkg = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
function readPackage(dir: string): Pkg | null {
  try { return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Pkg; } catch { return null; }
}

export function frameworkOf(pkg: Pkg | null): string {
  if (!pkg) return "HTML";
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return FRAMEWORKS.find((f) => all[f.dep])?.name ?? "Node";
}

/** A built folder: has an index.html (or another page) at its top. */
function builtFolder(dir: string): string | null {
  for (const name of OUTPUT_DIRS) {
    const candidate = path.join(dir, name);
    if (!existsSync(candidate)) continue;
    try {
      if (readdirSync(candidate).some((f) => isHtmlFile(f))) return candidate;
    } catch { /* unreadable: skip */ }
  }
  return null;
}

export function detectProject(projectDir: string): Detected {
  const pkg = readPackage(projectDir);
  const framework = frameworkOf(pkg);
  const output = builtFolder(projectDir);
  // A framework that renders on a server (Next.js without "export", Nuxt, SvelteKit...) must run; its `.next`-style folder is not a site.
  const serverFramework = ["Next.js", "Nuxt", "SvelteKit", "Remix"].includes(framework);
  const serverBuilt = existsSync(path.join(projectDir, ".next")) || existsSync(path.join(projectDir, ".output")) || existsSync(path.join(projectDir, ".svelte-kit")) || existsSync(path.join(projectDir, "build", "server"));
  if (serverFramework && serverBuilt && pkg?.scripts?.start && !(output && path.basename(output) === "out")) {
    return { mode: "app", framework, startCommand: DEMO_START_COMMAND };
  }
  if (output) {
    // One HTML file means the pages are drawn in the browser (a single-page app): unknown paths must fall back to it.
    return { mode: "static", framework, outputDir: output, spa: countHtmlFiles(output, 3) <= 1 };
  }
  if (pkg?.scripts?.start && (framework === "Express" || framework === "Node")) return { mode: "app", framework, startCommand: DEMO_START_COMMAND };
  return { mode: "none", framework, reason: pkg?.scripts?.build ? "The project has not been built yet." : "No built website was found in this project." };
}

export const hasBuildScript = (projectDir: string): boolean => Boolean(readPackage(projectDir)?.scripts?.build);

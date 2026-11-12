import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Folders the agent never lists, reads or writes. */
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  "bin",
  "obj",
  "target",
]);

/** Files that may hold real secrets. .env.example and similar stay writable. */
const SECRET_FILE_RE = /^\.env(\.(local|development|production|test)(\.local)?)?$/i;

export class PathError extends Error {}

/**
 * Resolve a model-supplied relative path inside the project root.
 * Rejects absolute paths, `..` escapes and ignored/secret locations.
 */
export function resolveInside(root: string, relativePath: string, opts: { forWrite?: boolean } = {}): string {
  const cleaned = relativePath.trim().replace(/\\/g, "/");
  if (!cleaned || cleaned === ".") return root;
  if (path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
    throw new PathError(`Use a path relative to the project root, not "${relativePath}".`);
  }

  const target = path.resolve(root, cleaned);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PathError(`Path "${relativePath}" is outside the project folder.`);
  }

  const parts = relative.split(path.sep);
  if (parts.some((part) => IGNORED_DIRS.has(part))) {
    throw new PathError(`Path "${relativePath}" is inside a generated or dependency folder (${parts.find((p) => IGNORED_DIRS.has(p))}).`);
  }
  if (opts.forWrite && SECRET_FILE_RE.test(parts[parts.length - 1] ?? "")) {
    throw new PathError(`Writing "${relativePath}" is not allowed. Put example values in .env.example instead.`);
  }
  return target;
}

export function toPosix(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

/** Indented tree of the project, skipping ignored folders. */
export async function listTree(root: string, start: string, maxDepth: number, maxEntries = 400): Promise<string> {
  const lines: string[] = [];
  let count = 0;

  async function walk(dir: string, depth: number, indent: string): Promise<void> {
    if (count >= maxEntries) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (count >= maxEntries) {
        lines.push(`${indent}... (listing truncated)`);
        return;
      }
      count++;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          lines.push(`${indent}${entry.name}/ (skipped)`);
          continue;
        }
        lines.push(`${indent}${entry.name}/`);
        if (depth < maxDepth) await walk(full, depth + 1, `${indent}  `);
      } else {
        const size = (await stat(full).catch(() => null))?.size ?? 0;
        lines.push(`${indent}${entry.name} (${size} B)`);
      }
    }
  }

  await walk(start, 1, "");
  return lines.length ? lines.join("\n") : "(empty)";
}

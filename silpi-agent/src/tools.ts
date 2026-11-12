import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { parseCommand, runCommand } from "./commands.js";
import type { Emit } from "./events.js";
import { IGNORED_DIRS, PathError, listTree, resolveInside, toPosix } from "./workspace.js";

const MAX_READ_BYTES = 200_000;
const MAX_WRITE_BYTES = 1_000_000;
const MAX_SEARCH_MATCHES = 100;
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|css|scss|sass|less|html|md|mdx|txt|vue|svelte|astro|php|py|go|java|cs|rb|yml|yaml|toml|env\.example|sql|prisma|graphql|xml|svg|ini|sh)$/i;

// ---------------------------------------------------------------------------
// Tool definitions (sent to Claude)
// ---------------------------------------------------------------------------

export const toolDefinitions: Anthropic.Beta.BetaTool[] = [
  {
    name: "list_files",
    description:
      "List files and folders in the project as an indented tree with sizes. Dependency and build folders (node_modules, .next, dist, ...) are skipped.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder relative to the project root. Defaults to the root." },
        depth: { type: "integer", description: "How many levels to descend (1-6). Default 3." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read a text file from the project. Returns the content with 1-based line numbers. Large files can be read in ranges.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        start_line: { type: "integer", description: "First line to return (1-based). Optional." },
        end_line: { type: "integer", description: "Last line to return (inclusive). Optional." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search_files",
    description: "Search the project's text files with a regular expression. Returns matching lines as path:line: text.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression (case-insensitive)." },
        path: { type: "string", description: "Folder to search, relative to the project root. Defaults to the root." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      "Create or fully overwrite a file with the given content. Parent folders are created automatically. Prefer edit_file for small changes to existing files.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        content: { type: "string", description: "The complete file content." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact snippet of an existing file. old_text must match the file exactly (including whitespace) and be unique unless replace_all is true.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        old_text: { type: "string", description: "Exact text to find." },
        new_text: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence. Default false." },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    description: "Delete a file or an empty-able folder (recursively) inside the project.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the project root." } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description: [
      "Run an allowlisted command in the project root (or a sub-folder via cwd) and get its exit code and output.",
      "Allowed: npm install [pkgs] [-D] | npm ci | npm uninstall <pkg> | npm run <script> | npm test | npx tsc [...] |",
      "npx prisma generate|validate|format | composer install|update|require|dump-autoload|validate | php -l <file> |",
      "python -m py_compile|compileall|pytest | go build|vet|test|mod tidy | dotnet restore|build|test | mvn compile|package|test|verify.",
      "No shell features (pipes, &&, redirects, quotes). Dev servers (npm run dev/start) are not allowed because they never exit.",
    ].join(" "),
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command, e.g. `npm run build`." },
        cwd: { type: "string", description: "Sub-folder relative to the project root, e.g. `frontend`. Defaults to the root." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Input schemas (validated before running - eager streaming skips server validation)
// ---------------------------------------------------------------------------

const schemas = {
  list_files: z.object({ path: z.string().optional(), depth: z.number().int().min(1).max(6).optional() }),
  read_file: z.object({
    path: z.string().min(1),
    start_line: z.number().int().min(1).optional(),
    end_line: z.number().int().min(1).optional(),
  }),
  search_files: z.object({ pattern: z.string().min(1).max(500), path: z.string().optional() }),
  write_file: z.object({ path: z.string().min(1), content: z.string() }),
  edit_file: z.object({
    path: z.string().min(1),
    old_text: z.string().min(1),
    new_text: z.string(),
    replace_all: z.boolean().optional(),
  }),
  delete_file: z.object({ path: z.string().min(1) }),
  run_command: z.object({ command: z.string().min(1).max(500), cwd: z.string().optional() }),
} as const;

type ToolName = keyof typeof schemas;

export type ToolOutcome = { content: string; isError: boolean };

/** State shared across one run, used for the final report. */
export class RunState {
  readonly changedFiles = new Set<string>();
  /** null = no build/check command has run yet. */
  buildPassed: boolean | null = null;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function walkTextFiles(root: string, start: string, visit: (file: string) => Promise<boolean>): Promise<void> {
  const entries = await readdir(start, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(start, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) await walkTextFiles(root, full, visit);
    } else if (TEXT_EXT.test(entry.name)) {
      if (!(await visit(full))) return;
    }
  }
}

function describe(name: string, input: Record<string, unknown>): string {
  const p = typeof input.path === "string" ? input.path : "";
  switch (name) {
    case "list_files":
      return `Listing ${p || "project"}`;
    case "read_file":
      return `Reading ${p}`;
    case "search_files":
      return `Searching for /${String(input.pattern ?? "")}/`;
    case "write_file":
      return `Writing ${p}`;
    case "edit_file":
      return `Editing ${p}`;
    case "delete_file":
      return `Deleting ${p}`;
    case "run_command":
      return `Running \`${String(input.command ?? "")}\`${input.cwd ? ` in ${String(input.cwd)}` : ""}`;
    default:
      return name;
  }
}

export async function executeTool(
  root: string,
  name: string,
  rawInput: unknown,
  state: RunState,
  emit: Emit,
): Promise<ToolOutcome> {
  if (!(name in schemas)) return { content: `Unknown tool "${name}".`, isError: true };
  const toolName = name as ToolName;

  const parsed = schemas[toolName].safeParse(rawInput);
  if (!parsed.success) {
    // Covers inputs that were cut off or malformed while streaming.
    return {
      content: `INVALID_INPUT: the tool input did not match the schema (${parsed.error.issues.map((i) => i.message).join("; ")}). Send the call again with complete, valid arguments.`,
      isError: true,
    };
  }

  const input = parsed.data as Record<string, unknown>;
  const label = describe(toolName, input);
  emit({ type: "action", tool: toolName, label });

  try {
    const outcome = await run(root, toolName, input, state);
    emit({ type: "result", tool: toolName, ok: !outcome.isError, label, detail: outcome.isError ? outcome.content.slice(0, 1500) : undefined });
    return outcome;
  } catch (error) {
    const message = error instanceof PathError || error instanceof Error ? error.message : String(error);
    emit({ type: "result", tool: toolName, ok: false, label, detail: message });
    return { content: message, isError: true };
  }
}

async function run(root: string, name: ToolName, input: Record<string, unknown>, state: RunState): Promise<ToolOutcome> {
  switch (name) {
    case "list_files": {
      const dir = resolveInside(root, (input.path as string | undefined) ?? "");
      return { content: await listTree(root, dir, (input.depth as number | undefined) ?? 3), isError: false };
    }

    case "read_file": {
      const file = resolveInside(root, input.path as string);
      const info = await stat(file);
      if (info.isDirectory()) return { content: "That path is a folder. Use list_files.", isError: true };
      const text = await readFile(file, "utf8");
      const lines = text.split(/\r?\n/);
      const start = (input.start_line as number | undefined) ?? 1;
      const end = Math.min((input.end_line as number | undefined) ?? lines.length, lines.length);
      let body = lines
        .slice(start - 1, end)
        .map((line, i) => `${String(start + i).padStart(5)}  ${line}`)
        .join("\n");
      if (body.length > MAX_READ_BYTES) {
        body = `${body.slice(0, MAX_READ_BYTES)}\n... (truncated; read a smaller line range)`;
      }
      return { content: `${toPosix(root, file)} (${lines.length} lines)\n${body}`, isError: false };
    }

    case "search_files": {
      let regex: RegExp;
      try {
        regex = new RegExp(input.pattern as string, "i");
      } catch {
        return { content: "Invalid regular expression.", isError: true };
      }
      const start = resolveInside(root, (input.path as string | undefined) ?? "");
      const matches: string[] = [];
      await walkTextFiles(root, start, async (file) => {
        const text = await readFile(file, "utf8").catch(() => "");
        text.split(/\r?\n/).forEach((line, i) => {
          if (matches.length < MAX_SEARCH_MATCHES && regex.test(line)) {
            matches.push(`${toPosix(root, file)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
        return matches.length < MAX_SEARCH_MATCHES;
      });
      return {
        content: matches.length ? matches.join("\n") + (matches.length >= MAX_SEARCH_MATCHES ? "\n... (more matches omitted)" : "") : "No matches.",
        isError: false,
      };
    }

    case "write_file": {
      const file = resolveInside(root, input.path as string, { forWrite: true });
      const content = input.content as string;
      if (Buffer.byteLength(content) > MAX_WRITE_BYTES) {
        return { content: "File is larger than 1 MB. Split it into smaller modules.", isError: true };
      }
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
      state.changedFiles.add(toPosix(root, file));
      return { content: `Wrote ${toPosix(root, file)} (${content.split("\n").length} lines).`, isError: false };
    }

    case "edit_file": {
      const file = resolveInside(root, input.path as string, { forWrite: true });
      const original = await readFile(file, "utf8");
      // Match regardless of the file's line endings.
      const eol = original.includes("\r\n") ? "\r\n" : "\n";
      const oldText = (input.old_text as string).replace(/\r?\n/g, eol);
      const newText = (input.new_text as string).replace(/\r?\n/g, eol);
      const count = original.split(oldText).length - 1;
      if (count === 0) return { content: "old_text was not found. Read the file again and copy the exact text.", isError: true };
      if (count > 1 && !input.replace_all) {
        return { content: `old_text appears ${count} times. Add surrounding lines to make it unique, or set replace_all.`, isError: true };
      }
      const updated = input.replace_all ? original.split(oldText).join(newText) : original.replace(oldText, () => newText);
      await writeFile(file, updated, "utf8");
      state.changedFiles.add(toPosix(root, file));
      return { content: `Edited ${toPosix(root, file)} (${input.replace_all ? count : 1} replacement${count > 1 && input.replace_all ? "s" : ""}).`, isError: false };
    }

    case "delete_file": {
      const target = resolveInside(root, input.path as string, { forWrite: true });
      if (target === root) return { content: "Refusing to delete the project root.", isError: true };
      await rm(target, { recursive: true, force: true });
      state.changedFiles.add(toPosix(root, target));
      return { content: `Deleted ${toPosix(root, target)}.`, isError: false };
    }

    case "run_command": {
      const parsed = parseCommand(input.command as string);
      if (!parsed.ok) return { content: parsed.error, isError: true };
      const cwd = resolveInside(root, (input.cwd as string | undefined) ?? "");
      const result = await runCommand(parsed.command, cwd);
      const passed = result.exitCode === 0 && !result.timedOut;
      if (parsed.command.isBuildCheck) {
        // Any failing check marks the run as failing until a later check passes.
        state.buildPassed = passed;
      }
      const header = result.timedOut
        ? `TIMED OUT after ${Math.round(result.durationMs / 1000)}s`
        : `Exit code ${result.exitCode} (${Math.round(result.durationMs / 1000)}s)`;
      return { content: `${header}\n${result.output || "(no output)"}`, isError: !passed };
    }
  }
}

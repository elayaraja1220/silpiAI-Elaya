import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseCommand } from "./commands.js";
import { RunState, executeTool } from "./tools.js";
import { PathError, resolveInside } from "./workspace.js";

const root = path.resolve("/tmp/silpi-project");

describe("resolveInside", () => {
  it("resolves normal relative paths", () => {
    expect(resolveInside(root, "src/app/page.tsx")).toBe(path.join(root, "src", "app", "page.tsx"));
    expect(resolveInside(root, "src\\lib\\api.ts")).toBe(path.join(root, "src", "lib", "api.ts"));
  });

  it.each(["../outside.txt", "src/../../x", "/etc/passwd", "C:/Windows/win.ini", "node_modules/x/index.js", ".git/config"])(
    "rejects %s",
    (p) => expect(() => resolveInside(root, p)).toThrow(PathError),
  );

  it("blocks writing secret env files but allows .env.example", () => {
    expect(() => resolveInside(root, ".env", { forWrite: true })).toThrow(PathError);
    expect(() => resolveInside(root, "backend/.env.local", { forWrite: true })).toThrow(PathError);
    expect(resolveInside(root, ".env.example", { forWrite: true })).toBe(path.join(root, ".env.example"));
  });
});

describe("parseCommand", () => {
  it.each([
    "npm install",
    "npm install next@15.5.7 react react-dom",
    "npm install -D typescript @types/node",
    "npm run build",
    "npm run lint",
    "npm test",
    "npx tsc --noEmit",
    "npx prisma generate",
    "php -l src/index.php",
    "python -m py_compile app/main.py",
    "go build ./...",
    "dotnet build",
  ])("allows %s", (cmd) => expect(parseCommand(cmd).ok).toBe(true));

  it.each([
    "npm run dev",
    "npm start",
    "npm exec rimraf /",
    "npm install && rm -rf /",
    "npm install foo;calc",
    "npm install $(whoami)",
    "npm install | more",
    "npx rimraf src",
    "node -e process.exit()",
    "rm -rf node_modules",
    "powershell -c whoami",
    "php artisan serve",
    "python -c print(1)",
    "npm run build ../../x",
  ])("refuses %s", (cmd) => expect(parseCommand(cmd).ok).toBe(false));

  it("flags build checks", () => {
    const build = parseCommand("npm run build");
    const install = parseCommand("npm install");
    expect(build.ok && build.command.isBuildCheck).toBe(true);
    expect(install.ok && install.command.isBuildCheck).toBe(false);
  });
});

describe("file tools", () => {
  let dir: string;
  const state = new RunState();
  const emit = () => {};

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "silpi-test-"));
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "a.ts"), "const a = 1;\r\nconst b = 2;\r\n");
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("writes files and tracks them", async () => {
    const out = await executeTool(dir, "write_file", { path: "src/new/b.ts", content: "export {}\n" }, state, emit);
    expect(out.isError).toBe(false);
    expect(state.changedFiles.has("src/new/b.ts")).toBe(true);
  });

  it("edits files with CRLF line endings", async () => {
    const out = await executeTool(
      dir,
      "edit_file",
      { path: "src/a.ts", old_text: "const a = 1;\nconst b = 2;", new_text: "const a = 10;\nconst b = 20;" },
      state,
      emit,
    );
    expect(out.isError).toBe(false);
    expect(await readFile(path.join(dir, "src", "a.ts"), "utf8")).toBe("const a = 10;\r\nconst b = 20;\r\n");
  });

  it("rejects invalid input and path escapes", async () => {
    expect((await executeTool(dir, "write_file", { path: "x.ts" }, state, emit)).isError).toBe(true);
    expect((await executeTool(dir, "write_file", { path: "../escape.ts", content: "" }, state, emit)).isError).toBe(true);
    expect((await executeTool(dir, "run_command", { command: "npm run dev" }, state, emit)).isError).toBe(true);
  });
});

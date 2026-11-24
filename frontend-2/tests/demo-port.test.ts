// A generated site that hard-codes a port must still start on the free port the demo picks. Run: npm test
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { DEMO_START_COMMAND, startCommandFor } from "@/lib/demo/app-runner";

describe("the command a demo runs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "silpi-port-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const project = (name: string, start?: string, raw?: string) => {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    if (raw !== undefined) writeFileSync(path.join(dir, "package.json"), raw);
    else if (start !== undefined) writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { start } }));
    return dir;
  };

  it("passes the picked port again when the start script hard-codes one (the last flag wins)", () => {
    assert.equal(startCommandFor(project("a", "next start -p 3000"), 4555), `${DEMO_START_COMMAND} -- -p 4555`);
    assert.equal(startCommandFor(project("b", "vite preview --port 5173"), 4555), `${DEMO_START_COMMAND} -- --port 4555`);
    assert.equal(startCommandFor(project("c", "next start -p=3000"), 4555), `${DEMO_START_COMMAND} -- -p 4555`);
  });
  it("leaves every other start script exactly as it is", () => {
    assert.equal(startCommandFor(project("d", "next start"), 4555), DEMO_START_COMMAND);
    assert.equal(startCommandFor(project("e", "node server.js"), 4555), DEMO_START_COMMAND);
    assert.equal(startCommandFor(project("f", "node server.js --max-old-space-size=512"), 4555), DEMO_START_COMMAND);
  });
  it("a missing or damaged package.json never breaks it, and only a whole number is ever added", () => {
    assert.equal(startCommandFor(path.join(root, "nowhere"), 4555), DEMO_START_COMMAND);
    assert.equal(startCommandFor(project("g", undefined, "{ not json"), 4555), DEMO_START_COMMAND);
    assert.equal(startCommandFor(project("h", "next start -p 3000"), 4555.9), `${DEMO_START_COMMAND} -- -p 4555`);
  });
});

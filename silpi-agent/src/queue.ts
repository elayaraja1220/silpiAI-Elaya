import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { config } from "./config.js";
import type { Emit } from "./events.js";

/**
 * Cross-process run queue. Each running agent holds one slot file in
 * <output>/.silpi-queue/; when all slots are taken, new runs wait.
 * Slots left behind by crashed processes are reclaimed automatically.
 */

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const POLL_MS = 3_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tryTake(file: string): Promise<boolean> {
  try {
    const handle = await open(file, "wx");
    await handle.writeFile(String(process.pid), "utf8");
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = Number.parseInt(await readFile(file, "utf8").catch(() => ""), 10);
    // Reclaim slots whose owner is gone (an empty file may be mid-write, so leave it).
    if (Number.isFinite(owner) && owner !== process.pid && !isAlive(owner)) {
      await rm(file, { force: true });
      return tryTake(file);
    }
    return false;
  }
}

export async function acquireRunSlot(emit: Emit, signal?: AbortSignal, slots = config.maxConcurrentRuns): Promise<() => Promise<void>> {
  const dir = path.join(config.outputDir, ".silpi-queue");
  await mkdir(dir, { recursive: true });
  const started = Date.now();
  let lastNotice = 0;

  for (;;) {
    for (let i = 0; i < slots; i++) {
      const file = path.join(dir, `slot-${i}.lock`);
      if (await tryTake(file)) {
        if (lastNotice) emit({ type: "status", message: `A slot is free after ${Math.round((Date.now() - started) / 1000)}s. Starting.` });
        return () => rm(file, { force: true });
      }
    }
    if (signal?.aborted) throw new Error("Run cancelled while waiting in the queue.");
    if (Date.now() - lastNotice > 60_000) {
      emit({
        type: "status",
        message: `Queued: ${slots} run${slots === 1 ? " is" : "s are"} already in progress (limit SILPI_MAX_CONCURRENT_RUNS=${slots}). Waiting for a free slot...`,
      });
      lastNotice = Date.now();
    }
    await sleep(POLL_MS);
  }
}

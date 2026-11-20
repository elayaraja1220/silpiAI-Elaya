#!/usr/bin/env node
import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { Command } from "commander";

import { AnalyzeInputSchema, analyzeRequirement } from "./analyze.js";

import { TaskError, runAgent } from "./agent.js";
import { dockerAvailable } from "./commands.js";
import { AGENT_ROOT, config } from "./config.js";
import { createEmitter } from "./events.js";
import { TaskSchema, type Task } from "./task.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function splitList(value: string | undefined): string[] {
  return value ? value.split(",").map((v) => v.trim()).filter(Boolean) : [];
}

async function execute(raw: unknown, json: boolean): Promise<void> {
  const emit = createEmitter(json);
  const parsed = TaskSchema.safeParse(raw);
  if (!parsed.success) {
    emit({ type: "error", message: `Invalid task: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
    process.exitCode = 2;
    return;
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const result = await runAgent(parsed.data as Task, emit, controller.signal);
    process.exitCode = result.success ? 0 : 1;
  } catch (error) {
    emit({ type: "error", message: error instanceof TaskError || error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

const program = new Command()
  .name("silpi-agent")
  .description("SILPI AI - autonomous project builder powered by Claude")
  .version("1.0.0");

program
  .command("run")
  .description("Run a task given as JSON on stdin (used by the SILPI frontend)")
  .option("--json", "write progress as NDJSON events to stdout", false)
  .action(async (opts: { json: boolean }) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await readStdin());
    } catch {
      createEmitter(opts.json)({ type: "error", message: "stdin must contain one JSON task object." });
      process.exitCode = 2;
      return;
    }
    await execute(raw, opts.json);
  });

program
  .command("analyze")
  .description("Read a client's requirement documents (JSON on stdin) and print a structured draft as JSON")
  .action(async () => {
    const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
    let raw: unknown;
    try {
      raw = JSON.parse(await readStdin());
    } catch {
      print({ success: false, error: "stdin must contain one JSON object." });
      process.exitCode = 2;
      return;
    }
    const parsed = AnalyzeInputSchema.safeParse(raw);
    if (!parsed.success) {
      print({ success: false, error: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
      process.exitCode = 2;
      return;
    }
    try {
      const result = await analyzeRequirement(parsed.data);
      print(result);
      process.exitCode = result.success ? 0 : 1;
    } catch (error) {
      // API errors carry no document content; the key is never printed.
      const message = error instanceof Anthropic.APIError ? `AI service error (${error.status ?? "network"}): ${error.message}` : String(error);
      print({ success: false, error: message });
      process.exitCode = 1;
    }
  });

program
  .command("create")
  .description("Create a new project")
  .argument("<name>", "project folder name")
  .requiredOption("-p, --prompt <text>", "what to build")
  .option("--frontend <list>", "comma-separated, e.g. Next.js")
  .option("--backend <list>", "e.g. Node.js + Express")
  .option("--database <list>", "e.g. PostgreSQL")
  .option("--styling <list>", "e.g. Tailwind CSS")
  .option("--design-url <url>", "design reference URL")
  .option("--json", "NDJSON output", false)
  .action(async (name: string, o: Record<string, string | boolean | undefined>) => {
    await execute(
      {
        mode: "create",
        name,
        description: o.prompt,
        frontend: splitList(o.frontend as string | undefined),
        backend: splitList(o.backend as string | undefined),
        database: splitList(o.database as string | undefined),
        styling: splitList(o.styling as string | undefined),
        designUrl: (o.designUrl as string | undefined) ?? "",
      },
      Boolean(o.json),
    );
  });

program
  .command("edit")
  .description("Change an existing generated project")
  .argument("<name>", "project folder name")
  .requiredOption("-p, --prompt <text>", "what to change")
  .option("--json", "NDJSON output", false)
  .action(async (name: string, o: { prompt: string; json: boolean }) => {
    await execute({ mode: "edit", name, instruction: o.prompt }, o.json);
  });

program
  .command("resume")
  .description("Continue a run that stopped early (crash, budget, turn limit, API error)")
  .argument("<name>", "project folder name")
  .option("--json", "NDJSON output", false)
  .action(async (name: string, o: { json: boolean }) => {
    await execute({ mode: "resume", name }, o.json);
  });

program
  .command("doctor")
  .description("Check the agent's configuration")
  .action(() => {
    const checks: Array<[string, boolean, string]> = [
      ["Node.js >= 20.11", Number(process.versions.node.split(".")[0]) >= 20, process.versions.node],
      ["ANTHROPIC_API_KEY set", Boolean(process.env.ANTHROPIC_API_KEY), process.env.ANTHROPIC_API_KEY ? "yes (hidden)" : "add it to silpi-agent/.env"],
    ];
    if (config.sandbox === "docker") {
      const up = dockerAvailable();
      checks.push(["Docker running (SILPI_SANDBOX=docker)", up, up ? config.dockerImage : "start Docker Desktop or unset SILPI_SANDBOX"]);
    }
    console.log(`INFO  Output folder: ${config.outputDir}${existsSync(config.outputDir) ? "" : " (will be created on first run)"}`);
    for (const [label, ok, detail] of checks) console.log(`${ok ? "OK  " : "FAIL"}  ${label}: ${detail}`);
    console.log(`      Model: ${config.model} (effort ${config.effort}), agent folder: ${AGENT_ROOT}`);
    console.log(`      Budget: $${config.maxCostUsd} per run, ${config.maxTurns} turns max, ${config.maxConcurrentRuns} runs at once`);
    console.log(
      config.sandbox === "docker"
        ? `      Sandbox: docker (${config.dockerImage}) - commands run in a container that only sees the project folder`
        : "WARN  Sandbox: local - commands run directly on this machine. Set SILPI_SANDBOX=docker before serving untrusted users.",
    );
    process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
  });

await program.parseAsync();

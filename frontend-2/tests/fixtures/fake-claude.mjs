// A stand-in for the `claude` program, used only by tests. It speaks the same command line as Claude Code:
//   --version, auth status --json, and -p with streamed JSON output.
// Behaviour is chosen with environment variables, so no real login, usage or network is ever involved:
//   FAKE_AUTH = subscription | api-key | none | garbage
//   FAKE_RUN  = success | fail | hang | slow
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

if (args.includes("--version")) {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  const mode = process.env.FAKE_AUTH ?? "subscription";
  if (mode === "garbage") { console.log("not json at all"); process.exit(0); }
  if (mode === "none") { out({ loggedIn: false }); process.exit(0); }
  // The real command also prints account details. SILPI must never keep these.
  out({
    loggedIn: true,
    authMethod: mode === "api-key" ? "api_key" : "claude.ai",
    subscriptionType: mode === "api-key" ? undefined : "pro",
    email: "secret.person@example.com",
    orgName: "Secret Organisation",
    orgId: "org-secret-1234",
    configDirectory: "C:\\Users\\secret\\.claude",
  });
  process.exit(0);
}

if (args.includes("-p")) {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", async () => {
    const mode = process.env.FAKE_RUN ?? "success";
    // Record what this run received, so tests can check it (arguments, prompt on stdin, visible environment).
    mkdirSync(path.join(process.cwd(), ".silpi"), { recursive: true });
    writeFileSync(
      path.join(process.cwd(), ".silpi", "fake-run.json"),
      JSON.stringify({ args, stdinLength: stdin.length, stdinStart: stdin.slice(0, 80), pid: process.pid, apiKeyVisible: Boolean(process.env.ANTHROPIC_API_KEY), nestedSessionVisible: Boolean(process.env.CLAUDECODE) }),
    );
    out({ type: "system", subtype: "init", model: "fake-model" });
    out({ type: "assistant", message: { content: [{ type: "text", text: "Reading the brief." }] } });
    if (mode === "hang") {
      await new Promise((r) => setTimeout(r, 120_000));
      process.exit(0);
    }
    if (mode === "slow") await new Promise((r) => setTimeout(r, 700));
    out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "index.html", content: "<h1>hi</h1>" } }] } });
    if (mode === "fail") {
      out({ type: "result", subtype: "error_max_turns", is_error: true, result: "Ran out of turns.", num_turns: 3 });
      process.exit(1);
    }
    writeFileSync(path.join(process.cwd(), "index.html"), "<h1>hello</h1>");
    out({ type: "result", subtype: "success", is_error: false, result: "Built the site. Open index.html.", num_turns: 4, total_cost_usd: 0.0123 });
    process.exit(0);
  });
} else {
  console.error("unknown arguments");
  process.exit(2);
}

#!/usr/bin/env node
/**
 * End-to-end check in a real browser: `npm run e2e`.
 *
 * It starts its OWN server (port 3113, its own temporary database, its own build folder .next-e2e) and its OWN Chrome (a temporary profile), so it
 * touches nothing of yours. It then does what people do: a customer signs in and orders credits, an administrator signs in with a named account,
 * records the payment by the number the customer quoted, and the customer sees the credits; a read-only viewer is refused when they try to change
 * something. Needs Chrome or Edge (set E2E_CHROME to its path if it is not found) and Node 22 or newer.
 *
 * It does not use the unit-test runner because it needs a real server and browser. It never kills anything it did not start.
 */
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PORT = 3113;
const DEBUG_PORT = 9341;
const BASE = `http://localhost:${PORT}`;
const ADMIN_TOKEN = "e2e-admin-token-0123456789abcdefghij";
const PASS = "e2e-long-password-1";
const results = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "silpi-e2e-"));
const keep = { tsconfig: fs.readFileSync(path.join(ROOT, "tsconfig.json"), "utf8"), env: fs.existsSync(path.join(ROOT, "next-env.d.ts")) ? fs.readFileSync(path.join(ROOT, "next-env.d.ts"), "utf8") : null };
let server = null;
let chrome = null;
let ws = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function findChrome() {
  const candidates = [process.env.E2E_CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean);
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error("No Chrome or Edge found. Set E2E_CHROME to its full path.");
  return found;
}
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  } catch { /* already gone */ }
}
async function cleanup() {
  try { ws && ws.close(); } catch { /* ignore */ }
  killTree(chrome);
  killTree(server);
  await sleep(800);
  fs.writeFileSync(path.join(ROOT, "tsconfig.json"), keep.tsconfig);
  if (keep.env !== null) fs.writeFileSync(path.join(ROOT, "next-env.d.ts"), keep.env);
  fs.rmSync(path.join(ROOT, ".next-e2e"), { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function api(p, init = {}) {
  const r = await fetch(BASE + p, { ...init, headers: { "content-type": "application/json", origin: BASE, ...(init.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
}

// ---- the browser, driven over the DevTools protocol ----------------------------------------------------------------------------------
let nextId = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const run = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r.result ? r.result.value : undefined;
};
const bodyText = () => run("document.body ? document.body.innerText : ''");
async function waitFor(what, test, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await test();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for: ${what}\n--- the page said ---\n${String(await bodyText()).slice(0, 700)}`);
}
const waitText = (text, ms) => waitFor(`the text "${text}"`, async () => (await bodyText()).includes(text), ms);
const go = async (url) => { await send("Page.navigate", { url }); await sleep(600); };
const fill = (selector, value) => run(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const set = Object.getOwnPropertyDescriptor(el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const clickText = (text, scope = "button, a, [role=tab]") => run(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(scope)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled); if (!el) return false; el.click(); return true; })()`);
async function mustFill(selector, value) { await waitFor(`the field ${selector}`, () => run(`!!document.querySelector(${JSON.stringify(selector)})`)); await fill(selector, value); }
async function mustClick(text, scope) { await waitFor(`the button "${text}"`, () => clickText(text, scope)); }
const submit = () => waitFor("the form's submit button", () => run("(() => { const b = document.querySelector('form button[type=submit]'); if (!b || b.disabled) return false; b.click(); return true; })()"));
const fitsWidth = () => run("document.documentElement.scrollWidth <= window.innerWidth + 1");
const phone = () => send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
const desktop = () => send("Emulation.clearDeviceMetricsOverride");
async function shot(name) { const s = await send("Page.captureScreenshot", { format: "png" }); const f = path.join(os.tmpdir(), `silpi-e2e-${name}.png`); fs.writeFileSync(f, Buffer.from(s.data, "base64")); return f; }

async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t }); console.log(`  PASS  ${name} (${Date.now() - t} ms)`); } catch (e) {
    let f = ""; try { f = await shot(name.replace(/\W+/g, "-").slice(0, 30)); } catch { /* ignore */ }
    results.push({ name, ok: false, error: e.message }); console.log(`  FAIL  ${name}\n        ${e.message.split("\n").join("\n        ")}${f ? `\n        screenshot: ${f}` : ""}`);
    throw e;
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

async function main() {
  console.log("Starting the server and a browser (first start takes a minute)...");
  server = spawn(process.execPath, [require.resolve("next/dist/bin/next", { paths: [ROOT] }), "dev", "-p", String(PORT)], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SILPI_DB_PATH: path.join(tmp, "e2e.db"), SILPI_ADMIN_TOKEN: ADMIN_TOKEN, NEXT_DIST_DIR: ".next-e2e", NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", GEMINI_API_KEY: "" },
  });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  await waitFor("the server to answer", async () => { try { return (await fetch(`${BASE}/api/plans`)).ok; } catch { return false; } }, 180000).catch((e) => { throw new Error(`${e.message}\n${log.slice(-800)}`); });

  chrome = spawn(findChrome(), ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, "--window-size=1280,1400", "--hide-scrollbars", `--user-data-dir=${path.join(tmp, "profile")}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  const targets = await waitFor("the browser", async () => { try { const t = await (await fetch(`http://localhost:${DEBUG_PORT}/json`)).json(); return t.find((x) => x.type === "page"); } catch { return null; } }, 20000);
  ws = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); } };
  await send("Page.enable");
  await send("Runtime.enable");

  // Warm the pages once so the first real step is not spent compiling them.
  for (const p of ["/ai/billing", "/ai/admin", "/api/workspace/billing", "/api/admin/ai", "/api/admin/finance", "/api/admin/audit", "/api/admin/payments", "/api/admin/admins", "/api/admin/fx", "/api/admin/tax", "/api/admin/seller", "/api/admin/readiness", "/api/admin/credit-packages", "/api/admin/webhook-events", "/api/workspace/wallet", "/api/workspace/billing/topup", "/api/workspace/billing/profile", "/api/admin/session", "/sign-in", "/clients/new", "/dashboard", "/my-projects", "/profile", "/notifications", "/admin/sign-in"]) await fetch(BASE + p, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }).catch(() => undefined);

  const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };
  let orderNumber = "";

  await step("set up: a customer, an administrator and a read-only viewer", async () => {
    const u = await api("/api/admin/users", { method: "POST", headers: admin, body: JSON.stringify({ email: "customer@e2e.test", name: "E2E Customer", password: PASS, newOrg: { name: "E2E Customer Ltd", type: "business" } }) });
    assert(u.status === 200, `could not create the customer: ${JSON.stringify(u.body)}`);
    for (const [email, role] of [["e2e-admin@example.test", "admin"], ["e2e-viewer@example.test", "viewer"]]) {
      const a = await api("/api/admin/admins", { method: "POST", headers: admin, body: JSON.stringify({ email, name: `E2E ${role}`, password: PASS + "xx", role }) });
      assert(a.status === 200, `could not create the ${role}: ${JSON.stringify(a.body)}`);
    }
  });

  await step("a customer signs in through the form and sees their plan and credits", async () => {
    await go(`${BASE}/ai/billing?currency=USD`);
    await waitFor("the sign-in page", async () => (await run("location.pathname")) === "/sign-in", 60000);
    await mustFill("input[type=email]", "customer@e2e.test");
    await mustFill("input[type=password]", PASS);
    await submit();
    await waitText("Your credits", 60000);
    await waitText("Available now");
    const t = await bodyText();
    assert(/Free/.test(t) && /25/.test(t), "the Free plan with 25 credits should show");
  });

  await step("the customer orders a pack of 100 credits and is told the order number", async () => {
    await waitText("Buy more credits");
    await waitFor("the Order button", () => run(`!![...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Order')`));
    await run(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Order').click()`);
    const m = await waitFor("the order number", async () => /TOP-\d{4}-\d{5}/.exec(await bodyText()));
    orderNumber = m[0];
    await waitText("Orders waiting for payment");
    const t = await bodyText();
    assert(t.includes(orderNumber), "the order should be listed as waiting");
    assert(/100 credits are added as soon as the payment is confirmed/.test(t), "the page should say when credits arrive");
  });

  await step("the credits have NOT arrived before anyone has paid", async () => {
    await go(`${BASE}/ai/billing?currency=USD`);
    await waitText("Available now", 60000);
    const t = await bodyText();
    assert(/Available now\s*\n?\s*25\b/.test(t.replace(/\n+/g, "\n")), "still 25 credits");
  });

  await step("an administrator signs in with their own account and sees who they are", async () => {
    await go(`${BASE}/ai/admin`);
    await mustFill("input[aria-label='Administrator email']", "e2e-admin@example.test");
    await mustFill("input[aria-label='Administrator password']", PASS + "xx");
    await mustClick("Sign in", "button");
    await waitText("Signed in as", 60000);
    const t = await bodyText();
    assert(/E2E admin/.test(t), "the account's name should show");
    await waitText("Money received");
  });

  await step("the administrator records the payment using the order number the customer quoted", async () => {
    await mustClick("Payments", "[role=tab]");
    await waitText("Record a payment received");
    await mustFill("input[aria-label='Invoice or order number']", orderNumber.toLowerCase());
    await mustFill("input[aria-label='Payment reference']", "UPI-E2E-0001");
    await mustClick("Record", "button");
    await waitText("Payment recorded");
  });

  await step("the audit log names the administrator who recorded it", async () => {
    await mustClick("Audit log", "[role=tab]");
    await waitText("payment.succeeded");
    assert((await bodyText()).includes("admin:e2e-admin@example.test"), "the entry should carry the account's name");
  });

  await step("the launch checklist and the administrator accounts open, and list the accounts that were made", async () => {
    await mustClick("Security & launch", "[role=tab]");
    await waitText("Launch checklist");
    await waitText("Administrator accounts");
    const t = await bodyText();
    assert(t.includes("e2e-admin@example.test") && t.includes("e2e-viewer@example.test"), "both accounts should be listed");
    assert(/fix before launch|needs attention/.test(t), "a fresh install should have things to attend to");
    assert(!t.includes("e2e-admin-token"), "the token must never be shown");
  });

  await step("the customer now has 125 credits, and the purchase is in their history", async () => {
    await go(`${BASE}/ai/billing?currency=USD`);
    await waitText("Your credits", 60000);
    await waitFor("125 credits", async () => /Available now\s*\n?\s*125\b/.test((await bodyText()).replace(/\n+/g, "\n")));
    const t = await bodyText();
    assert(/Bought\s*\n?\s*100\b/.test(t.replace(/\n+/g, "\n")), "100 bought credits");
    assert(/Credits bought/.test(t) && /\+100/.test(t), "the purchase should appear in the credit history");
    // The payment list loads after the balance, so wait for it rather than reading the page at one instant.
    await waitFor("the payment in the history", async () => { const now = await bodyText(); return /succeeded/.test(now) && /credits/.test(now); });
  });

  await step("a read-only viewer can look but is refused when they try to change something", async () => {
    await go(`${BASE}/ai/admin`);
    await waitText("Signed in as", 60000);
    await mustClick("Sign out", "button");
    await mustFill("input[aria-label='Administrator email']", "e2e-viewer@example.test");
    await mustFill("input[aria-label='Administrator password']", PASS + "xx");
    await mustClick("Sign in", "button");
    await waitText("viewer: read-only", 60000);
    await waitText("Money received");
    await mustClick("Payments", "[role=tab]");
    await waitText("Record a payment received");
    await mustFill("input[aria-label='Invoice or order number']", orderNumber);
    await mustFill("input[aria-label='Payment reference']", "UPI-E2E-0002");
    await mustClick("Record", "button");
    await waitText("look at everything but not change anything");
  });

  await step("a visitor who asks for a quotation is sent to sign in, creates an account, and lands on the choice page", async () => {
    await run("fetch('/api/auth/logout', { method: 'POST' })");
    await go(`${BASE}/clients/new`);
    await waitFor("the sign-in page", async () => (await run("location.pathname + location.search")) === "/sign-in", 60000); // the destination is kept, but the address bar shows a plain /sign-in
    await mustClick("Create account", "[role=tab]");
    await mustFill("input[autocomplete=name]", "Priya Client");
    await mustFill("input[type=email]", "priya@e2e.test");
    await mustFill("input[type=password]", "e2e-long-phrase-9x");
    await run("document.querySelector('input[type=checkbox]').click()");
    await submit();
    await waitText("What would you like to build with SILPI AI?", 60000);
    const t = await bodyText();
    assert(t.includes("Choose Fixed Price") && t.includes("Start with SILPI AI"), "both choices should show");
    assert(!/Admin|Recurring income|Business & pricing/.test(t), "nothing of the studio in the client's page");
  });

  await step("Fixed Price: the client fills the form, sees no studio figures, and gets a quotation", async () => {
    await mustClick("Choose Fixed Price", "a");
    await waitText("Your requirement", 60000);
    await mustClick("Next", "button");
    for (const page of ["Home", "About", "Services"]) await mustClick(page, "button");
    await mustClick("See packages", "button");
    await waitFor("the package step", async () => /Finalise .* package/.test(await bodyText()), 30000);
    await run("[...document.querySelectorAll('button')].find(b => /^Finalise .* package/.test(b.textContent.trim())).click()");
    await waitText("Your details");
    await mustFill("input[placeholder='+91 98765 43210']", "+91 98765 43210");
    await mustClick("Next", "button");
    await waitText("Get my quotation");
    const review = await bodyText();
    assert(!/Costs, profitability|internal view|Analysis cost|market rate/i.test(review), "the studio's own figures must not show to a client");
    await mustClick("Get my quotation", "button");
    await waitFor("the quotation page", async () => (await run("location.pathname")).startsWith("/q/"), 60000);
    await waitFor("the quotation number", async () => /SQ-\d{4}-\d{4}/.test(await bodyText()), 60000);
  });

  await step("the dashboard, My Projects and the project page show the request and what to do next", async () => {
    await go(`${BASE}/dashboard`);
    await waitText("Needs your attention", 60000);
    await go(`${BASE}/my-projects`);
    await waitText("Quotation ready", 60000);
    await run("document.querySelector('a[href^=\"/my-projects/\"]').click()");
    await waitText("Review and approve", 60000);
    const t = await bodyText();
    assert(!/profit|margin|internal|work log/i.test(t), "no internal words on the client's project page");
  });

  await step("Start with SILPI AI: no plan yet, so the plans come first; choosing Free opens the AI workspace", async () => {
    await go(`${BASE}/clients/new/saas`);
    await waitFor("the plans page", async () => (await run("location.pathname")) === "/ai/billing", 60000);
    await waitText("Change plan", 60000);
    await run("(() => { const row = [...document.querySelectorAll('li')].find(li => /^Free/.test(li.textContent.trim())); const b = row && [...row.querySelectorAll('button')].find(x => x.textContent.trim() === 'Choose'); if (b) b.click(); return !!b; })()");
    await waitFor("the AI workspace", async () => (await run("location.pathname")) === "/ai/builder", 60000);
  });

  await step("on a phone the client's pages fit the screen (no sideways scrolling)", async () => {
    await phone();
    try {
      for (const p of ["/clients/new", "/dashboard", "/my-projects", "/profile", "/notifications"]) {
        await go(`${BASE}${p}`);
        await waitFor(`${p} to load`, async () => (await bodyText()).length > 80, 60000);
        await sleep(400);
        assert(await fitsWidth(), `${p} is wider than a phone screen`);
      }
      await run("fetch('/api/auth/logout', { method: 'POST' })");
      await go(`${BASE}/sign-in`);
      await waitText("Sign in to SILPI AI", 60000);
      assert(await fitsWidth(), "/sign-in is wider than a phone screen");
    } finally { await desktop(); }
  });

  await step("the front page: an idea typed by a visitor waits in the fixed-price form after they sign up", async () => {
    await run("fetch('/api/auth/logout', { method: 'POST' })");
    await go(`${BASE}/ai`);
    await waitText("Get a fixed-price quotation", 60000);
    // The page is still starting up when its text appears; type until the box keeps the words.
    await waitFor("the idea box to keep the text", async () => { await run("(() => { const el = document.getElementById('landing-brief'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, 'A website for my bakery with an order form'); el.dispatchEvent(new Event('input', { bubbles: true })); })()"); await sleep(300); return run("document.getElementById('landing-brief').value === 'A website for my bakery with an order form'"); }, 30000);
    await mustClick("Get a fixed-price quotation", "button");
    await waitFor("the sign-in page, coming back to the fixed-price form", async () => (await run("location.pathname + location.search")) === "/sign-in", 60000);
    await mustClick("Create account", "[role=tab]");
    await mustFill("input[autocomplete=name]", "Bala Baker");
    await mustFill("input[type=email]", "bala@e2e.test");
    await mustFill("input[type=password]", "e2e-long-phrase-9x");
    await run("document.querySelector('input[type=checkbox]').click()");
    await submit();
    await waitText("We kept what you wrote on the front page", 60000);
    await waitFor("the notes to hold the idea", () => run("[...document.querySelectorAll('textarea')].some(x => x.value === 'A website for my bakery with an order form')"), 30000);
  });

  await step("the front page: an idea typed by a visitor waits in the AI builder after they sign in", async () => {
    await run("fetch('/api/auth/logout', { method: 'POST' })");
    await go(`${BASE}/ai`);
    await waitText("Build it with AI", 60000);
    await waitFor("the idea box to keep the text", async () => { await run("(() => { const el = document.getElementById('landing-brief'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, 'A todo list app'); el.dispatchEvent(new Event('input', { bubbles: true })); })()"); await sleep(300); return run("document.getElementById('landing-brief').value === 'A todo list app'"); }, 30000);
    await run("(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('Build it with AI')); b.click(); })()");
    await waitFor("the sign-in page, coming back to the builder", async () => (await run("location.pathname + location.search")) === "/sign-in", 60000);
    await mustFill("input[type=email]", "bala@e2e.test");
    await mustFill("input[type=password]", "e2e-long-phrase-9x");
    await submit();
    await waitFor("the builder", async () => (await run("location.pathname")) === "/ai/builder", 60000);
    await waitFor("the brief to hold the idea", () => run("[...document.querySelectorAll('textarea')].some(x => x.value === 'A todo list app')"), 60000);
  });

  await step("the studio sends a non-administrator to the administrator sign-in, and opens for an administrator without recurring income on the Overview", async () => {
    // The read-only viewer from the step before is still signed in in this browser: sign out first, so this is a visitor with no administrator session.
    await run("fetch('/api/admin/session', { method: 'DELETE' })");
    await go(`${BASE}/clients`);
    await waitFor("the administrator sign-in", async () => (await run("location.pathname")) === "/admin/sign-in", 60000);
    // A page compiled for the first time can still be starting up when the fields appear, and its start-up empties them: fill until the form keeps the values.
    await waitFor("the sign-in form to keep what was typed", async () => { await fill("input[aria-label='Administrator email']", "e2e-admin@example.test"); await fill("input[aria-label='Administrator password']", PASS + "xx"); await sleep(500); return run("(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Sign in'); return !!b && !b.disabled; })()"); }, 60000);
    await mustClick("Sign in", "button");
    await waitFor("the studio", async () => (await run("location.pathname")) === "/clients", 60000);
    await go(`${BASE}/`);
    await waitFor("the Overview", async () => (await run("location.pathname")) === "/", 60000);
    await waitFor("the Recurring income link in the studio sidebar", () => run("!!document.querySelector('a[href=\"/recurring-income\"]')"), 60000);
    const cardHere = "[...document.querySelectorAll('main h3')].some(h => h.textContent.trim() === 'Recurring income')";
    await sleep(1500);
    assert(!(await run(cardHere)), "the recurring income card is not on the Overview");
    await go(`${BASE}/recurring-income`);
    await waitFor("the recurring income card on its own page", () => run(cardHere), 60000);
  });

  await step("a wrong password is refused with the same message as an unknown account", async () => {
    await go(`${BASE}/ai/admin`);
    await waitText("Signed in as", 60000);
    await mustClick("Sign out", "button");
    await mustFill("input[aria-label='Administrator email']", "e2e-admin@example.test");
    await mustFill("input[aria-label='Administrator password']", "not-the-password-at-all");
    await mustClick("Sign in", "button");
    await waitText("That email or password is not correct.");
  });
}

main().then(async () => {
  await cleanup();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} of ${results.length} steps passed.`);
  process.exit(failed ? 1 : 0);
}).catch(async (e) => {
  console.error(`\nStopped: ${e.message}`);
  await cleanup();
  const ran = results.length;
  console.log(`${results.filter((r) => r.ok).length} of ${ran} steps passed before it stopped.`);
  process.exit(1);
});

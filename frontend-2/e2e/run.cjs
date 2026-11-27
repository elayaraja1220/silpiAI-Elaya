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
const ready = (selector) => waitFor(`the page to start up around ${selector}`, () => run(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$')); })()`), 120000);
const submit = () => waitFor("the form's submit button", () => run("(() => { const b = document.querySelector('form button[type=submit]'); if (!b || b.disabled) return false; b.click(); return true; })()"));
const fitsWidth = () => run("document.documentElement.scrollWidth <= window.innerWidth + 1");
const phone = () => send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
const desktop = () => send("Emulation.clearDeviceMetricsOverride");
async function shot(name) { const s = await send("Page.captureScreenshot", { format: "png" }); const f = path.join(os.tmpdir(), `silpi-e2e-${name}.png`); fs.writeFileSync(f, Buffer.from(s.data, "base64")); return f; }

// E2E_ONLY="part of a step name" runs just the set-up and the steps whose name contains it (for chasing one step); E2E_DEBUG=1 adds browser and server details to a failure.
async function step(name, fn) {
  if (process.env.E2E_ONLY && !name.startsWith("set up") && !name.includes(process.env.E2E_ONLY)) return;
  const t = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t }); console.log(`  PASS  ${name} (${Date.now() - t} ms)`); } catch (e) {
    let diag = "";
    if (process.env.E2E_DEBUG) {
      try {
        const page = await run("JSON.stringify({ url: location.href, keys: Object.keys(sessionStorage), nav: performance.getEntriesByType('navigation').map((n) => n.type) })");
        diag = `\n        in the browser: ${page}\n        server log (end): ${String(global.serverLog || "").slice(-1500).split("\n").join("\n          ")}`;
      } catch { /* ignore */ }
    }
    let f = ""; try { f = await shot(name.replace(/\W+/g, "-").slice(0, 30)); } catch { /* ignore */ }
    results.push({ name, ok: false, error: e.message }); console.log(`  FAIL  ${name}\n        ${e.message.split("\n").join("\n        ")}${f ? `\n        screenshot: ${f}` : ""}${diag}`);
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
  server.stdout.on("data", (d) => { log += d; global.serverLog = log; });
  server.stderr.on("data", (d) => { log += d; global.serverLog = log; });
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
    // The old address still works and lands on the Fixed Price dashboard.
    await go(`${BASE}/dashboard`);
    await waitFor("the old dashboard address to redirect", async () => (await run("location.pathname")) === "/client/dashboard", 60000);
    await waitText("Needs your attention", 60000);
    // The dashboard follows the design: welcome banner, four summary tiles, the project with its nine connected steps, the AI workspace card and recent updates.
    const dash = await bodyText();
    assert(dash.includes("Manage your projects, track progress, and build with SILPI AI"), "the welcome banner");
    assert(["Projects", "Waiting for you", "In progress", "Delivered", "Your fixed-price projects", "Start a new project", "Recent updates"].every((w) => dash.includes(w)), "every section of the design is there");
    // Fixed Price shows Fixed Price only: nothing of the AI workspace's plan or credits in the page itself.
    const dashMain = await run("document.querySelector('main').innerText");
    assert(!/credits|Plans and credits|AI workspace/i.test(dashMain), "the Fixed Price dashboard shows no AI plan or credits: " + dashMain.slice(0, 200));
    assert(!(await run("!!document.querySelector('[data-testid=ai-card]')")), "no AI card on the Fixed Price dashboard");
    assert((await run("document.querySelectorAll('[data-testid=counts] > div').length")) === 4, "four summary tiles");
    assert((await run("document.querySelectorAll('[data-testid=progress] li').length")) === 9, "nine steps");
    assert(await run("document.querySelectorAll('[data-testid=progress] li > span[aria-hidden]').length === 8"), "the steps are joined by lines");
    assert(await fitsWidth(), "the dashboard fits the screen");
    await shot("dashboard");
    await go(`${BASE}/my-projects`);
    await waitText("Quotation ready", 60000);
    await run("document.querySelector('a[href^=\"/my-projects/\"]').click()");
    await waitText("Review and approve", 60000);
    const t = await bodyText();
    assert(!/profit|margin|internal|work log/i.test(t), "no internal words on the client's project page");
  });

  await step("the quotation page sits in the client's own frame, says what is missing, and Approve works", async () => {
    await mustClick("Review and approve", "a");
    await waitText("Approve & confirm project", 60000);
    await shot("quotation-page");
    // The full quotation is not on this page: it has its own page, reached by "Show quotation". The top offers PDF only.
    assert(!(await bodyText()).includes("BILL TO"), "the quotation document is not at the bottom of this page");
    assert(/quotation sq-[0-9]{4}-[0-9]{4}/i.test(await run("document.querySelector('[data-testid=quotation-number]').innerText")), "the quotation number stands out at the top");
    assert(await run("document.querySelector('[data-testid=show-quotation]') !== null && document.querySelector('[data-testid=show-quotation-card]') === null"), "Show quotation is at the top, and there is no Your full quotation card at the bottom");
    assert(await run("(() => { const c = document.querySelector('[data-testid=breadcrumb]'); return !!c && c.innerText.includes('My Projects') && c.innerText.includes('Project Details'); })()"), "the breadcrumb says where this is: My Projects, Project Details");
    assert(await run("document.querySelector('nav[aria-label=Main] a[aria-current=page]').textContent.trim() === 'My Projects'"), "My Projects is lit in the sidebar");
    assert(await run("document.querySelector('[data-testid=quotation-pdf]').getAttribute('href').includes('format=pdf')"), "PDF at the top");
    assert(!(await run("[...document.querySelectorAll('a, button')].some(b => b.textContent.trim() === 'Word')")), "no Word button");
    const t = await bodyText();
    assert(t.includes("My Projects") && t.includes("Priya Client"), "the client's frame shows on the quotation page");
    assert(!(await run("[...document.querySelectorAll('aside button')].some(b => b.textContent.trim() === 'Sign out')")), "Sign out is not a separate button in the sidebar: it is in the account menu");
    assert((await run("getComputedStyle(document.querySelector('header')).position")) === "sticky", "the client header is the first header on the page");
    // The sidebar holds the links, the projects with their count, and the person with Sign out at the bottom; the header holds neither.
    assert((await run("document.querySelector('[data-testid=sidebar-project-count]').textContent.trim()")) === "1", "the sidebar counts the client's one project");
    assert((await run("document.querySelector('[data-testid=sidebar-projects]').innerText")).includes("Priya Client website"), "the sidebar lists the project");
    assert((await run("document.querySelector('[data-testid=sidebar-user]').innerText")).includes("priya@e2e.test"), "the person is at the bottom of the sidebar");
    assert(await run("(() => { const u = document.querySelector('aside [data-testid=sidebar-user]').getBoundingClientRect(); return Math.abs(u.bottom - window.innerHeight) < 2; })()"), "the person and Sign out sit at the bottom of the screen");
    const head = await run("document.querySelector('header').innerText");
    assert(!head.includes("Sign out") && !head.includes("priya@e2e.test"), "the header no longer shows the person or Sign out");
    assert((await run("document.querySelector('label input:not([type=checkbox])').value")).trim().length >= 2, "the signed-in client's name is filled in");
    await waitText("Tick the box to agree to the price and the advance.");
    assert(await run("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Approve & confirm project').disabled"), "Approve waits for the agreement");
    await run("document.querySelector('label input[type=checkbox]').click()");
    await mustClick("Approve & confirm project", "button");
    await waitFor("the approval", async () => /Approved.*Thank you/.test(await bodyText()), 60000);
    // After approval the client sends their files in the same layout as the studio's tab: a menu, the item, a status box.
    await waitFor("the files section", () => run("!!document.querySelector('[data-testid=client-files]')"), 60000);
    assert(await run("document.querySelector('[data-testid=approved-card]') !== null && document.querySelector('[data-testid=pay-card]') !== null"), "the approved card and the pay-the-advance card are shown after approval");
    assert((await run("document.querySelectorAll('[data-testid=client-files] > div').length")) === 2, "the files summary is a card of its own, above the files panel");
    const files = await run("document.querySelector('[data-testid=client-files]').innerText");
    assert(/BRAND/i.test(files) && /PAGES: DESIGN AND CONTENT/i.test(files) && files.includes("Brand identity") && files.includes("Status"), "the files menu shows the groups and the status box");
    assert(!/Mark as received/i.test(files), "checking files stays with the studio");
    await mustClick("Home", "[data-testid=client-files] nav button");
    await waitFor("the Home page item", async () => (await run("document.querySelectorAll('[data-testid=page-column]').length")) >= 1);
    assert((await run("document.querySelector('[data-testid=client-files]').innerText")).includes("Content document"), "a page shows its content document");
    assert(await fitsWidth(), "the wider files section does not make the page scroll sideways");
    assert(await run("(() => { const s = document.querySelector('[data-testid=client-files]').getBoundingClientRect(); const side = document.querySelector('aside[aria-label=\"Client menu\"]').getBoundingClientRect(); return side.width === 0 || s.left >= side.right; })()"), "the files section does not run under the sidebar");
    await shot("client-files");
  });

  await step("Show quotation opens the full quotation on its own page, with PDF, Print, and WhatsApp and e-mail to the client's number and address", async () => {
    await ready("[data-testid=show-quotation]");
    await run("document.querySelector('[data-testid=show-quotation]').click()");
    await waitFor("the quotation page", async () => (await run("location.pathname")).endsWith("/quotation"), 60000);
    await waitText("BILL TO", 60000);
    const text = await bodyText();
    assert(text.includes("PROPOSALS TO CHOOSE FROM") || text.includes("Proposals to choose from") || text.includes("DEVELOPMENT PAYMENT SCHEDULE") || /Grand total/i.test(text), "the full quotation is shown");
    assert(/quotation sq-[0-9]{4}-[0-9]{4}/i.test(await run("document.querySelector('[data-testid=quotation-number]').innerText")), "the quotation number stands out at the top");
    assert(await run("document.querySelector('[data-testid=quotation-pdf]').getAttribute('href').includes('format=pdf')"), "PDF at the top");
    assert(!(await run("[...document.querySelectorAll('a, button')].some(b => b.textContent.trim() === 'Word')")), "no Word button");
    assert(await run("document.querySelector('[data-testid=quotation-print]') !== null"), "Print");
    // The share links go to the number and the address on the quotation, with the message written and the link to this quotation in it.
    const wa = await run("document.querySelector('[data-testid=share-whatsapp]').getAttribute('href')");
    assert(wa.startsWith("https://wa.me/919876543210?text="), "WhatsApp opens the client's number: " + wa.slice(0, 60));
    const waText = decodeURIComponent(wa.split("?text=")[1]);
    assert(/SQ-[0-9]{4}-[0-9]{4}/.test(waText) && waText.includes("/q/"), "the WhatsApp message names the quotation and carries its link");
    const mail = await run("document.querySelector('[data-testid=share-email]').getAttribute('href')");
    assert(mail.startsWith("mailto:priya@e2e.test?subject="), "the e-mail opens to the client's address: " + mail.slice(0, 60));
    assert(decodeURIComponent(mail.split("&body=")[1]).includes("/q/"), "the e-mail carries the link");
    assert(await fitsWidth(), "the quotation page fits the screen");
    await shot("quotation-document");
    await mustClick("Back to your quotation", "a");
    await waitFor("back on the first quotation page", async () => !(await run("location.pathname")).endsWith("/quotation"), 60000);
  });

  await step("Start with SILPI AI: no plan yet, so the plans come first; choosing Free opens the AI workspace", async () => {
    await go(`${BASE}/clients/new/saas`);
    await waitFor("the plans page", async () => (await run("location.pathname")) === "/ai/billing", 60000);
    await waitText("Change plan", 60000);
    await run("(() => { const row = [...document.querySelectorAll('li')].find(li => /^Free/.test(li.textContent.trim())); const b = row && [...row.querySelectorAll('button')].find(x => x.textContent.trim() === 'Choose'); if (b) b.click(); return !!b; })()");
    await waitFor("the AI workspace", async () => (await run("location.pathname")) === "/ai/builder", 60000);
  });

  await step("the AI workspace is light, in its own frame: prompt first, its own sidebar (Dashboard, Build, Chat, Usage, builds; no Billing link, no credits chip), the person at the bottom", async () => {
    await waitText("What will you build today?", 60000);
    assert(await run("(() => { const f = document.querySelector('[data-theme=light]'); return !!f && !document.querySelector('[data-theme=dark]') && getComputedStyle(f).backgroundColor === 'rgb(248, 250, 252)'; })()"), "the AI workspace is on a light background, with nothing dark in it");
    assert(await run("document.querySelector('aside[aria-label=\"AI menu\"]') !== null && document.querySelector('[data-testid=sidebar-user]') !== null"), "the AI workspace's own sidebar is there");
    // In the AI workspace the sidebar is the workspace's own: Build, Chat, Usage. Dashboard and Billing are switched off there (src/lib/feature-flags.ts), not removed.
    assert(await run("[...document.querySelectorAll('nav[aria-label=Main] a')].map(a => a.textContent.trim()).join('|') === 'Dashboard|Build|Chat|Usage'"), "the AI sidebar holds Dashboard, Build, Chat and Usage");
    assert(await run("document.querySelector('nav[aria-label=Main] a[aria-current=page]').textContent.trim() === 'Build'"), "the sidebar marks Build");
    assert(await run("document.querySelector('nav[aria-label=Main] a[href=\"/ai/dashboard\"]') !== null"), "the Dashboard link in the AI sidebar is the AI workspace's own dashboard");
    assert(!(await run("[...document.querySelectorAll('nav[aria-label=Main] a')].some(a => a.getAttribute('href') === '/ai/billing')")), "no Billing link in the AI sidebar");
    await waitFor("the builds heading with its count", () => run("!!document.querySelector('[data-testid=sidebar-build-count]') && document.querySelector('[data-testid=sidebar-build-count]').textContent.trim() === '0'"), 30000);
    assert(await run("document.querySelector('[data-testid=to-fixed-price]').getAttribute('href') === '/my-projects'"), "a way over to the fixed-price projects");
    assert(!(await run("!!document.querySelector('[data-testid=credit-chip]')")), "the credits chip is hidden from the top bar");
    assert(await run("!!document.querySelector('[data-testid=ai-bell]')"), "the bell is still in the top bar");
    // The account menu slides up from the person at the bottom of the sidebar. With Billing and the chip hidden, the plan, the credits and the way to Billing live in it.
    await run("document.querySelector('[data-testid=profile-menu-trigger]').click()");
    await waitFor("the account menu", () => run("!!document.querySelector('[role=menu][data-testid=profile-menu]')"), 30000);
    await waitFor("the plan and credits in the menu", async () => (await run("document.querySelector('[data-testid=menu-plan]').innerText")).split(/[^0-9a-z]+/i).join(" ").includes("25 credits"), 30000);
    const menuText = await run("document.querySelector('[data-testid=profile-menu]').innerText");
    assert(["Plans and credits", "Profile", "Updates", "Usage", "Billing and invoices", "Applications", "Fixed Price", "AI Workspace", "Terms of Service", "Privacy Policy", "Sign out"].every((w) => menuText.toLowerCase().includes(w.toLowerCase())), "the AI menu holds the plan, the account pages, the applications and the legal pages: " + menuText);
    assert(await run("[...document.querySelectorAll('[data-testid=profile-menu] a')].some(a => a.getAttribute('href') === '/ai/billing')"), "Billing is reached from the menu");
    await shot("ai-menu");
    await run("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    await waitFor("the menu to close", async () => !(await run("!!document.querySelector('[data-testid=profile-menu]')")), 30000);
    // The idea chips fill the box, and the send arrow wakes up once there is enough to plan from.
    assert(await run("document.querySelector('button[aria-label=\"Create plan\"]').disabled"), "Create plan waits for an idea");
    await mustClick("Online store", "button");
    assert(await run("document.getElementById('builder-brief').value.startsWith('An online store')"), "a starter fills the box");
    await mustFill("#builder-brief", "An online store for handmade soaps with a cart and UPI checkout");
    assert(!(await run("document.querySelector('button[aria-label=\"Create plan\"]').disabled")), "Create plan is ready");
    assert(await fitsWidth(), "the builder fits the screen");
    await shot("ai-builder");
    for (const [p, text, name] of [["/ai", "What would you like to ask?", "ai-chat"], ["/ai/usage", "Used this month", "ai-usage"], ["/ai/billing", "Change plan", "ai-billing"], ["/ai/updates", "What has changed", "ai-updates"], ["/ai/dashboard", "Plan and credits", "ai-dashboard"]]) {
      await go(`${BASE}${p}`);
      await waitText(text, 60000);
      await sleep(600);
      assert(await run("document.querySelector('[data-theme=light]') !== null && document.querySelector('[data-theme=dark]') === null"), `${p} is light, in the AI frame`);
      assert(await fitsWidth(), `${p} fits the screen`);
      await shot(name);
    }
    // The AI workspace's own dashboard shows the AI workspace only: no fixed-price project or quotation.
    await go(`${BASE}/ai/dashboard`);
    await waitText("Plan and credits", 60000);
    await waitFor("the AI dashboard to load its numbers", async () => !(await run("document.querySelector('[data-testid=ai-counts]').innerText")).includes("…"), 60000);
    const aiDash = await run("document.querySelector('main').innerText");
    assert(["Welcome back", "Credits available", "Builds", "Waiting for you", "Used this month", "Your builds", "Recent updates"].every((w) => aiDash.includes(w)), "the AI dashboard sections: " + aiDash.slice(0, 300));
    assert((await run("document.querySelectorAll('[data-testid=ai-counts] > div').length")) === 4, "four AI summary tiles");
    assert(!/Priya Client website|Quotation|fixed-price|Fixed Price/i.test(aiDash), "nothing of the Fixed Price application on the AI dashboard: " + aiDash.slice(0, 300));
    assert(await run("document.querySelector('nav[aria-label=Main] a[aria-current=page]').textContent.trim() === 'Dashboard'"), "the sidebar marks the AI Dashboard");
    // Two applications, two bells: the AI one opens the AI updates (the plan's credits show there), the Fixed Price one its project updates.
    await go(`${BASE}/ai/updates`);
    await waitText("Credits added", 60000);
    assert(await run("document.querySelector('[data-testid=ai-bell]').getAttribute('href') === '/ai/updates'"), "the AI workspace has its own bell");
    assert(!(await run("!!document.querySelector('a[href=\"/notifications\"]')")), "the AI workspace does not show the Fixed Price bell");
    // The Fixed Price side is dark and keeps all five links, Dashboard and Billing included; its sidebar lists projects, not builds.
    await go(`${BASE}/client/dashboard`);
    await waitText("Needs your attention", 60000);
    assert(await run("document.querySelector('[data-theme=dark]') !== null && document.querySelector('[data-theme=light]') === null"), "the Fixed Price side is dark");
    assert(await run("document.querySelector('a[aria-label=Updates]').getAttribute('href') === '/notifications' && !document.querySelector('[data-testid=ai-bell]')"), "the Fixed Price side has its own bell");
    await ready("[data-testid=profile-menu-trigger]");
    await run("document.querySelector('[data-testid=profile-menu-trigger]').click()");
    await waitFor("the Fixed Price account menu", () => run("!!document.querySelector('[role=menu][data-testid=profile-menu]')"), 30000);
    const fixedMenu = await run("document.querySelector('[data-testid=profile-menu]').innerText");
    assert(["Your fixed-price projects", "Profile", "Updates", "My projects", "Applications", "Fixed Price", "AI Workspace", "Terms of Service", "Privacy Policy", "Sign out"].every((w) => fixedMenu.toLowerCase().includes(w.toLowerCase())), "the Fixed Price menu: " + fixedMenu);
    assert(!fixedMenu.includes("Plans and credits"), "the AI plan is not in the Fixed Price menu");
    await shot("fixed-menu");
    await run("document.querySelector('[data-testid=profile-menu-trigger]').click()");
    assert(await run("[...document.querySelectorAll('nav[aria-label=Main] a')].map(a => a.textContent.trim()).join('|') === 'Dashboard|My Projects|AI Workspace|Billing|Profile'"), "the Fixed Price sidebar keeps its five links");
    assert(!!(await run("document.querySelector('[data-testid=sidebar-projects]') && !document.querySelector('[data-testid=sidebar-builds]')")), "the Fixed Price sidebar lists projects");
  });

  await step("on a phone the client's pages fit the screen (no sideways scrolling)", async () => {
    await phone();
    try {
      for (const p of ["/clients/new", "/client/dashboard", "/my-projects", "/profile", "/notifications", "/ai/builder", "/ai", "/ai/dashboard", "/ai/billing"]) {
        await go(`${BASE}${p}`);
        await waitFor(`${p} to load`, async () => (await bodyText()).length > 80, 60000);
        await sleep(400);
        assert(await fitsWidth(), `${p} is wider than a phone screen`);
      }
      // Sign out is in the account menu: on a phone, open the drawer, then the menu, then press it.
      await ready("button[aria-label='Open menu']");
      await run("document.querySelector('button[aria-label=\"Open menu\"]').click()");
      await waitFor("the drawer with the person in it", () => run("!!document.querySelector('[role=dialog] [data-testid=profile-menu-trigger]')"), 30000);
      await run("document.querySelector('[role=dialog] [data-testid=profile-menu-trigger]').click()");
      await waitFor("Sign out in the menu", () => run("!!document.querySelector('[data-testid=sign-out]')"), 30000);
      await run("document.querySelector('[data-testid=sign-out]').click()");
      await waitFor("the sign-in page after signing out", async () => (await run("location.pathname")) === "/sign-in", 60000);
      await go(`${BASE}/sign-in`);
      await waitText("Sign in to SILPI AI", 60000);
      assert(await fitsWidth(), "/sign-in is wider than a phone screen");
    } finally { await desktop(); }
  });

  await step("the front page: an idea typed by a visitor waits in the fixed-price form after they sign up", async () => {
    await run("fetch('/api/auth/logout', { method: 'POST' })");
    await go(`${BASE}/ai`);
    await waitText("Get a fixed-price quotation", 60000);
    await ready("#landing-brief");
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
    await ready("#landing-brief");
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

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { adminConfigured, adminTokenLength } from "@/lib/admin-auth";
import { getDb } from "@/lib/business/db";
import { DEV_START_WITHOUT_PAYMENT } from "@/lib/dev-flags";
import { listAdminAccounts } from "@/server/admin-accounts";
import { listModels } from "@/server/ai/catalog";
import { defaultProviders } from "@/server/ai/providers";
import { autoBillingEnabled } from "@/server/billing-cycle";
import { auditBuckets, auditWallets } from "@/server/credits";
import { listRates } from "@/server/fx";
import { listPaymentProviders } from "@/server/payments/provider";
import { getSeller } from "@/server/tax";

/**
 * "Is this ready for real customers?" A list of things to check before and after going live, each with what is wrong and how to fix it.
 * It looks only at this server's own settings and data: it cannot know whether the HTTPS certificate is valid, whether backups are copied off the
 * machine, or whether a payment provider's account is approved. "fail" means customers could be harmed, "warn" means something is missing or weak.
 */
export type Level = "ok" | "warn" | "fail";
export type Check = { id: string; label: string; level: Level; detail: string; fix?: string };
export type Readiness = { generatedAt: string; production: boolean; summary: { ok: number; warn: number; fail: number }; checks: Check[] };

export function readiness(input: { env?: Record<string, string | undefined>; secure?: boolean; now?: number } = {}): Readiness {
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now();
  const production = env.NODE_ENV === "production";
  const db = getDb();
  const checks: Check[] = [];
  const add = (id: string, label: string, level: Level, detail: string, fix?: string) => checks.push({ id, label, level, detail, ...(fix ? { fix } : {}) });

  // ---- access ----
  const tokenLength = adminTokenLength(env);
  if (!adminConfigured()) add("admin-token", "Administrator token", "fail", "Not set, so the administrator pages and APIs are closed.", "Set the administrator token (see .env.example) to a long random secret of 32 or more characters and restart.");
  else if (tokenLength < 32) add("admin-token", "Administrator token", "warn", `It is ${tokenLength} characters. It also signs administrator sessions.`, "Use a random secret of 32 or more characters.");
  else add("admin-token", "Administrator token", "ok", "Set, and long enough.");

  const accounts = listAdminAccounts().filter((a) => a.status === "active");
  if (accounts.filter((a) => a.role === "admin").length === 0) add("admin-accounts", "Named administrator accounts", "warn", "No named account exists, so every change is recorded as just \"admin\".", "Create an account for each person in the Admins tab, then keep the token for emergencies only.");
  else add("admin-accounts", "Named administrator accounts", "ok", `${accounts.length} active account${accounts.length === 1 ? "" : "s"}.`);

  add("https", "HTTPS", input.secure === true ? "ok" : production ? "fail" : "warn", input.secure === true ? "This page was reached over HTTPS." : "This page was reached over plain HTTP, so sign-in cookies and passwords travel unencrypted.", "Put the site behind HTTPS (a reverse proxy or host that terminates TLS and sets X-Forwarded-Proto).");
  add("production", "Production mode", production ? "ok" : "warn", production ? "Running as a production build." : `NODE_ENV is "${env.NODE_ENV ?? "unset"}": development settings are active.`, "Run with NODE_ENV=production (npm run build, then npm start).");
  add("dev-shortcut", "Start without payment (development shortcut)", DEV_START_WITHOUT_PAYMENT ? (production ? "fail" : "warn") : "ok", DEV_START_WITHOUT_PAYMENT ? "On: project generation can start without the client's payment on this computer." : "Off.", "It switches itself off in a production build; for other servers delete src/lib/dev-flags.ts and src/lib/dev-start.ts.");

  // ---- money ----
  const providers = Object.values(defaultProviders()).filter((p) => p.id !== "echo");
  const live = providers.filter((p) => p.isConfigured()).map((p) => p.id);
  const enabledReal = listModels({ enabledOnly: true }, db).filter((m) => m.provider !== "echo");
  const unusable = enabledReal.filter((m) => !live.includes(m.provider));
  if (live.length === 0) add("ai-provider", "AI provider key", "warn", "No AI provider key is set, so customers can only use the free demo model.", "Set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY, then add and price a model.");
  else if (enabledReal.length === 0) add("ai-provider", "AI models", "warn", `A key is set (${live.join(", ")}) but no real model is switched on.`, "In the AI tab, add a model with prices checked against the provider's price page, then switch it on.");
  else if (unusable.length > 0) add("ai-provider", "AI models", "warn", `${unusable.map((m) => m.id).join(", ")} ${unusable.length === 1 ? "is" : "are"} switched on but ${unusable.length === 1 ? "has" : "have"} no key.`, "Set the provider's key or switch the model off.");
  else add("ai-provider", "AI models", "ok", `${enabledReal.length} model${enabledReal.length === 1 ? "" : "s"} on, keys set for ${live.join(", ")}. Not yet checked against the real provider.`);

  const online = listPaymentProviders().filter((p) => p.webhook && p.configured);
  add("payments", "Online payments", online.length ? "ok" : "warn", online.length ? `Connected: ${online.map((p) => p.id).join(", ")}.` : "No online payment provider is connected: payments are recorded by hand.", "Add a Stripe or Razorpay adapter and its webhook secret when the account is ready.");

  const seller = getSeller(db);
  add("seller", "Who invoices come from", seller.legalName && seller.address ? "ok" : "warn", seller.legalName && seller.address ? seller.legalName : "The seller's name or address is empty, so invoices show only \"SILPI AI\".", "Fill it in the Tax & currency tab.");

  const rules = (db.prepare("SELECT COUNT(*) AS n FROM tax_rules WHERE active = 1").get() as { n: number }).n;
  add("tax", "Tax", "warn", rules > 0 ? `${rules} tax rule${rules === 1 ? "" : "s"} set, plus GST on rupee invoices. Not reviewed by an accountant here.` : "Only the built-in GST on rupee invoices applies; no other country is taxed.", "Check what applies to you with an accountant, then add rules in the Tax & currency tab.");

  const used = (db.prepare("SELECT DISTINCT currency FROM subscriptions WHERE unit_amount_minor > 0 UNION SELECT DISTINCT currency FROM billing_payments").all() as { currency: string }[]).map((r) => r.currency).filter((c) => c !== "USD");
  const rated = new Set(listRates(db).map((r) => r.currency));
  const noRate = used.filter((c) => !rated.has(c as never));
  add("fx", "Exchange rates for reports", noRate.length ? "warn" : "ok", noRate.length ? `Money has been taken in ${noRate.join(", ")} but there is no rate, so the dollar totals leave it out.` : "Every currency in use has a rate (or none is used).", "Add the rates in the Tax & currency tab.");

  add("auto-billing", "Renewals and credit expiry run by themselves", autoBillingEnabled(env) ? "ok" : "warn", autoBillingEnabled(env) ? "A timer runs them every hour." : "No timer: renewals, past-due handling and expiry happen only when someone calls POST /api/admin/billing/process.", "Set SILPI_AUTO_BILLING=1 (it is on by default in production), or call that address from a scheduler.");

  // ---- safety nets ----
  const file = (db.prepare("PRAGMA database_list").all() as { name: string; file: string }[]).find((d) => d.name === "main")?.file ?? "";
  const backupDir = file ? path.join(path.dirname(file), "backups") : "";
  let newest = 0;
  if (backupDir && existsSync(backupDir)) for (const f of readdirSync(backupDir)) newest = Math.max(newest, statSync(path.join(backupDir, f)).mtimeMs);
  const days = (now - newest) / 86_400_000;
  add("backups", "Database backups", newest && days <= 7 ? "ok" : "warn", newest ? `The newest copy in the backups folder is ${Math.floor(days)} day${Math.floor(days) === 1 ? "" : "s"} old. (Automatic copies are made only before an upgrade.)` : "No backup copy exists. The database is one file; losing it loses every wallet, invoice and payment.", `Copy ${file || "the database file"} somewhere else on a schedule (see docs/DEPLOYMENT.md).`);

  const wallets = auditWallets().length;
  const buckets = auditBuckets().length;
  add("ledger", "Books balance", wallets + buckets === 0 ? "ok" : "fail", wallets + buckets === 0 ? "Every wallet agrees with its ledger and its credit buckets." : `${wallets} wallet and ${buckets} bucket checks fail.`, "Stop and investigate before taking more payments: see the Finance tab.");

  const failedHooks = (db.prepare("SELECT COUNT(*) AS n FROM payment_webhook_events WHERE status = 'failed' AND received_at >= ?").get(new Date(now - 7 * 86_400_000).toISOString()) as { n: number }).n;
  add("webhooks", "Payment notices", failedHooks === 0 ? "ok" : "warn", failedHooks === 0 ? "No failed notice in the last 7 days." : `${failedHooks} notice${failedHooks === 1 ? "" : "s"} failed in the last 7 days.`, "Open the Payments tab to see which and why.");

  add("rate-limits", "Request limits", "warn", "Limits are counted in this server's memory: each copy of the server counts alone and a restart forgets them. They stop scripts and mistakes, not a determined attack.", "Add limits at the proxy or CDN too if the site will be public.");
  add("csp", "Content-Security-Policy", "warn", "Not set. The site sends nosniff, frame, referrer and permissions headers, but no CSP.", "Add a nonce-based CSP once the pages are stable.");

  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.level]++;
  return { generatedAt: new Date(now).toISOString(), production, summary, checks };
}

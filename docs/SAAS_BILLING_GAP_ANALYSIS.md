# SILPI AI: global billing and credits, gap analysis (Phase 1 of the brief)

Written from the repository as it is today (commit `29e1cfa`). Nothing here is a plan to rewrite: most of the brief's financial core already exists and is tested. Status key: **Done** (built and tested), **Partial** (a base exists), **Missing**.

## 1. What exists now

| Area | State | Where |
|---|---|---|
| Credit ledger, reservations, idempotency, atomic transactions, no negative balance | **Done** | `src/server/credits.ts`, SQL triggers in migration 3, `tests/credits.test.ts` (incl. cross-process race) |
| Integer money everywhere, exact cost maths (BigInt, round up) | **Done** | `src/server/ai/pricing.ts`, plans in minor units |
| Tenancy, sessions, roles (owner, admin, member, viewer) | **Done** | `tenancy.ts`, `sessions.ts`, `session-auth.ts` |
| Subscriptions, invoices, renewals, grace, upgrade, downgrade, cancel | **Done** (manual payment) | `subscriptions.ts`, 7 test files |
| AI gateway: hold, call, settle, release; retries; fallback inside a tier; daily cap; concurrency cap | **Done** | `src/server/ai/gateway.ts` |
| Database-driven models, prices, markup per model, conversion setting | **Done** | tables `ai_models`, `settings` |
| Project builder (plan, approve a budget, build, resume, cancel, refund of a failed plan) | **Done** | `orchestrator.ts` |
| Pricing in three currencies chosen by country; plan sizes | **Done** | `src/lib/geo.ts`, migrations 6 to 9 |
| Admin: models, markup, conversion, daily caps, customers, add credits | **Partial** | `/ai/admin` |

## 2. The brief, phase by phase

| Phase | Verdict | What is missing or different |
|---|---|---|
| 2 Pricing | **Mostly done (step 3, built)** | The six plans from the brief, prices per currency in `plan_prices`, prices and credit allowances locked at sale, coupons, trials, an admin screen. See section 9. Still open: refunds (step 4), promotional pricing campaigns beyond coupons, ten currencies with real price points (the table supports them; only dollars, rupees and pounds have prices), a "move everyone to the new price" tool. Earlier text of this row: | Plan prices are columns for three currencies (rupee, dollar, pound). The brief wants `plan_prices` rows per currency and interval for ten currencies. Missing: coupons, promotions, trials, per-country price IDs, an admin screen for plans, refunds. The brief's plan table differs from the live catalogue (see section 3). |
| 3 Wallet | **Done (step 1, built)** | Three buckets (promotional, subscription, purchased), spend order, expiry with a daily sweep, per-bucket holds, reconciliation (`auditBuckets`). See section 7. Still open: a separate grants table and a scheduled reconciliation job (the audit exists; nothing calls it on a timer). |
| 4 Providers | **Mostly done (step 5, built)** | Anthropic, OpenAI and Gemini adapters (never called against the real APIs yet), circuit breaker per provider, new models arrive switched off. Missing: streaming. |
| 5 Routing | **Partial** | Routing is tiers in code (`autoTier`, `modelFor`). Missing: admin-configurable routing rules, task types, model-level spend limits, plan-based model access. |
| 6 Metering | **Done (step 2, built)** | Versioned prices, cached-token prices, other billable charges, markup rules by provider, model and task, minimum charge and rounding settings, raw usage kept, missing usage handled, every attempt logged. See section 8. Still open: image, audio and video charges (the field for "other charges" exists; no provider reports them yet) and the stage-level run record of phase 7. |
| 7 Agent workflow | **Partial** | The builder covers plan, files and review. Missing: document analysis and testing stages, an execution id per stage with provider cost, customer charge and reserved versus consumed credits on one row. |
| 8 Top-ups | **Partial (step 4)** | Packs, orders, payment confirmation and credit grant exist as APIs. Missing: the customer screen (step 6). |
| 9 Payments | **Partial** | Provider-neutral layer, payment records, signed notices with duplicate prevention, refunds, chargebacks, credit packs built (section 10). Missing: the Stripe and Razorpay adapters themselves (need accounts). |
| 10 Currency, tax | **Partial** | Display by country for three currencies. Missing: exchange-rate table, ten currencies, billing addresses, tax provider, currency on invoices. Invoices and GST are rupees only. |
| 11 Admin dashboard | **Mostly done (step 7, built)** | Finance tab (revenue per currency, MRR, churn risk, credits owed, AI cost against billing, health checks) and an audit log. Missing: exchange-rate totals (step 8), per-customer margin, charts beyond the daily bars. |
| 12 User billing dashboard | **Mostly done (step 6, built)** | `/ai/billing`: plan, credits by kind with expiry, plan change, coupons, credit packs, invoices, payments, credit history. Missing: online checkout (needs a payment provider), downloadable invoices. |
| 13 Database | **Partial** | See section 4. |
| 14 API | **Partial** | Routes follow `/api/workspace` and `/api/admin`, not `/api/v1`. Add versioning only if you want it. |
| 15 Security | **Partial** | Webhook signatures and an audit trail now exist. Missing: rate limiting beyond sign-in, individual admin identities, upload checks, prompt-injection handling. |
| 16 Tests | **Partial** | 811 tests, including money and concurrency. Missing: payment, webhook, expiry, bucket-order and end-to-end browser tests. |

## 3. Conflicts you need to decide

1. **The brief's plan table vs. the plans live now.** Today: Free, Pro and Professional (each with a credit-size dropdown), Starter retired, Enterprise. The brief: Free 25, Starter $6, Creator $12, Pro $19, Professional $49, Studio $99, Enterprise. They cannot both be the catalogue.
2. **The brief's credit definition.** "1 credit = $0.01 of customer-facing usage." Today a credit is an arbitrary unit (1,000 sub-units). This is a configuration change, not a rewrite: the gateway already computes `provider cost x markup x units per dollar`. With markup 2.5 and 100 credits per customer dollar, $1 of provider cost is 250 credits, which matches the brief's example.
3. **Prices in the brief change the economics.** At markup 2.5 and full use, a plan's provider cost is 40% of the credits' dollar value:

   | Plan | Price | Credits | Retail usage value | Provider cost (full use) | Margin after a 5% + $0.50 fee |
   |---|---|---|---|---|---|
   | Starter | $6 | 200 | $2 | $0.80 | about 73% |
   | Creator | $12 | 400 | $4 | $1.60 | about 77% |
   | Pro | $19 | 700 | $7 | $2.80 | about 78% |
   | Professional | $49 | 2,000 | $20 | $8 | about 78% |
   | Studio | $99 | 4,500 | $45 | $18 | about 76% |
   | Free | $0 | 25 | $0.25 | $0.10 | a cost of up to $0.10 per user |

   These margins are much higher than the current catalogue (about 55%), so customers get less AI per dollar. That may be what you want; it is worth deciding on purpose.
4. **Database.** The brief asks for row-level locking. SQLite locks the whole database for each write (`BEGIN IMMEDIATE`). That is safe and tested, and fine for a launch. A global SaaS under load should move to PostgreSQL, which you already deferred.

## 4. Schema: reuse, extend, add

Reuse: `organizations`, `users`, `memberships`, `plans`, `subscriptions`, `subscription_invoices`, `credit_wallets`, `credit_ledger`, `credit_reservations`, `ai_models`, `ai_requests`, `ai_jobs`, `settings`.

Add: `plan_prices`, `credit_buckets` (with expiry), `credit_grants`, `credit_packages`, `payments`, `payment_webhook_events` (unique provider event id), `refunds`, `coupons`, `model_prices` (versioned), `routing_rules`, `exchange_rates`, `billing_addresses`, `tax_records`, `audit_logs`. Existing tables are only extended with additive migrations; the automatic pre-migration backup stays.

## 5. Things that cannot be done honestly yet

- **Stripe and Razorpay:** needs your accounts. Stripe's availability for an Indian business must be checked first (my earlier research found it limited). Without credentials I can build the adapters, signature verification and tests against signed sample events, but nothing can be proven against the real services.
- **Gemini and OpenAI:** needs keys. I must use only officially published model ids and current prices, which I would look up from the providers' own pages. Until verified, those models are added disabled.
- **Tax:** needs a tax provider or a verified rate table from you. I will not invent rates.
- **Deployment:** I cannot deploy for you or confirm anything works in production.

## 6. Proposed build order (each step ends with tests, `tsc` and a check of existing features)

1. **Wallet buckets:** subscription, purchased, promotional; spend order; expiry; grants; reconciliation. *(independent of every decision)*
2. **Price versioning and metering:** `model_prices`, stored price version, cached tokens, minimum charge.
3. **Plans and pricing engine:** `plan_prices`, coupons, trials, admin plan screen. *(needs decision 1)*
4. **Payments layer:** provider abstraction, `payments`, webhook events, refunds, top-up packages. *(needs decision 2)*
5. **Providers:** Gemini and OpenAI adapters, routing rules, circuit breaker, streaming.
6. **User billing dashboard.**
7. **Admin financial dashboard and audit log.**
8. **Currency, exchange rates, tax.**
9. **Security hardening, end-to-end tests, deployment guide.**

## 7. Step 1 built: wallet buckets (migration 10)

**What changed.** Credits now live in buckets of three categories. They are spent in this order: **promotional, then subscription, then purchased**; inside a category the soonest expiry first (credits that never expire last), then the oldest. A reservation holds credits in specific buckets and settling charges them in that order. Everything else in the engine is unchanged: the append-only ledger, idempotency keys, atomic transactions and the "no negative balance" rule. The public functions kept their signatures; `reserveCredits`, `extendReservation`, `addCredits` and `adjustCredits` gained optional fields only.

**Expiry.** A bucket may have an expiry. By default nothing expires, so the landing page's wording ("unused credits are not removed") stays true. An administrator can set a default per category in the `settings` table (`credits_subscription_expiry_days`, `credits_promotional_expiry_days`, `credits_purchased_expiry_days`; 0 or unset means never) and can give any grant its own expiry. A daily call to `POST /api/admin/billing/process` removes expired credits. Credits held by a running reservation are honoured even if they expire meanwhile.

**Existing wallets.** Each wallet that already had credits received one "opening balance" bucket, typed purchased, never expiring, holding exactly what running reservations were holding. The migration takes the usual automatic backup first. A test builds a database in the old shape and checks the backup, the carried-over balance, a running reservation and the audits.

**Safety checks.**
- Every ledger row since this change has matching rows in `credit_ledger_buckets` (append-only), and the engine refuses to write a row whose bucket movements do not add up to the ledger amount.
- `auditBuckets()` checks wallet totals, each bucket against the ledger, held credits against active reservations, and each ledger row against its bucket movements. A random 400-operation run (moving time, three organizations) and the four-process race test both end with all audits empty. Three deliberate engine breaks were each caught by the tests.

**New API.** `GET /api/workspace/wallet` (any member: wallet, per-category totals, next expiry, buckets without internal references). `POST /api/admin/credits` accepts `category` (default promotional) and `expiresAt`. `GET /api/admin/credits` includes buckets.

**Known limits.**
- Expiry entries use ledger kind `adjust` with reference `expiry:<bucket>` and creator `system`, because the ledger's kind list is fixed by the database and changing it would mean rebuilding an immutable table. Reports should treat those rows as expiries.
- The audit is not on a timer yet.
- Nothing yet reads the per-category data on a screen.

## 8. Step 2 built: price versions and metering (migration 11)

**Price versions.** `ai_models` still holds the CURRENT price, so nothing that read it changed. Every change to a model's price, cache prices or markup now writes a new row in `model_prices` (append-only: the database refuses edits and deletes) with who changed it and why. Other edits (name, priority, on or off) do not. Every request records the version it was charged at, so any past charge can be re-derived exactly, and a price changed while a request is running does not alter that request. All existing models were backfilled as version 1.

**What is priced.** Input, output, cache reads, cache writes (each at its own price, or at the input price when the model has no separate cache price), and other billable charges. All whole-number maths with exact rounding (BigInt). The hold before a call counts input at the dearest input price the model has, so a request that turns out to write the cache still fits inside it.

**Markup rules.** The markup can be set for a provider, a model, a task type, or a mix. The most specific matching rule wins (model 8, task 4, provider 2; ties go to the newest); with no rule the model's own markup applies. The hold and the final charge use the same rule, and the request records the markup and which rule gave it. Task types: chat, document_analysis, architecture_planning, code_generation, bug_fixing, code_review, other. The project builder now labels its steps as planning, code generation and review.

**Charging policy.** Two settings, saved together or not at all: rounding ("up" never undercharges, or "nearest") and a minimum charge in units. A request that cost the provider nothing (the free demo model) is never charged.

**Usage reported by the provider.** Counts are the provider's own, with cached tokens separate; the provider's numeric usage fields are kept (never content). If a provider returns an answer with no usable usage, the work is still charged from the gateway's own estimate (about 4 characters a token) and the request is flagged `usage_source = estimated`, instead of throwing the answer away. Negative or fractional counts are treated as missing.

**Attempts.** `ai_request_attempts` records every try: which model, how it ended, how long, tokens. Retries and fallbacks are therefore visible. They are not charged to the customer.

**API.** `GET /api/admin/ai/prices?modelId=` (history), `GET/PUT/DELETE /api/admin/ai/markups`, `GET/PUT /api/admin/ai/settings`; model edits take `note`. The `/ai/admin` screen shows price versions, cache prices, the charging settings and the markup rules.

**What did NOT change, on purpose.** The credit definition. The brief says 1 credit = $0.01 of customer usage with a 2.5 markup. That is already expressible with these settings (a test shows a $0.40 provider cost becoming 100 credits), but switching it also changes what every plan's credit allowance means, so it happens together with the new plan table in step 3. Until then credits keep today's meaning.

**Known limits.**
- The customer-facing credit price list (`publicModels`) shows each model's own markup; a task-specific rule can make a request cost more or less than that list suggests.
- A run record that ties planning, files and review of one build together with cost per stage (phase 7) is not built yet; the pieces (task type, price version, usage, attempts) are now on each request.

## 9. Step 3 built: the six plans, prices per currency, coupons and trials (migrations 12 and 13)

**The catalogue.** Free 25, Starter 200 ($6, ₹499), Creator 400 ($12, ₹999), Pro 700 ($19, ₹1,499), Professional 2,000 ($49, ₹4,499), Studio 4,500 ($99, ₹8,999) credits a month, and Enterprise on request. Yearly is ten months of the monthly price (two months free). Dollars and rupees are the brief's figures. **The pound prices are my proposal** (£5, £10, £15, £39, £79). The earlier Pro and Professional size variants are retired (off sale, sorted last), not deleted.

**One credit is one cent.** The settings now say 1 credit = $0.01 of customer usage, with a 2.5 markup on every model: $1 of provider cost is 250 credits. Old and new markups are both in each model's price history. A test sends a request through the gateway and checks that $0.40 of provider cost is charged as exactly 100 credits.

**Prices per currency.** Every price is a row in `plan_prices` (plan, currency, period, amount in the currency's smallest unit). Ten currencies are supported by the table; add one by setting a price. The older rupee, dollar and pound columns on a plan are kept in step and nothing bills from them.

**Nobody's price changes by surprise.** A subscription records the price, the currency and the monthly credit allowance it was sold with. A later price or allowance change affects only people who subscribe afterwards. The migration locked every existing subscriber to what they were already paying, and a test upgrades a database with a Professional subscriber at 1,200 credits and checks that their renewal still brings 1,200 credits, not the new 2,000.

**Invoices.** An invoice has a currency. Tax (GST) is charged on rupee invoices only; other currencies carry none until a tax provider is added (step 8). The database rule "total = subtotal + tax" is kept, so `subtotal` on an invoice means the amount tax is charged on (after discount); `listPriceMinor` is the price before the coupon.

**Currency choice.** A new subscription is billed in the currency requested (default rupees, so older callers are unaffected). An organization still on Free chooses its billing currency when it upgrades; once it has paid in one currency it stays in it, and upgrades and scheduled downgrades happen in that currency.

**Coupons.** A percentage or a fixed amount (in one currency), lasting one invoice, a number of months, or every invoice; limited by dates, number of uses and plan; one use per organization; not case sensitive. The discount is written on each invoice. A request replaced before payment gives its coupon back. After a coupon has been used its discount cannot change. Coupons apply when starting a plan or moving to a dearer one, not to a scheduled downgrade or to Free.

**Trials.** A plan can have trial days and trial credits. A subscriber starts active at once with the trial credits and no invoice; the first invoice is raised in the last week of the trial, paying it continues from the trial's end, and unpaid at the end it goes past due and then back to Free after the grace days. An organization has one trial, ever. No plan has a trial yet: an administrator turns one on.

**Admin.** `/ai/admin` has Plans (credits, trial, on or off sale, and a price per currency) and Coupons. APIs: `PUT /api/admin/plans` (existing, now also trial fields), `PUT /api/admin/plans/prices`, `GET/PUT /api/admin/coupons`; the customer billing route accepts `currency` and `couponCode`.

**Things to know.**
- **Old balances are worth less.** A credit used to be about $0.022 of provider cost; now it is $0.004. Units already in a wallet keep their number but buy about 5.6 times less AI. There are no paying customers yet, so nothing was converted. If there were, existing balances would need scaling.
- The pound prices are unverified, and the rupee and dollar prices have not been tested with customers.
- No proration: an upgrade starts a new period when it is paid.
- Credits for an upgrade or a coupon never carry a tax calculation beyond GST on rupees (step 8).
- Payments are still recorded by the administrator until a provider is connected (see section 10).

## 10. Step 4 built: the payments layer (migration 14)

**What it is.** One way for money to enter the system, whoever sends it. A payment provider is a small adapter (`src/server/payments/provider.ts`): it checks a signed notice and turns it into plain events (payment succeeded or failed, refund made, dispute opened, won or lost) and, if it can, makes refunds. The built-in `manual` provider has no notices: the administrator records the payment by hand, exactly as before. No Stripe or Razorpay code exists yet; when you have accounts, each is one adapter file. No fake payment exists in the product code.

**Tables.** `billing_payments` (named so to keep the agency's own `payments` table untouched), `payment_webhook_events` (unique per provider and event id), `refunds`, `topups`, `credit_packages`, `credit_package_prices`.

**Rules that protect the money.**
- A notice with a missing or wrong signature is refused before anything is read. Timestamped signatures older than five minutes are refused (replay).
- Each notice is stored once. The same event again does nothing; the same payment under a new event id also does nothing.
- The amount and currency must match the invoice or order, otherwise the notice is recorded as failed and nothing is applied.
- A second payment for something already paid is kept and flagged so it can be refunded; it applies and grants nothing, and refunding it takes no credits.
- A failed attempt never undoes a success.
- Paying an invoice or a top-up and granting the credits happen in one transaction.

**Refunds.** Full or partial, with a reason, idempotent by key. The credits that payment bought are taken back in the same proportion (rounded down, so the shares add up exactly), from the bucket they went into, only as far as they are unspent or not held by a running job. What was already spent is recorded as unrecovered; the balance never goes negative. For a provider that can refund, the provider is asked first and the books change only if it agrees. Refunds made at the provider's dashboard arrive as notices and are recorded once. A lost dispute counts as a full refund; an open one blocks refunding.

**Credit packs.** 100, 250, 500 and 1,000 credits at $3, $7, $14, $27 (and rupee and pound prices; pounds are proposed). An order fixes its price and carries GST on rupees only. Credits arrive only when payment is confirmed. At most five unpaid orders per organization. Admin can edit packs and per-currency prices; price changes reach new orders only.

**Admin.** `/ai/admin` has Payments: record a payment, list with refunds, refund, packs and prices, provider notices. APIs: `POST /api/webhooks/[provider]` (public, signature only), `GET /api/admin/payments`, `POST …/payments/record`, `POST …/payments/refund`, `GET/PUT …/credit-packages`, `PUT …/credit-packages/prices`, `GET …/webhook-events`, customer `GET/POST/DELETE /api/workspace/billing/topup`.

**Tests.** `tests/payments.test.ts` (43) and `tests/payments-migration.test.ts` (4, on a database with agency data: tables added, old rows kept, backup made first). Mutation checks on the duplicate guard, event de-duplication, amount check and refund rounding were all caught.

**Not done.** The Stripe and Razorpay adapters; a customer-facing top-up screen (step 6); an automatic job to process renewals; tax beyond GST on rupees (step 8).

## 11. Step 5 built: more providers and a circuit breaker (no migration)

**Adapters.** `src/server/ai/providers-extra.ts` adds OpenAI (Chat Completions, key `OPENAI_API_KEY`) and Gemini (`generateContent`, key `GEMINI_API_KEY`, sent in a header, never in the address). Each reads its provider's usage the way that provider bills it: OpenAI counts cached tokens inside the prompt count, so they are taken out and priced at the cache-read price; Gemini counts "thinking" tokens apart from the answer's tokens, so they are added to the output. If a provider returns no usable usage, the answer is kept and the gateway prices it from its own estimate and flags it (as before). A Gemini model name that could change the request address is refused before anything is sent. Base addresses can be overridden (`OPENAI_BASE_URL`, `GEMINI_BASE_URL`) for a proxy.

**No guessed models or prices.** Nothing is seeded for these two providers, because current model names and prices cannot be verified from here. In `/ai/admin` the administrator uses **Add a model**: it is created switched off with a zero price, and the catalogue refuses to switch a real model on at a zero price. So a model only starts serving after someone has typed the name and prices from the provider's own page. Price changes keep their history as before.

**Circuit breaker.** `src/server/ai/circuit.ts`. After 5 failures in a row a provider is skipped for 30 seconds; then one request probes it; success closes the circuit, failure reopens it. Temporary errors and a rejected key (401/403) count against the provider; a request it rejects as malformed (400) does not. While open, the next model of the same tier answers; if none is left the request is refused at once with a new code `provider-unavailable` (HTTP 503), before any credits are held. The builder pauses a job with a clear message instead of failing steps. State is kept in memory per server process.

**Admin.** `/ai/admin` shows each provider's key status (never the key) and circuit state, and the Add a model form. `GET /api/admin/ai` now includes `providers`.

**Tests.** `tests/ai-providers.test.ts` (29): the breaker, both adapters against a stand-in for `fetch` (request shape, usage mapping, error classes), models arriving off, charging through the gateway on split usage, skipping an open provider, probing after cooldown, and the admin view. Seven deliberate breakages (cached tokens, thinking tokens, ignoring the breaker, not counting a bad key, key in the address, two probes, a success not clearing failures) were all caught.

**Not done.**
- Streaming. It needs the charge to be settled when a stream ends or is cut off; worth building together with the playground screen.
- Admin-editable routing rules by task. Routing is still tier plus priority, or an explicit model.
- None of the three adapters has been called against a real API. Do that once with a small key before relying on them.

## 12. Step 6 built: the customer billing page (no migration)

`/ai/billing` (tab "Billing"; the credit chip in the header now opens it). It uses only APIs that already existed and are tested; no new server code.

- **Plan:** name, status, the price and credits the customer signed up at, period end, free trial, a scheduled downgrade, a request waiting for payment, open invoices, and Cancel / Keep.
- **Credits:** available and held, totals for plan, bought and free credits, the spending order, the next expiry, and each bucket.
- **Change plan:** every plan in the customer's currency (locked to the subscription's currency once paid; free organizations choose), monthly or yearly, coupon code. Choosing creates an invoice; nothing is charged until payment is confirmed.
- **Buy credits:** the four packs in the chosen currency; unpaid orders can be cancelled.
- **History:** invoices (with discount and GST), payments (with refunds), and credit movements.
- Members who are not owners or admins see the plan and credits only.

**Checked** in a real browser against a temporary database: a Free organization with a requested Pro plan, an open dollar invoice and two top-up orders. Two bugs found and fixed that way: the cancel button showed for the Free plan, and the currency pickers ignored the currency of an invoice already raised.

**Not done.** There is no online payment button, because no provider is connected: the page tells the customer to pay and quote the invoice or order number, and the credits or plan start when the administrator records the payment (or a provider notice arrives). Invoice PDFs, and billing addresses and tax numbers (step 8), are not built.

## 13. Step 7 built: finance dashboard and audit log (migration 15)

**Audit log.** `audit_logs` is append-only (the database refuses updates and deletes). Each entry has the time, who, what (`plan.price_set`, `credits.granted`, `payment.succeeded`, `refund.succeeded` ...), what it concerned, the organization when there is one, and the facts of the change. Passwords, tokens, keys and similar fields are never written; long text is cut. Administrator changes are recorded after they succeed (a rejected change leaves nothing). Payments, duplicate-payment flags, disputes and refunds are written in the same transaction as the money moving, so one cannot exist without the other. Also recorded: administrator sign-in and user creation. `GET /api/admin/audit` filters by action prefix, organization and actor, and pages backwards.

**Finance.** `GET /api/admin/finance`, worked out from the books when asked, never stored:
- **Money received:** successful payments less successful refunds, this month, last month and all time, **each currency on its own** (there are no exchange rates, so nothing is added across currencies); packs sold.
- **Subscribers:** monthly recurring revenue (yearly counted as a twelfth, trials and past-due not counted), revenue at risk from cancelling subscribers, paying / past due / trial / free, ended this month, by plan, invoices waiting for payment.
- **Credits owed:** what customers can still spend, by kind, and its worth at the credit price.
- **AI:** provider cost against what customers were billed in credits, this and last month, by provider and by model, requests failed and served by a backup, unrecovered usage, and the last 14 days.
- **Health:** wallets and buckets against the ledger, duplicate payments waiting for a refund, failed provider notices, credits not recovered on refunds, stuck AI requests.
- The agency's own organization is excluded everywhere.

**Admin screen.** `/ai/admin` now has tabs: Finance, Customers & plans, Payments, AI, Audit log (the existing sections, regrouped, unchanged).

**Tests.** `tests/finance-audit.test.ts` (9) and `tests/finance.test.ts` (10): append-only, secrets never stored, filters and paging, rollback with the change, every admin route recorded and nothing recorded on failure, and each finance figure against a small business built through the real services and against independent queries. Mutation checks on the revenue, MRR, trial, past-due, agency-exclusion, refund, secret-hiding and payment-audit logic were all caught.

**Not done.**
- All administrators share one token, so entries say "admin": individual names need real administrator accounts.
- The audit log protects against edits through the application and by mistake; someone with the database file can still change it. A hash chain or an external copy would be needed against that.
- No revenue in one currency (exchange rates, step 8) and no margin per customer or per plan.
- AI figures were checked with a stand-in provider; real prices are still to be verified.

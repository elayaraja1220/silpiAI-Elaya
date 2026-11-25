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
| 4 Providers | **Partial** | Only Anthropic (plus a free demo model). Missing: Gemini and OpenAI adapters, streaming, circuit breakers, `getModels`, cached-token and tool charges. |
| 5 Routing | **Partial** | Routing is tiers in code (`autoTier`, `modelFor`). Missing: admin-configurable routing rules, task types, model-level spend limits, plan-based model access. |
| 6 Metering | **Done (step 2, built)** | Versioned prices, cached-token prices, other billable charges, markup rules by provider, model and task, minimum charge and rounding settings, raw usage kept, missing usage handled, every attempt logged. See section 8. Still open: image, audio and video charges (the field for "other charges" exists; no provider reports them yet) and the stage-level run record of phase 7. |
| 7 Agent workflow | **Partial** | The builder covers plan, files and review. Missing: document analysis and testing stages, an execution id per stage with provider cost, customer charge and reserved versus consumed credits on one row. |
| 8 Top-ups | **Missing** | No packages, no purchase flow. |
| 9 Payments | **Missing** | No Stripe or Razorpay code, no webhooks, no payment table. Payments are recorded by hand. |
| 10 Currency, tax | **Partial** | Display by country for three currencies. Missing: exchange-rate table, ten currencies, billing addresses, tax provider, currency on invoices. Invoices and GST are rupees only. |
| 11 Admin dashboard | **Partial** | No revenue, churn, margin or cost-by-provider views; no audit log. |
| 12 User billing dashboard | **Partial** | APIs exist (`/api/workspace/billing`); the screens (plan, credits, history, invoices, top-up) do not. A usage page exists. |
| 13 Database | **Partial** | See section 4. |
| 14 API | **Partial** | Routes follow `/api/workspace` and `/api/admin`, not `/api/v1`. Add versioning only if you want it. |
| 15 Security | **Partial** | Missing: rate limiting beyond sign-in, audit trail, webhook verification, upload checks, prompt-injection handling. |
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
- Payments are still recorded by the administrator. Refunds, payment events and the card and UPI providers are step 4.

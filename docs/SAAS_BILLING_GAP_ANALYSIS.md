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
| 2 Pricing | **Partial** | Plan prices are columns for three currencies (rupee, dollar, pound). The brief wants `plan_prices` rows per currency and interval for ten currencies. Missing: coupons, promotions, trials, per-country price IDs, an admin screen for plans, refunds. The brief's plan table differs from the live catalogue (see section 3). |
| 3 Wallet | **Done (step 1, built)** | Three buckets (promotional, subscription, purchased), spend order, expiry with a daily sweep, per-bucket holds, reconciliation (`auditBuckets`). See section 7. Still open: a separate grants table and a scheduled reconciliation job (the audit exists; nothing calls it on a timer). |
| 4 Providers | **Partial** | Only Anthropic (plus a free demo model). Missing: Gemini and OpenAI adapters, streaming, circuit breakers, `getModels`, cached-token and tool charges. |
| 5 Routing | **Partial** | Routing is tiers in code (`autoTier`, `modelFor`). Missing: admin-configurable routing rules, task types, model-level spend limits, plan-based model access. |
| 6 Metering | **Partial** | Exact maths exists. Missing: cached tokens, a stored **price version** per request, tool and media charges, minimum-charge setting, retries counted separately. |
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

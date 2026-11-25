# SILPI AI - Existing System Audit

Status: Phase 0 (read-only audit). No application code was changed to produce this document.
Audited: 2026-11-25, branch `main`, commit `8dd92d5` (plus one uncommitted file, see 9.6).
Method: read the repository, the SQLite schema, every API route file, the auth module, the execution and agent code, and ran both test suites. Nothing below is guessed from screenshots.

---

## 1. Summary

SILPI today is a **single-tenant, single-operator** application: one agency owner runs it locally to take client enquiries, price and send quotations, collect payments and build the project with an AI agent.

| Fact | Value |
|---|---|
| Web app | Next.js 15 (App Router), React 19, TypeScript strict, Tailwind 3 |
| "Backend" | Next.js route handlers (`src/app/api/**/route.ts`), 50 route files, Node runtime |
| Database | SQLite through Node's built-in `node:sqlite` (Node 24 here), WAL mode, file `frontend-2/storage/silpi.db` |
| AI agent | Separate package `silpi-agent/` (TypeScript, `@anthropic-ai/sdk`), started by the web app as a child process |
| AI providers | Anthropic only (API mode) and a local Claude Code CLI (default mode) |
| Users / auth | One shared admin secret (`SILPI_ADMIN_TOKEN`) exchanged for a signed cookie. No user accounts |
| Tenancy | None. No organization, user or owner column in any table |
| Tests | Frontend 619 passing (Node test runner), agent 80 passing (Vitest). No browser end-to-end tests, no CI configuration |

**The target in the brief names NestJS, MySQL, Redis, BullMQ and S3. None of these exist today.** Section 10 lists each conflict and what is proposed. The brief itself says not to migrate a working stack without a demonstrated need, so those decisions are marked for approval rather than assumed.

---

## 2. Repository layout

```
SilpiAgent/
  frontend-2/            Next.js app (the product). Git-tracked.
    src/app/(app)/       Admin pages: / (overview), clients, clients/new, clients/[id], projects,
                         existing, activity, pricing, plans, settings
    src/app/q/[token]/   Public client quotation page (secret link)
    src/app/api/         50 route handlers (section 5)
    src/components/      business/ (41 files), pages/, ui/, layout/
    src/lib/business/    Domain logic: pricing, quotes, costs, running services, assets, store (48 files)
    src/lib/execution/   Job runner for AI generation (claude-cli, api-agent, gate, jobs, verify)
    src/lib/demo/        Private demo previews (gateway, snapshot, app-runner)
    tests/               25 test files
    storage/             Local data (git-ignored): silpi.db, client-assets/, demos/
  silpi-agent/           AI agent package. Git-tracked. node_modules present.
  silpi-ai/              Older agent (Gemini era). Git-ignored, local only. Not used by the app.
  generated-projects/    Output of generations. Git-ignored.
  INTEGRATION.md         Stale: describes silpi-ai + Gemini. Git-ignored.
```

Frontend dependencies (the whole list): `next`, `react`, `react-dom`, `docx`, `pdf-lib`, `lucide-react`; dev: `tailwindcss`, `typescript`, `@types/*`. There is **no** ORM, auth library, queue, cache, payment SDK or validation library. Validation is hand-written (`src/lib/business/validate.ts`, per-module `parse*` functions).

Agent dependencies: `@anthropic-ai/sdk`, `commander`, `dotenv`, `mammoth`, `zod`; dev: `vitest`, `tsx`, `typescript`.

---

## 3. Database (SQLite, 14 tables)

Defined as one SQL string in `src/lib/business/db.ts`, applied with `CREATE TABLE IF NOT EXISTS` on every start. Later columns on `leads` (`share_token`, `client_response`, `project_name`) are added by an ad hoc `migrate()` that checks `PRAGMA table_info`. There is no migration version table.

| Table | Purpose | Key relations |
|---|---|---|
| `leads` | One client enquiry/project. `client`, `requirement` are JSON text | root |
| `quotations` | Numbered quotations, `data` JSON | `lead_id` -> leads (cascade) |
| `stage_history` | Stage changes with note | lead |
| `payments` | Advance/balance payments, mode, reference | lead |
| `work_log` | Hours logged (hourly engagements) | lead |
| `exec_jobs` | AI generation jobs: state, approval, cost, result, review | lead |
| `exec_events` | Job event stream, PK (job_id, seq) | job |
| `running_services` | Hosting/maintenance arrangements, one JSON row per lead | lead (PK) |
| `client_assets` | Items collected from the client (logos, content) | lead, UNIQUE(lead_id,key) |
| `asset_files` | Uploaded file metadata; bytes on disk | asset |
| `demo_links` | Secret demo links: token, password hash, expiry, views | lead |
| `analysis_cache` | Cached AI document analysis: key, draft, model, cost_usd | none |
| `chat_messages` | Client/team chat per lead | lead |
| `settings` | Key/value (rate card, cost config, execution settings, tech overrides) | none |

Observations:
- Foreign keys are on (`PRAGMA foreign_keys = ON`). Indexes exist for the common lookups.
- Money is stored as `REAL` (floating point). Quotation totals live inside JSON, not columns.
- Most domain data is JSON in `TEXT` columns. Fine for one operator, hard to query, report on or constrain at SaaS scale.
- `transaction()` helper uses `BEGIN IMMEDIATE`, so financial writes can be made atomic. Used in `store.ts`.
- No `users`, `organizations`, `memberships`, `plans`, `subscriptions`, `credit_*` or `audit_logs` tables.

---

## 4. Authentication and authorization

Implemented in `src/lib/admin-auth.ts`:
- Secret `SILPI_ADMIN_TOKEN` (16+ characters). Without it, admin APIs answer 503 (closed by default).
- Sign-in exchanges the secret for an HMAC-signed, HttpOnly, SameSite=Strict cookie, 8-hour life. Bearer header also accepted for scripts.
- Constant-time comparison. Same-site (Origin) check on state-changing admin requests.
- Login rate limit: 8 attempts per 10 minutes, **in process memory** (resets on restart, not shared between instances).

What is gated by `requireAdmin` (11 route files): `execution/*` (jobs, prepare, settings, status), `demo/*`, `business/leads/[id]/running-services`, `business/recurring-income`.

**What is not gated** (anyone who can reach the server can call it): the whole `business/*` surface including `leads` (list, create, read, delete), `quote`, `payments`, `hours`, `rate-card` (read **and write**), `cost-config`, `analyze` (spends AI money), `assets`, `chat`, `proposals`, `document`, `share`, `sent`, `technology`, `insights`. Reason: the app was built to run on the owner's own machine. `api/projects/generate`, `edit` and `resume` are gated (they only return a refusal via `directApiBlocked`), but **`GET api/projects` is not**: it lists the generated-projects folder, its absolute path and whether an API key file exists.

**Correction found while implementing Phase 0.5:** the `demo/*` and `execution/*` routes do not call `requireAdmin` directly. They call `requireAdminOrDevStart` (`src/lib/dev-start.ts`), a documented TEMPORARY bypass: while `DEV_START_WITHOUT_PAYMENT = true` in `src/lib/dev-flags.ts`, a request that is on localhost, from the same site and carries the header `x-silpi-dev-start: 1` skips the admin token for the execution panel calls (settings stay admin-only). It is local-only by design, but it is a second, header-based way past admin sign-in and must be removed before any external user. Its flag is currently `true`.

Public (by design, secret-token links): `api/client/[token]/*` and `/q/[token]` for the client; demo links have their own token, optional password and expiry.

There is no per-user identity, so there is also no audit log of who did what.

---

## 5. API surface (50 route files)

| Group | Routes | Auth today |
|---|---|---|
| Admin session | `admin/session` (GET/POST/DELETE) | public (it is the login) |
| Leads and quotation | `business/leads`, `leads/[id]`, `quote`, `proposals`, `sent`, `share`, `document`, `technology`, `insights`, `analysis` | none |
| Money | `leads/[id]/payments`, `hours`, `costs`, `business/cost-config`, `business/rate-card`, `exchange-rates` | none |
| Client files and chat | `leads/[id]/assets(+files)`, `leads/[id]/chat`, `business/chat` | none |
| AI analysis | `business/analyze`, `tech-catalog` | none |
| Running services | `leads/[id]/running-services`, `business/recurring-income` | admin |
| Execution | `execution/leads/[id]`, `prepare`, `jobs/[jobId]`, `jobs/[jobId]/[action]`, `settings`, `status` | admin |
| Demo | `demo`, `demo/leads/[id]`, `demo/settings` | admin |
| Client (public token) | `client/[token]` plus `assets`, `chat`, `document`, `technology` | token |
| Legacy | `projects`, `projects/generate`, `projects/[name]/edit`, `resume` | admin, always refuse |

No OpenAPI description exists.

---

## 6. Business workflows (existing, must be preserved)

All of these exist and are covered by tests unless noted:

1. Create client enquiry / requirement (wizard, fixed-price or hourly).
2. Upload requirement documents (docx, pdf, images, text; magic-byte checks, size limits) and AI analysis through the agent's `analyze` command, with a result cache.
3. Select pages, features, package (Basic / Standard / Premium), technology recommendation.
4. Quotation calculation: hours x rate, complexity and technology factors, GST (CGST+SGST or IGST by state), budget check (a limit, never an automatic discount), only requested pages billed.
5. Send quotation through a secret client link; print/PDF/docx.
6. Client approval and chat.
7. Advance and balance payment recording, payment status.
8. Collect client originals (logos, content) after approval.
9. Hour logging for hourly engagements.
10. Internal cost, profit and viability panel (team only).
11. Running services (domain, hosting, maintenance) and recurring-income view (added in commit `8dd92d5`).
12. Execution: build the project from the approved quotation via Local Claude Code (default) or the Anthropic API (needs an enabled setting, a spend limit and a per-run approval of the estimate).
13. Live demo previews through private links.

Rules recorded as product decisions: budget is a limit; bill only requested pages; 404 and header are not pages; domain and hosting are billed separately; rate-card numbers are estimates, not history.

---

## 7. Existing AI integration

- `silpi-agent` is a CLI (`run`, `analyze`, `create` ...) built on `@anthropic-ai/sdk`. It runs a tool-using loop with turn and dollar caps (`SILPI_MAX_TURNS`, `SILPI_MAX_COST_USD`), a queue (`maxConcurrentRuns` = 2), and a sandbox mode `local` (default) or `docker`.
- The web app spawns it (`spawn(..., shell: false)`) from `lib/execution/api-agent.ts` and `lib/business/analyze.ts`, and reads an NDJSON event stream. The API key stays in the agent's environment.
- `lib/execution/claude-cli.ts` runs the local Claude Code CLI (subscription, no API cost) and is the default generation path.
- Cost control that already exists: `api-gate.ts` requires an enabled setting, a spend limit, a per-run confirmation of an estimate, and a separate acceptance when the estimate is unreliable. This is the closest thing to the "approve a spending limit" step in the brief.
- Prices are hardcoded in `silpi-agent/src/pricing.ts` (Anthropic models only). Unknown models fall back to the most expensive price.
- There is no provider abstraction, no central gateway and no per-customer metering. Cost is recorded per job in `exec_jobs.cost` and per analysis in `analysis_cache.cost_usd`.

---

## 8. Test baseline (run during this audit)

| Suite | Result |
|---|---|
| `frontend-2` `npm test` | 619 tests, 619 pass, 0 fail |
| `frontend-2` `npx tsc --noEmit` | clean |
| `silpi-agent` `vitest run` | 80 tests, 80 pass |
| Browser end-to-end | none |
| CI | none found in the repository |

This is the regression baseline for every later phase.

---

## 9. Technical debt and risks

### 9.1 Security (blocking before any external user)
1. **Unauthenticated business APIs** (section 4). Anyone reaching the server can list or delete leads, record payments, overwrite the rate card and trigger paid AI analysis.
2. **No tenant model.** Every query is global. Adding users without tenant columns and enforced scoping would leak data between customers.
3. **Generated and customer code runs on the host.** Default sandbox is `local`; the agent runs install scripts and project commands as the server user. `INTEGRATION.md` already warns that generated dependency scripts can execute arbitrary code. Docker mode exists but is opt-in and unaudited for network/resource limits.
4. **Single shared admin secret**, no per-user accountability, no audit log.
5. **In-memory login throttle** (not durable, not multi-instance). No general API rate limiting.
6. **Secret-link model for clients** (quotation, demo, assets). Reasonable for one agency; for SaaS it needs expiry, rotation and per-org scoping reviewed.
7. **Files stored on local disk** under `storage/`; no object storage, no malware scanning.
8. `INTEGRATION.md` records that an earlier `.env.example` contained what looked like a real API key. Confirm that key was revoked.

### 9.2 Data and money
1. Floating-point `REAL` for money; quotation amounts live inside JSON. A credit ledger must use integer minor units.
2. No migration versioning; the `migrate()` pattern cannot express reversible changes or ordered history.
3. SQLite is a single-writer database on one file. Adequate for the agency, a bottleneck and backup risk for many concurrent customers.

### 9.3 Architecture
1. Business logic in `src/lib/business` is largely pure and well tested. That is the main asset to protect.
2. Route handlers call the store directly; there is no service layer boundary, so multi-tenant checks would have to be added in many places.
3. Job execution is in-process (spawned children, in-memory state mixed with `exec_jobs`). No queue, no restart recovery beyond the table.
4. Pricing of AI models is hardcoded (brief requires configurable).

### 9.4 Operations
1. No Docker/Compose files for the web app, no `.env` validation, no health endpoint, no monitoring or backup procedure.
2. No CI pipeline running the two test suites.

### 9.5 Repository hygiene
1. Mixed line endings (Git warns about LF to CRLF on many files).
2. `INTEGRATION.md` and `silpi-ai/` are stale (Gemini era) and git-ignored; they can mislead new contributors.

### 9.6 Working tree
`frontend-2/src/components/business/technology-chooser.tsx` has uncommitted changes that predate this work. They are untouched and unrelated to the audit.

---

## 10. Conflicts between the brief and the current system

| Brief says | Reality | Proposal (needs approval) |
|---|---|---|
| NestJS backend | Next.js route handlers, no separate backend | **Keep Next.js.** Put new domain code in a service layer (`src/server/*`) with tenant-scoped repositories. A NestJS split is not justified yet. Revisit if workers or a public API need an independent deployment |
| MySQL | SQLite via `node:sqlite` | Keep SQLite for the internal agency data **now**. Introduce a database port so the SaaS data (users, orgs, credits) can run on MySQL or Postgres. Decide the engine before Phase 1 data is written, because a later move is a data migration. Needs your decision |
| Redis + BullMQ | None | Add only when Phase 3/4 workers need it. Until then a DB-backed job table (already present for `exec_jobs`) is enough |
| S3 storage | Local disk | Introduce a storage interface with a local driver first, S3 driver later |
| Docker execution | Optional `docker` sandbox in the agent | Make Docker mandatory for external tenants; audit network and resource limits |
| JWT access + refresh rotation | HMAC cookie, admin only | For SaaS use server-side sessions or short-lived JWT with rotating refresh tokens, per user. Keep the existing admin cookie path working for the owner |
| Configurable AI pricing | Hardcoded `pricing.ts` | Move to `ai_models` rows with a price effective date |

---

## 11. Recommended changes (non-destructive, in order)

1. **Close the existing gap first.** Put `requireAdmin` (or the new user session) on every `business/*` route that is not a public client route, behind a flag that is on by default for any non-localhost deployment. Add tests that fail if a new route is added ungated.
2. **Tenant foundation.** Add `organizations`, `users`, `memberships`; add a nullable `org_id` to `leads` and child tables with a backfill to a single "SILPI Agency" organization. Existing rows keep working. Enforce scoping in a repository layer, with tests that prove one tenant cannot read another.
3. **Versioned migrations.** Replace the `migrate()` helper with a numbered migration runner (up and, where safe, down) before adding any new table.
4. **Money in integers.** New financial tables (`credit_*`, invoices) use integer minor units and an append-only ledger. Do not rewrite existing quotation JSON.
5. **AI Gateway.** Wrap the existing agent and analysis calls behind one interface that records usage and cost, reusing `api-gate.ts` semantics (limit, estimate, approval) as the first "reservation" rule.
6. **Sandbox.** Require container isolation for any non-owner run before Phase 6.
7. **CI and Docker.** Add a pipeline that runs both suites and `tsc`, then Compose files.

None of these deletes or renames an existing table, route or screen.

---

## 12. What must be protected (regression checklist)

The 13 workflows in section 6, the rule set in section 6 (budget limit, billed pages, domain/hosting separate), the client link privacy (`publicRunningServices` allow-list: provider cost and markup never reach the client), the existing admin sign-in, and the two test baselines in section 8.

---

## 13. Open decisions for the owner

1. Database for SaaS data: stay on SQLite, or MySQL/Postgres from the start of Phase 1?
2. Keep Next.js route handlers as the API, or split a NestJS service now?
3. Which payment provider for subscriptions (Razorpay is the usual choice for India), and when to turn on real payments? (Approval required before activation.)
4. Is the existing agency data to be treated as the first organization ("SILPI Agency") in the same database, or kept in a separate database file?
5. Confirm the old API key mentioned in `INTEGRATION.md` was revoked.

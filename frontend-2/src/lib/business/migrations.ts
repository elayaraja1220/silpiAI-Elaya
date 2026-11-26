import { CURRENCIES } from "./currency";
import { COUNTRIES, minorDigits } from "./countries";
import { DEFAULT_PRICING_CONFIG, hourlyFromAnnual } from "./market-rates";
import type { DatabaseSync } from "node:sqlite";

/**
 * Numbered, one-way database migrations.
 *
 * - Each migration runs once, in order, inside its own transaction, and is recorded in `schema_migrations`.
 * - A migration that throws is rolled back completely and nothing after it runs.
 * - Migrations only ADD (tables, columns, indexes, rows). They never drop or rewrite existing data, so the way back is
 *   the backup taken just before the first pending migration is applied (see `beforeApply`), not a "down" script.
 * - The old base schema in db.ts and its `migrate()` helper are untouched: they still create the original tables.
 */

export type Migration = { id: number; name: string; up: (db: DatabaseSync) => void };

/** The organization every pre-existing lead belongs to. Fixed so the backfill and the code agree. */
export const AGENCY_ORG_ID = "org_silpi_agency";

export const ORG_TYPES = ["internal", "individual", "freelancer", "agency", "business", "enterprise"] as const;
export const MEMBER_ROLES = ["owner", "admin", "member", "viewer"] as const;

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "tenancy foundation: organizations, users, memberships, leads.org_id",
    up(db) {
      db.exec(`
        CREATE TABLE organizations (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          type       TEXT NOT NULL CHECK (type IN (${list(ORG_TYPES)})),
          status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
          created_at TEXT NOT NULL
        );

        CREATE TABLE users (
          id            TEXT PRIMARY KEY,
          email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
          name          TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
          created_at    TEXT NOT NULL,
          last_login_at TEXT
        );

        CREATE TABLE memberships (
          org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role       TEXT NOT NULL CHECK (role IN (${list(MEMBER_ROLES)})),
          created_at TEXT NOT NULL,
          PRIMARY KEY (org_id, user_id)
        );
        CREATE INDEX memberships_user ON memberships(user_id);

        -- Nullable on purpose: existing rows are filled below, and the trigger keeps every new lead inside the agency
        -- until the code that creates leads is moved to pass an organization explicitly.
        ALTER TABLE leads ADD COLUMN org_id TEXT REFERENCES organizations(id);
        CREATE INDEX leads_org ON leads(org_id, updated_at);

        CREATE TRIGGER leads_default_org AFTER INSERT ON leads WHEN NEW.org_id IS NULL
        BEGIN
          UPDATE leads SET org_id = '${AGENCY_ORG_ID}' WHERE id = NEW.id;
        END;
      `);
      db.prepare("INSERT INTO organizations (id, name, type, status, created_at) VALUES (?, 'SILPI Agency', 'internal', 'active', ?)").run(AGENCY_ORG_ID, new Date().toISOString());
      db.prepare("UPDATE leads SET org_id = ? WHERE org_id IS NULL").run(AGENCY_ORG_ID);
    },
  },
  {
    id: 2,
    name: "user sessions (server-side, revocable)",
    up(db) {
      // The browser holds a random token; only its SHA-256 is stored here, so a copy of this table cannot sign anyone in.
      db.exec(`
        CREATE TABLE sessions (
          id           TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          org_id       TEXT REFERENCES organizations(id) ON DELETE SET NULL,
          created_at   TEXT NOT NULL,
          expires_at   TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        );
        CREATE INDEX sessions_user ON sessions(user_id);
        CREATE INDEX sessions_expiry ON sessions(expires_at);
      `);
    },
  },
  {
    id: 3,
    name: "plans, subscriptions, invoices, credit wallets, append-only credit ledger, reservations",
    up(db) {
      // MONEY is whole paise, CREDITS are whole "units" (1 credit = 1000 units). No floating point anywhere.
      // The SaaS billing tables are separate from the agency's quotation/payment tables on purpose: the two businesses
      // keep independent books. Organizations that own financial records cannot be deleted (no cascade).
      db.exec(`
        CREATE TABLE plans (
          id                   TEXT PRIMARY KEY,
          name                 TEXT NOT NULL,
          description          TEXT NOT NULL DEFAULT '',
          monthly_price_paise  INTEGER CHECK (monthly_price_paise IS NULL OR monthly_price_paise >= 0),
          annual_price_paise   INTEGER CHECK (annual_price_paise IS NULL OR annual_price_paise >= 0),
          monthly_credit_units INTEGER NOT NULL CHECK (monthly_credit_units >= 0),
          max_active_projects  INTEGER CHECK (max_active_projects IS NULL OR max_active_projects >= 0),
          is_custom            INTEGER NOT NULL DEFAULT 0 CHECK (is_custom IN (0, 1)),
          active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          sort_order           INTEGER NOT NULL DEFAULT 0,
          created_at           TEXT NOT NULL,
          updated_at           TEXT NOT NULL
        );

        CREATE TABLE subscriptions (
          id                   TEXT PRIMARY KEY,
          org_id               TEXT NOT NULL REFERENCES organizations(id),
          plan_id              TEXT NOT NULL REFERENCES plans(id),
          pending_plan_id      TEXT REFERENCES plans(id),
          status               TEXT NOT NULL CHECK (status IN ('pending_payment', 'active', 'past_due', 'ended')),
          billing_period       TEXT NOT NULL CHECK (billing_period IN ('monthly', 'annual')),
          current_period_start TEXT,
          current_period_end   TEXT,
          cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
          created_at           TEXT NOT NULL,
          updated_at           TEXT NOT NULL
        );
        CREATE INDEX subscriptions_org ON subscriptions(org_id, created_at);
        -- At most one running subscription per organization, and at most one waiting for its first payment.
        CREATE UNIQUE INDEX subscriptions_one_running ON subscriptions(org_id) WHERE status IN ('active', 'past_due');
        CREATE UNIQUE INDEX subscriptions_one_pending ON subscriptions(org_id) WHERE status = 'pending_payment';

        CREATE TABLE subscription_invoices (
          id              TEXT PRIMARY KEY,
          number          TEXT NOT NULL UNIQUE,
          org_id          TEXT NOT NULL REFERENCES organizations(id),
          subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
          plan_id         TEXT NOT NULL REFERENCES plans(id),
          period_start    TEXT NOT NULL,
          period_end      TEXT NOT NULL,
          subtotal_paise  INTEGER NOT NULL CHECK (subtotal_paise >= 0),
          gst_basis_points INTEGER NOT NULL CHECK (gst_basis_points >= 0),
          gst_paise       INTEGER NOT NULL CHECK (gst_paise >= 0),
          total_paise     INTEGER NOT NULL CHECK (total_paise = subtotal_paise + gst_paise),
          status          TEXT NOT NULL CHECK (status IN ('open', 'paid', 'void')),
          provider        TEXT NOT NULL DEFAULT 'manual',
          provider_ref    TEXT,
          issued_at       TEXT NOT NULL,
          paid_at         TEXT,
          UNIQUE (subscription_id, period_start)
        );
        CREATE INDEX invoices_org ON subscription_invoices(org_id, issued_at);

        -- balance = credits owned; reserved = the part held for running work; available = balance - reserved.
        CREATE TABLE credit_wallets (
          org_id         TEXT PRIMARY KEY REFERENCES organizations(id),
          balance_units  INTEGER NOT NULL DEFAULT 0 CHECK (balance_units >= 0),
          reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
          updated_at     TEXT NOT NULL,
          CHECK (reserved_units <= balance_units)
        );

        CREATE TABLE credit_reservations (
          id              TEXT PRIMARY KEY,
          org_id          TEXT NOT NULL REFERENCES organizations(id),
          units           INTEGER NOT NULL CHECK (units > 0),
          status          TEXT NOT NULL CHECK (status IN ('active', 'settled', 'released')),
          purpose         TEXT NOT NULL DEFAULT '',
          actual_units    INTEGER CHECK (actual_units IS NULL OR actual_units >= 0),
          idempotency_key TEXT,
          created_at      TEXT NOT NULL,
          closed_at       TEXT
        );
        CREATE UNIQUE INDEX reservations_key ON credit_reservations(org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX reservations_org ON credit_reservations(org_id, status);

        -- Every change to a wallet is one row here, never edited, never deleted. The wallet row is only a running total.
        CREATE TABLE credit_ledger (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          org_id           TEXT NOT NULL REFERENCES organizations(id),
          kind             TEXT NOT NULL CHECK (kind IN ('grant', 'purchase', 'refund', 'adjust', 'reserve', 'extend', 'release', 'settle')),
          delta_units      INTEGER NOT NULL,
          reserved_delta   INTEGER NOT NULL,
          balance_after    INTEGER NOT NULL CHECK (balance_after >= 0),
          reserved_after   INTEGER NOT NULL CHECK (reserved_after >= 0 AND reserved_after <= balance_after),
          reservation_id   TEXT REFERENCES credit_reservations(id),
          idempotency_key  TEXT,
          reference        TEXT NOT NULL DEFAULT '',
          note             TEXT NOT NULL DEFAULT '',
          created_by       TEXT NOT NULL DEFAULT '',
          created_at       TEXT NOT NULL
        );
        CREATE UNIQUE INDEX ledger_key ON credit_ledger(org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX ledger_org ON credit_ledger(org_id, id);
        CREATE TRIGGER credit_ledger_no_update BEFORE UPDATE ON credit_ledger BEGIN SELECT RAISE(ABORT, 'credit_ledger is append-only'); END;
        CREATE TRIGGER credit_ledger_no_delete BEFORE DELETE ON credit_ledger BEGIN SELECT RAISE(ABORT, 'credit_ledger is append-only'); END;
      `);
      // Starting plans. These are PROPOSED commercial values, not validated margins: they are ordinary rows, edited from
      // the admin plan screen/API, and no code depends on these particular numbers. Annual is 10 x monthly (2 months free).
      const at = new Date().toISOString();
      const insert = db.prepare(
        "INSERT INTO plans (id, name, description, monthly_price_paise, annual_price_paise, monthly_credit_units, max_active_projects, is_custom, active, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?, ?)",
      );
      insert.run("free", "Free", "Try SILPI on a real project.", 0, 0, 10_000, 0, 1, at, at);
      insert.run("starter", "Starter", "For an individual developer.", 49_900, 499_000, 100_000, 0, 2, at, at);
      insert.run("pro", "Pro", "For a working freelancer.", 149_900, 1_499_000, 400_000, 0, 3, at, at);
      insert.run("professional", "Professional", "For a small agency.", 399_900, 3_999_000, 1_500_000, 0, 4, at, at);
      insert.run("enterprise", "Enterprise", "Custom pricing and credits. Contact us.", null, null, 0, 1, 5, at, at);
    },
  },
  {
    id: 4,
    name: "AI Gateway: model catalogue with prices, request log, per-organization daily cap",
    up(db) {
      // Provider prices are whole micro-USD per million tokens (0.10 USD = 100000), so cost maths is exact integers.
      // ai_requests stores NO prompt or answer text, only sizes and money: customers' content is not kept by the gateway.
      db.exec(`
        CREATE TABLE ai_models (
          id                        TEXT PRIMARY KEY,
          provider                  TEXT NOT NULL,
          provider_model            TEXT NOT NULL,
          label                     TEXT NOT NULL,
          tier                      TEXT NOT NULL CHECK (tier IN ('fast', 'balanced', 'best', 'demo')),
          input_usd_micro_per_mtok  INTEGER NOT NULL CHECK (input_usd_micro_per_mtok >= 0),
          output_usd_micro_per_mtok INTEGER NOT NULL CHECK (output_usd_micro_per_mtok >= 0),
          markup_basis_points       INTEGER NOT NULL DEFAULT 10000 CHECK (markup_basis_points >= 0),
          max_output_tokens         INTEGER NOT NULL CHECK (max_output_tokens > 0),
          priority                  INTEGER NOT NULL DEFAULT 100,
          enabled                   INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          created_at                TEXT NOT NULL,
          updated_at                TEXT NOT NULL
        );

        CREATE TABLE ai_requests (
          id                      TEXT PRIMARY KEY,
          org_id                  TEXT NOT NULL REFERENCES organizations(id),
          user_id                 TEXT NOT NULL DEFAULT '',
          idempotency_key         TEXT NOT NULL,
          status                  TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
          purpose                 TEXT NOT NULL DEFAULT '',
          requested_model         TEXT NOT NULL,
          model_id                TEXT,
          fallback_used           INTEGER NOT NULL DEFAULT 0 CHECK (fallback_used IN (0, 1)),
          attempts                INTEGER NOT NULL DEFAULT 0,
          reservation_id          TEXT,
          reserved_units          INTEGER NOT NULL DEFAULT 0,
          prompt_chars            INTEGER NOT NULL DEFAULT 0,
          response_chars          INTEGER NOT NULL DEFAULT 0,
          input_tokens            INTEGER NOT NULL DEFAULT 0,
          output_tokens           INTEGER NOT NULL DEFAULT 0,
          provider_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
          charged_units           INTEGER NOT NULL DEFAULT 0,
          uncollected_units       INTEGER NOT NULL DEFAULT 0,
          provider_request_id     TEXT,
          error_code              TEXT,
          error_message           TEXT,
          latency_ms              INTEGER,
          created_at              TEXT NOT NULL,
          finished_at             TEXT,
          UNIQUE (org_id, idempotency_key)
        );
        CREATE INDEX ai_requests_org_time ON ai_requests(org_id, created_at);
        CREATE INDEX ai_requests_running ON ai_requests(status, created_at) WHERE status = 'running';

        CREATE TABLE ai_org_limits (
          org_id          TEXT PRIMARY KEY REFERENCES organizations(id),
          daily_cap_units INTEGER CHECK (daily_cap_units IS NULL OR daily_cap_units >= 0),
          updated_at      TEXT NOT NULL
        );
      `);
      // Starting catalogue. PROPOSED values, not validated: prices follow the agent's table (silpi-agent/src/pricing.ts) and
      // must be re-checked against the provider's price page; every one is an ordinary row edited from the admin API.
      const at = new Date().toISOString();
      const insert = db.prepare(
        "INSERT INTO ai_models (id, provider, provider_model, label, tier, input_usd_micro_per_mtok, output_usd_micro_per_mtok, markup_basis_points, max_output_tokens, priority, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 10000, ?, ?, 1, ?, ?)",
      );
      insert.run("haiku-5-5", "anthropic", "claude-haiku-5-5", "Fast", "fast", 100_000, 500_000, 8192, 10, at, at);
      insert.run("sonnet-5-5", "anthropic", "claude-sonnet-5-5", "Balanced", "balanced", 2_000_000, 10_000_000, 8192, 10, at, at);
      insert.run("opus-5-5", "anthropic", "claude-opus-5-5", "Best quality", "best", 4_000_000, 20_000_000, 16_000, 10, at, at);
      // A free built-in model that answers without calling any provider: lets the screens and a new install be tried at no cost.
      insert.run("silpi-demo", "echo", "echo", "Demo (no AI, free)", "demo", 0, 0, 2048, 100, at, at);
      // 1 USD of provider cost = 45,000 units = 45 credits. About 2x cover over a Pro credit (Rs 1,499 / 400 credits = Rs 3.75) at Rs 85 per USD.
      db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); // same shape as the base schema; present already in a real database
      db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_units_per_usd', '45000')").run();
    },
  },
  {
    id: 5,
    name: "AI jobs: multi-step project builds with a budget, steps and generated files",
    up(db) {
      // Unlike gateway requests, a job's brief and its generated files ARE stored: they are the customer's product.
      db.exec(`
        CREATE TABLE ai_jobs (
          id               TEXT PRIMARY KEY,
          org_id           TEXT NOT NULL REFERENCES organizations(id),
          user_id          TEXT NOT NULL DEFAULT '',
          title            TEXT NOT NULL,
          brief            TEXT NOT NULL,
          quality          TEXT NOT NULL CHECK (quality IN ('economy', 'standard', 'high', 'demo')),
          review           INTEGER NOT NULL DEFAULT 0 CHECK (review IN (0, 1)),
          status           TEXT NOT NULL CHECK (status IN ('planning', 'awaiting_approval', 'running', 'paused', 'completed', 'failed', 'cancelled')),
          pause_reason     TEXT,
          message          TEXT NOT NULL DEFAULT '',
          plan_summary     TEXT NOT NULL DEFAULT '',
          budget_units     INTEGER NOT NULL DEFAULT 0 CHECK (budget_units >= 0),
          spent_units      INTEGER NOT NULL DEFAULT 0 CHECK (spent_units >= 0),
          cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
          heartbeat_at     TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL,
          finished_at      TEXT
        );
        CREATE INDEX ai_jobs_org ON ai_jobs(org_id, created_at);

        CREATE TABLE ai_job_steps (
          job_id        TEXT NOT NULL REFERENCES ai_jobs(id),
          seq           INTEGER NOT NULL,
          kind          TEXT NOT NULL CHECK (kind IN ('plan', 'file', 'review')),
          label         TEXT NOT NULL,
          model         TEXT NOT NULL,
          status        TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
          attempt       INTEGER NOT NULL DEFAULT 0,
          charged_units INTEGER NOT NULL DEFAULT 0,
          input_tokens  INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          model_used    TEXT,
          error         TEXT,
          payload       TEXT NOT NULL DEFAULT '{}',
          output        TEXT,
          started_at    TEXT,
          finished_at   TEXT,
          PRIMARY KEY (job_id, seq)
        );
      `);
    },
  },
  {
    id: 6,
    name: "dollar prices on plans; Starter plan retired; Professional credits 1,200",
    up(db) {
      // Prices shown to customers outside India. Whole US cents, beside the paise columns: invoices and GST are still rupees only
      // (dollar billing arrives with a payment gateway that can charge in dollars). PROPOSED values, edited from the admin plan API.
      db.exec(`
        ALTER TABLE plans ADD COLUMN monthly_price_usd_cents INTEGER CHECK (monthly_price_usd_cents IS NULL OR monthly_price_usd_cents >= 0);
        ALTER TABLE plans ADD COLUMN annual_price_usd_cents  INTEGER CHECK (annual_price_usd_cents  IS NULL OR annual_price_usd_cents  >= 0);
      `);
      const at = new Date().toISOString();
      const usd = db.prepare("UPDATE plans SET monthly_price_usd_cents = ?, annual_price_usd_cents = ?, updated_at = ? WHERE id = ?");
      usd.run(0, 0, at, "free");
      usd.run(2500, 25_000, at, "pro"); // annual = 10 x monthly (2 months free), as in rupees
      usd.run(7000, 70_000, at, "professional");
      // Starter is retired, not deleted: a plan with history stays in the table, it just stops being offered or chosen.
      db.prepare("UPDATE plans SET active = 0, updated_at = ? WHERE id = 'starter'").run(at);
      // The Professional allowance was too generous for its price. Only moved if nobody has edited it since it was seeded.
      db.prepare("UPDATE plans SET monthly_credit_units = 1200000, updated_at = ? WHERE id = 'professional' AND monthly_credit_units = 1500000").run(at);
    },
  },
  {
    id: 7,
    name: "pound prices on plans, for customers in the United Kingdom",
    up(db) {
      // Whole pence. PROPOSED values: round local price points near the dollar prices, edited from the admin plan API.
      db.exec(`
        ALTER TABLE plans ADD COLUMN monthly_price_gbp_pence INTEGER CHECK (monthly_price_gbp_pence IS NULL OR monthly_price_gbp_pence >= 0);
        ALTER TABLE plans ADD COLUMN annual_price_gbp_pence  INTEGER CHECK (annual_price_gbp_pence  IS NULL OR annual_price_gbp_pence  >= 0);
      `);
      const at = new Date().toISOString();
      const gbp = db.prepare("UPDATE plans SET monthly_price_gbp_pence = ?, annual_price_gbp_pence = ?, updated_at = ? WHERE id = ?");
      gbp.run(0, 0, at, "free");
      gbp.run(1900, 19_000, at, "pro"); // annual = 10 x monthly
      gbp.run(5500, 55_000, at, "professional");
    },
  },
  {
    id: 8,
    name: "credit sizes for the Pro plan: a plan family with larger monthly credit packs",
    up(db) {
      // Like a "choose your credits" selector, but every size is a REAL plan row, so subscriptions, invoices and plan changes work
      // for it unchanged. "family" groups the sizes of one plan; the row whose id equals its family is the headline (smallest) size.
      // The per-credit price falls by at most 10% from the smallest size to the largest. PROPOSED values, edited from the admin plan API.
      db.exec("ALTER TABLE plans ADD COLUMN family TEXT");
      db.prepare("UPDATE plans SET family = 'pro' WHERE id = 'pro'").run();
      const at = new Date().toISOString();
      const insert = db.prepare(
        `INSERT INTO plans (id, name, description, monthly_price_paise, annual_price_paise, monthly_price_usd_cents, annual_price_usd_cents, monthly_price_gbp_pence, annual_price_gbp_pence,
                            monthly_credit_units, max_active_projects, is_custom, active, sort_order, family, created_at, updated_at)
         VALUES (?, ?, 'For a working freelancer.', ?, ?, ?, ?, ?, ?, ?, NULL, 0, 1, 3, 'pro', ?, ?)`,
      );
      // id, name, credit units, rupees (paise), dollars (cents), pounds (pence): the monthly price; the yearly price is 10 x monthly.
      const sizes: [string, string, number, number, number, number][] = [
        ["pro-800", "Pro 800 credits", 800_000, 299_800, 5000, 3800],
        ["pro-1600", "Pro 1,600 credits", 1_600_000, 569_900, 9600, 7300],
        ["pro-3200", "Pro 3,200 credits", 3_200_000, 1_119_900, 18_600, 14_100],
        ["pro-6400", "Pro 6,400 credits", 6_400_000, 2_159_900, 36_000, 27_400],
      ];
      for (const [id, name, units, inr, usd, gbp] of sizes) insert.run(id, name, inr, inr * 10, usd, usd * 10, gbp, gbp * 10, units, at, at);
    },
  },
  {
    id: 9,
    name: "credit sizes for the Professional plan, priced at the same rate per credit as Pro",
    up(db) {
      // Professional becomes a family like Pro: bigger monthly packs, each a REAL plan row (so billing works for it unchanged).
      // There is no team feature yet to justify a higher price per credit, so the per-credit rate matches Pro (USD 0.0625) and only the
      // volume discount grows with the pack (up to 14%). PROPOSED values, edited from the admin plan API.
      const at = new Date().toISOString();
      // The headline size moves to the new rate, but only if nobody has edited it since it was seeded.
      db.prepare(
        `UPDATE plans SET family = 'professional', monthly_price_paise = 449900, annual_price_paise = 4499000, monthly_price_usd_cents = 7500, annual_price_usd_cents = 75000,
           monthly_price_gbp_pence = 5700, annual_price_gbp_pence = 57000, updated_at = ?
         WHERE id = 'professional' AND monthly_price_paise = 399900`,
      ).run(at);
      db.prepare("UPDATE plans SET family = 'professional' WHERE id = 'professional' AND family IS NULL").run();
      const insert = db.prepare(
        `INSERT INTO plans (id, name, description, monthly_price_paise, annual_price_paise, monthly_price_usd_cents, annual_price_usd_cents, monthly_price_gbp_pence, annual_price_gbp_pence,
                            monthly_credit_units, max_active_projects, is_custom, active, sort_order, family, created_at, updated_at)
         VALUES (?, ?, 'For a small agency.', ?, ?, ?, ?, ?, ?, ?, NULL, 0, 1, 4, 'professional', ?, ?)`,
      );
      // id, name, credit units, rupees (paise), dollars (cents), pounds (pence): the monthly price; the yearly price is 10 x monthly.
      const sizes: [string, string, number, number, number, number][] = [
        ["professional-2400", "Professional 2,400 credits", 2_400_000, 899_800, 15_000, 11_400],
        ["professional-4800", "Professional 4,800 credits", 4_800_000, 1_709_900, 28_500, 21_700],
        ["professional-9600", "Professional 9,600 credits", 9_600_000, 3_239_900, 54_000, 41_000],
        ["professional-19200", "Professional 19,200 credits", 19_200_000, 6_189_900, 103_200, 78_400],
      ];
      for (const [id, name, units, inr, usd, gbp] of sizes) insert.run(id, name, inr, inr * 10, usd, usd * 10, gbp, gbp * 10, units, at, at);
    },
  },
  {
    id: 10,
    name: "credit buckets: promotional, subscription and purchased credits with expiry, held per reservation",
    up(db) {
      // The ledger stays the source of truth. Buckets say WHICH credits a ledger row moved: they are spent in a fixed order
      // (promotional, then subscription, then purchased; soonest expiry first) and some can expire. Every ledger row after this
      // migration has matching rows in credit_ledger_buckets (append-only), so buckets can be checked against the ledger at any time.
      db.exec(`
        CREATE TABLE credit_buckets (
          id                 TEXT PRIMARY KEY,
          org_id             TEXT NOT NULL REFERENCES organizations(id),
          category           TEXT NOT NULL CHECK (category IN ('promotional', 'subscription', 'purchased')),
          granted_units      INTEGER NOT NULL CHECK (granted_units > 0),
          opening_units      INTEGER NOT NULL DEFAULT 0 CHECK (opening_units >= 0),
          opening_held_units INTEGER NOT NULL DEFAULT 0 CHECK (opening_held_units >= 0),
          remaining_units    INTEGER NOT NULL CHECK (remaining_units >= 0),
          held_units         INTEGER NOT NULL DEFAULT 0 CHECK (held_units >= 0),
          expires_at         TEXT,
          source             TEXT NOT NULL DEFAULT '',
          created_at         TEXT NOT NULL,
          CHECK (remaining_units <= granted_units),
          CHECK (held_units <= remaining_units)
        );
        CREATE INDEX credit_buckets_org ON credit_buckets(org_id, category, expires_at, created_at);

        -- Which buckets a reservation holds, in the order they will be charged.
        CREATE TABLE credit_reservation_holds (
          reservation_id TEXT NOT NULL REFERENCES credit_reservations(id),
          bucket_id      TEXT NOT NULL REFERENCES credit_buckets(id),
          seq            INTEGER NOT NULL,
          units          INTEGER NOT NULL CHECK (units > 0),
          PRIMARY KEY (reservation_id, bucket_id)
        );

        -- How each ledger row moved each bucket. Never edited, never deleted.
        CREATE TABLE credit_ledger_buckets (
          ledger_id   INTEGER NOT NULL REFERENCES credit_ledger(id),
          bucket_id   TEXT NOT NULL REFERENCES credit_buckets(id),
          delta_units INTEGER NOT NULL,
          held_delta  INTEGER NOT NULL,
          PRIMARY KEY (ledger_id, bucket_id)
        );
        CREATE INDEX ledger_buckets_bucket ON credit_ledger_buckets(bucket_id);
        CREATE TRIGGER credit_ledger_buckets_no_update BEFORE UPDATE ON credit_ledger_buckets BEGIN SELECT RAISE(ABORT, 'credit_ledger_buckets is append-only'); END;
        CREATE TRIGGER credit_ledger_buckets_no_delete BEFORE DELETE ON credit_ledger_buckets BEGIN SELECT RAISE(ABORT, 'credit_ledger_buckets is append-only'); END;
      `);

      // Existing wallets keep exactly what they have: one "opening balance" bucket per wallet. It is typed purchased and never expires, so
      // nobody loses credits to a rule that did not exist when they got them. Active reservations keep holding their units from it.
      const at = new Date().toISOString();
      const wallets = db.prepare("SELECT org_id, balance_units, reserved_units FROM credit_wallets WHERE balance_units > 0").all() as { org_id: string; balance_units: number; reserved_units: number }[];
      const bucket = db.prepare(
        "INSERT INTO credit_buckets (id, org_id, category, granted_units, opening_units, opening_held_units, remaining_units, held_units, expires_at, source, created_at) VALUES (?, ?, 'purchased', ?, ?, ?, ?, ?, NULL, 'opening-balance', ?)",
      );
      const hold = db.prepare("INSERT INTO credit_reservation_holds (reservation_id, bucket_id, seq, units) VALUES (?, ?, 1, ?)");
      const active = db.prepare("SELECT id, units FROM credit_reservations WHERE org_id = ? AND status = 'active'");
      for (const w of wallets) {
        const id = `bkt_opening_${w.org_id}`;
        bucket.run(id, w.org_id, w.balance_units, w.balance_units, w.reserved_units, w.balance_units, w.reserved_units, at);
        for (const r of active.all(w.org_id) as { id: string; units: number }[]) hold.run(r.id, id, r.units);
      }
      // Ledger rows up to here predate buckets; the row-by-row check starts after this id.
      const last = (db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM credit_ledger").get() as { n: number }).n;
      db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('bucket_ledger_start_id', ?)").run(String(last));
    },
  },
  {
    id: 11,
    name: "versioned model prices, markup rules, usage detail and attempt log for AI metering",
    up(db) {
      // 1. Prices are versioned. ai_models keeps the CURRENT price (so existing code is unchanged); model_prices keeps every version ever
      //    used, append-only, so any past request can be re-priced exactly. A request records the version it was charged at.
      db.exec(`
        ALTER TABLE ai_models ADD COLUMN cache_read_usd_micro_per_mtok  INTEGER CHECK (cache_read_usd_micro_per_mtok  IS NULL OR cache_read_usd_micro_per_mtok  >= 0);
        ALTER TABLE ai_models ADD COLUMN cache_write_usd_micro_per_mtok INTEGER CHECK (cache_write_usd_micro_per_mtok IS NULL OR cache_write_usd_micro_per_mtok >= 0);
        ALTER TABLE ai_models ADD COLUMN price_version INTEGER NOT NULL DEFAULT 1;

        CREATE TABLE model_prices (
          id                         INTEGER PRIMARY KEY AUTOINCREMENT,
          model_id                   TEXT NOT NULL REFERENCES ai_models(id),
          version                    INTEGER NOT NULL CHECK (version >= 1),
          input_usd_micro_per_mtok   INTEGER NOT NULL CHECK (input_usd_micro_per_mtok >= 0),
          output_usd_micro_per_mtok  INTEGER NOT NULL CHECK (output_usd_micro_per_mtok >= 0),
          cache_read_usd_micro_per_mtok  INTEGER CHECK (cache_read_usd_micro_per_mtok  IS NULL OR cache_read_usd_micro_per_mtok  >= 0),
          cache_write_usd_micro_per_mtok INTEGER CHECK (cache_write_usd_micro_per_mtok IS NULL OR cache_write_usd_micro_per_mtok >= 0),
          markup_basis_points        INTEGER NOT NULL CHECK (markup_basis_points >= 0),
          note                       TEXT NOT NULL DEFAULT '',
          changed_by                 TEXT NOT NULL DEFAULT '',
          created_at                 TEXT NOT NULL,
          UNIQUE (model_id, version)
        );
        CREATE TRIGGER model_prices_no_update BEFORE UPDATE ON model_prices BEGIN SELECT RAISE(ABORT, 'model_prices is append-only'); END;
        CREATE TRIGGER model_prices_no_delete BEFORE DELETE ON model_prices BEGIN SELECT RAISE(ABORT, 'model_prices is append-only'); END;
      `);
      const at = new Date().toISOString();
      db.prepare(
        `INSERT INTO model_prices (model_id, version, input_usd_micro_per_mtok, output_usd_micro_per_mtok, markup_basis_points, note, changed_by, created_at)
         SELECT id, 1, input_usd_micro_per_mtok, output_usd_micro_per_mtok, markup_basis_points, 'price when versioning began', 'migration', ? FROM ai_models`,
      ).run(at);

      // 2. The markup (what a customer is charged over the provider's cost) can be set for a provider, a model, a task type, or a mix.
      //    The most specific matching rule wins (see resolveMarkup); with no rule the model's own markup applies.
      db.exec(`
        CREATE TABLE markup_rules (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          provider            TEXT,
          model_id            TEXT REFERENCES ai_models(id),
          task_type           TEXT,
          markup_basis_points INTEGER NOT NULL CHECK (markup_basis_points >= 0 AND markup_basis_points <= 1000000),
          enabled             INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          note                TEXT NOT NULL DEFAULT '',
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          CHECK (provider IS NOT NULL OR model_id IS NOT NULL OR task_type IS NOT NULL)
        );
      `);

      // 3. What each request really used and how it was priced. Content is never stored: only sizes, money and the provider's own usage counts.
      db.exec(`
        ALTER TABLE ai_requests ADD COLUMN task_type               TEXT NOT NULL DEFAULT 'chat';
        ALTER TABLE ai_requests ADD COLUMN price_version           INTEGER;
        ALTER TABLE ai_requests ADD COLUMN cache_read_tokens       INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE ai_requests ADD COLUMN cache_write_tokens      INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE ai_requests ADD COLUMN other_charge_micro_usd  INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE ai_requests ADD COLUMN markup_basis_points     INTEGER;
        ALTER TABLE ai_requests ADD COLUMN markup_source           TEXT;
        ALTER TABLE ai_requests ADD COLUMN usage_source            TEXT CHECK (usage_source IS NULL OR usage_source IN ('provider', 'estimated'));
        ALTER TABLE ai_requests ADD COLUMN usage_raw               TEXT;
        ALTER TABLE ai_requests ADD COLUMN min_charge_applied      INTEGER NOT NULL DEFAULT 0 CHECK (min_charge_applied IN (0, 1));
      `);

      // 4. Every attempt at a provider, retries and fallbacks included, so a failed or repeated call is visible and its cost can be questioned.
      db.exec(`
        CREATE TABLE ai_request_attempts (
          request_id    TEXT NOT NULL REFERENCES ai_requests(id),
          attempt_no    INTEGER NOT NULL,
          model_id      TEXT NOT NULL,
          outcome       TEXT NOT NULL CHECK (outcome IN ('success', 'retryable-error', 'error')),
          error_message TEXT,
          latency_ms    INTEGER,
          input_tokens  INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT NOT NULL,
          PRIMARY KEY (request_id, attempt_no)
        );
      `);
    },
  },
  {
    id: 12,
    name: "plan prices per currency, price lock on subscriptions, the six-plan catalogue and the one-credit-is-one-cent definition",
    up(db) {
      const at = new Date().toISOString();

      // 1. A subscription remembers the price it was sold at. Without this, changing a plan's price would silently change what every
      //    existing customer is billed at their next renewal. Locked FIRST, from the plan prices as they are now, before anything below changes them.
      db.exec(`
        ALTER TABLE subscriptions ADD COLUMN currency          TEXT NOT NULL DEFAULT 'INR';
        ALTER TABLE subscriptions ADD COLUMN unit_amount_minor INTEGER CHECK (unit_amount_minor IS NULL OR unit_amount_minor >= 0);
        ALTER TABLE subscriptions ADD COLUMN trial_ends_at     TEXT;
        ALTER TABLE subscriptions ADD COLUMN coupon_redemption_id TEXT;
        ALTER TABLE subscriptions ADD COLUMN allowance_monthly_units INTEGER CHECK (allowance_monthly_units IS NULL OR allowance_monthly_units >= 0);
      `);
      db.exec(`
        UPDATE subscriptions SET unit_amount_minor =
          (SELECT CASE WHEN subscriptions.billing_period = 'annual' THEN p.annual_price_paise ELSE p.monthly_price_paise END FROM plans p WHERE p.id = subscriptions.plan_id)
        WHERE unit_amount_minor IS NULL;
        UPDATE subscriptions SET allowance_monthly_units = (SELECT p.monthly_credit_units FROM plans p WHERE p.id = subscriptions.plan_id) WHERE allowance_monthly_units IS NULL;
        ALTER TABLE subscription_invoices ADD COLUMN currency        TEXT NOT NULL DEFAULT 'INR';
        ALTER TABLE subscription_invoices ADD COLUMN discount_minor  INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0);
        ALTER TABLE subscription_invoices ADD COLUMN coupon_code     TEXT;
        ALTER TABLE plans ADD COLUMN trial_days         INTEGER CHECK (trial_days IS NULL OR (trial_days >= 1 AND trial_days <= 365));
        ALTER TABLE plans ADD COLUMN trial_credit_units INTEGER NOT NULL DEFAULT 0 CHECK (trial_credit_units >= 0);

        CREATE TABLE plan_prices (
          id           TEXT PRIMARY KEY,
          plan_id      TEXT NOT NULL REFERENCES plans(id),
          currency     TEXT NOT NULL CHECK (length(currency) = 3),
          period       TEXT NOT NULL CHECK (period IN ('monthly', 'annual')),
          amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
          active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          UNIQUE (plan_id, currency, period)
        );
      `);

      // 2. The catalogue from the brief. Credits are $0.01 of customer usage each (see step 5). USD and INR are the brief's figures; the
      //    pound prices are PROPOSED. Annual is ten months (two months free). The old Pro and Professional sizes are retired, not deleted.
      const upsert = db.prepare(
        `INSERT INTO plans (id, name, description, monthly_price_paise, annual_price_paise, monthly_price_usd_cents, annual_price_usd_cents, monthly_price_gbp_pence, annual_price_gbp_pence,
                            monthly_credit_units, max_active_projects, is_custom, active, sort_order, family, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, monthly_price_paise = excluded.monthly_price_paise, annual_price_paise = excluded.annual_price_paise,
           monthly_price_usd_cents = excluded.monthly_price_usd_cents, annual_price_usd_cents = excluded.annual_price_usd_cents, monthly_price_gbp_pence = excluded.monthly_price_gbp_pence,
           annual_price_gbp_pence = excluded.annual_price_gbp_pence, monthly_credit_units = excluded.monthly_credit_units, active = 1, sort_order = excluded.sort_order, family = excluded.family, updated_at = excluded.updated_at`,
      );
      // id, name, description, rupees, dollars, pounds, credits, sort order
      const catalogue: [string, string, string, number, number, number, number, number][] = [
        ["free", "Free", "Try SILPI on a real project.", 0, 0, 0, 25, 1],
        ["starter", "Starter", "For trying real projects.", 499, 6, 5, 200, 2],
        ["creator", "Creator", "For solo creators.", 999, 12, 10, 400, 3],
        ["pro", "Pro", "For a working freelancer.", 1499, 19, 15, 700, 4],
        ["professional", "Professional", "For a small agency.", 4499, 49, 39, 2000, 5],
        ["studio", "Studio", "For studios and growing agencies.", 8999, 99, 79, 4500, 6],
      ];
      for (const [id, name, description, inr, usd, gbp, credits, order] of catalogue) {
        upsert.run(id, name, description, inr * 100, inr * 1000, usd * 100, usd * 1000, gbp * 100, gbp * 1000, credits * 1000, order, id, at, at);
      }
      db.prepare("UPDATE plans SET sort_order = 7, updated_at = ? WHERE id = 'enterprise'").run(at);
      db.prepare("UPDATE plans SET active = 0, sort_order = 90, updated_at = ? WHERE id IN ('pro-800', 'pro-1600', 'pro-3200', 'pro-6400', 'professional-2400', 'professional-4800', 'professional-9600', 'professional-19200')").run(at);

      // 3. Every price now lives in plan_prices, whatever the currency. The older columns on plans stay (nothing is dropped) and are kept in step.
      const price = db.prepare("INSERT OR REPLACE INTO plan_prices (id, plan_id, currency, period, amount_minor, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)");
      const rows = db.prepare(
        `SELECT id, monthly_price_paise AS inrM, annual_price_paise AS inrA, monthly_price_usd_cents AS usdM, annual_price_usd_cents AS usdA, monthly_price_gbp_pence AS gbpM, annual_price_gbp_pence AS gbpA FROM plans`,
      ).all() as Record<string, string | number | null>[];
      for (const r of rows) {
        const list: [string, string, number | null][] = [["INR", "monthly", r.inrM as number | null], ["INR", "annual", r.inrA as number | null], ["USD", "monthly", r.usdM as number | null], ["USD", "annual", r.usdA as number | null], ["GBP", "monthly", r.gbpM as number | null], ["GBP", "annual", r.gbpA as number | null]];
        for (const [currency, period, amount] of list) if (amount !== null) price.run(`pp_${r.id}_${currency}_${period}`, r.id, currency, period, amount, at, at);
      }

      // 4. A credit is now worth $0.01 of customer usage. The gateway's maths already is: provider cost x markup x units per dollar. With a
      //    2.5 markup and 100 credits per dollar of charge, $1 of provider cost is 250 credits. Markups move through the price history.
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_units_per_usd', '100000')").run();
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('credit_definition', '1 credit = USD 0.01 of customer-facing AI usage value')").run();
      const models = db.prepare("SELECT id, input_usd_micro_per_mtok AS i, output_usd_micro_per_mtok AS o, cache_read_usd_micro_per_mtok AS cr, cache_write_usd_micro_per_mtok AS cw, price_version AS v FROM ai_models WHERE provider != 'echo' AND markup_basis_points != 25000").all() as { id: string; i: number; o: number; cr: number | null; cw: number | null; v: number }[];
      for (const m of models) {
        db.prepare(
          "INSERT INTO model_prices (model_id, version, input_usd_micro_per_mtok, output_usd_micro_per_mtok, cache_read_usd_micro_per_mtok, cache_write_usd_micro_per_mtok, markup_basis_points, note, changed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 25000, ?, 'migration', ?)",
        ).run(m.id, m.v + 1, m.i, m.o, m.cr, m.cw, "markup 2.5 when one credit became USD 0.01 of usage", at);
        db.prepare("UPDATE ai_models SET markup_basis_points = 25000, price_version = ?, updated_at = ? WHERE id = ?").run(m.v + 1, at, m.id);
      }
    },
  },
  {
    id: 13,
    name: "coupons and their redemptions",
    up(db) {
      // A coupon is a discount code. It can be a percentage or a fixed amount in one currency, last for one invoice, a number of months,
      // or for as long as the subscription runs, and can be limited by date, by number of uses and by plan. One organization uses a coupon once.
      db.exec(`
        CREATE TABLE coupons (
          id                  TEXT PRIMARY KEY,
          code                TEXT NOT NULL COLLATE NOCASE UNIQUE,
          name                TEXT NOT NULL DEFAULT '',
          kind                TEXT NOT NULL CHECK (kind IN ('percent', 'fixed')),
          percent_bp          INTEGER CHECK (percent_bp IS NULL OR (percent_bp >= 1 AND percent_bp <= 10000)),
          fixed_amount_minor  INTEGER CHECK (fixed_amount_minor IS NULL OR fixed_amount_minor >= 1),
          fixed_currency      TEXT CHECK (fixed_currency IS NULL OR length(fixed_currency) = 3),
          duration            TEXT NOT NULL CHECK (duration IN ('once', 'repeating', 'forever')),
          duration_months     INTEGER CHECK (duration_months IS NULL OR duration_months >= 1),
          valid_from          TEXT,
          valid_until         TEXT,
          max_redemptions     INTEGER CHECK (max_redemptions IS NULL OR max_redemptions >= 1),
          plan_ids            TEXT,
          active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          CHECK ((kind = 'percent' AND percent_bp IS NOT NULL AND fixed_amount_minor IS NULL) OR (kind = 'fixed' AND fixed_amount_minor IS NOT NULL AND fixed_currency IS NOT NULL AND percent_bp IS NULL)),
          CHECK ((duration = 'repeating') = (duration_months IS NOT NULL))
        );

        CREATE TABLE coupon_redemptions (
          id              TEXT PRIMARY KEY,
          coupon_id       TEXT NOT NULL REFERENCES coupons(id),
          org_id          TEXT NOT NULL REFERENCES organizations(id),
          subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
          redeemed_at     TEXT NOT NULL,
          periods_used    INTEGER NOT NULL DEFAULT 0 CHECK (periods_used >= 0),
          UNIQUE (coupon_id, org_id)
        );
        CREATE INDEX coupon_redemptions_sub ON coupon_redemptions(subscription_id);
      `);
    },
  },
  {
    id: 14,
    name: "payments, webhook events, refunds, credit top-up packages and orders",
    up(db) {
      db.exec(`
        -- Packs of extra credits a customer can buy once, on top of the plan. Prices per currency, like plans.
        CREATE TABLE credit_packages (
          id           TEXT PRIMARY KEY,
          name         TEXT NOT NULL,
          credit_units INTEGER NOT NULL CHECK (credit_units > 0),
          active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          sort_order   INTEGER NOT NULL DEFAULT 0,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        );
        CREATE TABLE credit_package_prices (
          package_id   TEXT NOT NULL REFERENCES credit_packages(id),
          currency     TEXT NOT NULL CHECK (length(currency) = 3),
          amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
          PRIMARY KEY (package_id, currency)
        );

        -- One purchase of a package. Amounts are fixed when the order is made (tax included in total), so a later price change cannot alter it.
        CREATE TABLE topups (
          id               TEXT PRIMARY KEY,
          number           TEXT NOT NULL UNIQUE,
          org_id           TEXT NOT NULL REFERENCES organizations(id),
          package_id       TEXT NOT NULL REFERENCES credit_packages(id),
          credit_units     INTEGER NOT NULL CHECK (credit_units > 0),
          currency         TEXT NOT NULL,
          subtotal_minor   INTEGER NOT NULL CHECK (subtotal_minor >= 0),
          gst_basis_points INTEGER NOT NULL DEFAULT 0,
          gst_minor        INTEGER NOT NULL DEFAULT 0 CHECK (gst_minor >= 0),
          total_minor      INTEGER NOT NULL CHECK (total_minor >= 0),
          status           TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'cancelled')),
          created_by       TEXT NOT NULL DEFAULT '',
          created_at       TEXT NOT NULL,
          paid_at          TEXT,
          CHECK (total_minor = subtotal_minor + gst_minor)
        );
        CREATE INDEX topups_org ON topups(org_id, created_at);

        -- Every attempt to pay an invoice or a top-up, whoever took the money (a provider, or the administrator recording it by hand).
        CREATE TABLE billing_payments (
          id                  TEXT PRIMARY KEY,
          org_id              TEXT NOT NULL REFERENCES organizations(id),
          provider            TEXT NOT NULL,
          provider_payment_id TEXT,
          purpose             TEXT NOT NULL CHECK (purpose IN ('subscription_invoice', 'topup')),
          invoice_id          TEXT REFERENCES subscription_invoices(id),
          topup_id            TEXT REFERENCES topups(id),
          currency            TEXT NOT NULL,
          amount_minor        INTEGER NOT NULL CHECK (amount_minor >= 0),
          status              TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded', 'disputed')),
          failure_reason      TEXT,
          refunded_minor      INTEGER NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor),
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          paid_at             TEXT,
          CHECK ((purpose = 'subscription_invoice' AND invoice_id IS NOT NULL AND topup_id IS NULL) OR (purpose = 'topup' AND topup_id IS NOT NULL AND invoice_id IS NULL))
        );
        -- The same provider payment can only ever be one row, so a repeated notice cannot count twice.
        CREATE UNIQUE INDEX billing_payments_provider_ref ON billing_payments(provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
        CREATE INDEX billing_payments_org ON billing_payments(org_id, created_at);

        -- Every notice a provider sent. One row per provider event id: a notice received twice is recognised and not applied twice.
        CREATE TABLE payment_webhook_events (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          provider     TEXT NOT NULL,
          event_id     TEXT NOT NULL,
          type         TEXT NOT NULL,
          status       TEXT NOT NULL CHECK (status IN ('processed', 'ignored', 'failed')),
          error        TEXT,
          payload      TEXT,
          received_at  TEXT NOT NULL,
          UNIQUE (provider, event_id)
        );

        CREATE TABLE refunds (
          id                        TEXT PRIMARY KEY,
          payment_id                TEXT NOT NULL REFERENCES billing_payments(id),
          org_id                    TEXT NOT NULL REFERENCES organizations(id),
          provider                  TEXT NOT NULL,
          provider_refund_id        TEXT,
          amount_minor              INTEGER NOT NULL CHECK (amount_minor > 0),
          currency                  TEXT NOT NULL,
          reason                    TEXT NOT NULL DEFAULT '',
          status                    TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
          credits_reversed_units    INTEGER NOT NULL DEFAULT 0 CHECK (credits_reversed_units >= 0),
          credits_unrecovered_units INTEGER NOT NULL DEFAULT 0 CHECK (credits_unrecovered_units >= 0),
          requested_by              TEXT NOT NULL DEFAULT '',
          idempotency_key           TEXT,
          created_at                TEXT NOT NULL
        );
        CREATE UNIQUE INDEX refunds_key ON refunds(payment_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE UNIQUE INDEX refunds_provider_ref ON refunds(provider, provider_refund_id) WHERE provider_refund_id IS NOT NULL;
      `);

      // The brief's starting packs. PROPOSED figures, edited from the admin screen. The pound prices are my proposal.
      const at = new Date().toISOString();
      const pack = db.prepare("INSERT INTO credit_packages (id, name, credit_units, active, sort_order, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)");
      const price = db.prepare("INSERT INTO credit_package_prices (package_id, currency, amount_minor) VALUES (?, ?, ?)");
      // credits, dollars (cents), rupees (paise), pounds (pence)
      const packs: [number, number, number, number][] = [[100, 300, 29_900, 250], [250, 700, 69_900, 550], [500, 1400, 129_900, 1100], [1000, 2700, 249_900, 2100]];
      packs.forEach(([credits, usd, inr, gbp], i) => {
        const id = `pkg_${credits}`;
        pack.run(id, `${credits.toLocaleString("en-US")} credits`, credits * 1000, i + 1, at, at);
        price.run(id, "USD", usd);
        price.run(id, "INR", inr);
        price.run(id, "GBP", gbp);
      });
    },
  },
  {
    id: 15,
    name: "Audit log: an append-only record of who changed money, prices, plans, credits and access",
    up(db) {
      db.exec(`
        CREATE TABLE audit_logs (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          at          TEXT NOT NULL,
          actor       TEXT NOT NULL,
          action      TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id   TEXT NOT NULL DEFAULT '',
          org_id      TEXT,
          detail      TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX audit_logs_action ON audit_logs(action, id);
        CREATE INDEX audit_logs_org ON audit_logs(org_id, id);
        CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
        CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
      `);
    },
  },
  {
    id: 16,
    name: "Exchange rates for reports, tax rules, billing profiles, and the tax name and addressee on invoices",
    up(db) {
      db.exec(`
        -- 1 US dollar = per_usd_micro / 1,000,000 units of the currency. Only used to add up reports; never changes what a customer is billed.
        CREATE TABLE exchange_rates (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          currency      TEXT NOT NULL,
          per_usd_micro INTEGER NOT NULL CHECK (per_usd_micro > 0),
          source        TEXT NOT NULL,
          created_by    TEXT NOT NULL DEFAULT '',
          created_at    TEXT NOT NULL
        );
        CREATE INDEX exchange_rates_currency ON exchange_rates(currency, id);
        CREATE TRIGGER exchange_rates_no_update BEFORE UPDATE ON exchange_rates BEGIN SELECT RAISE(ABORT, 'exchange_rates is append-only'); END;
        CREATE TRIGGER exchange_rates_no_delete BEFORE DELETE ON exchange_rates BEGIN SELECT RAISE(ABORT, 'exchange_rates is append-only'); END;

        -- No rule is built in. Rates are added by the administrator after checking them.
        CREATE TABLE tax_rules (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          country           TEXT NOT NULL,
          currency          TEXT,
          label             TEXT NOT NULL,
          rate_basis_points INTEGER NOT NULL CHECK (rate_basis_points >= 0 AND rate_basis_points <= 10000),
          active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          note              TEXT NOT NULL DEFAULT '',
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        );
        CREATE UNIQUE INDEX tax_rules_unique ON tax_rules(country, COALESCE(currency, ''));

        CREATE TABLE billing_profiles (
          org_id        TEXT PRIMARY KEY REFERENCES organizations(id),
          legal_name    TEXT NOT NULL,
          country       TEXT NOT NULL,
          address_line1 TEXT NOT NULL,
          address_line2 TEXT NOT NULL DEFAULT '',
          city          TEXT NOT NULL,
          region        TEXT NOT NULL DEFAULT '',
          postal_code   TEXT NOT NULL DEFAULT '',
          tax_id        TEXT NOT NULL DEFAULT '',
          tax_id_type   TEXT NOT NULL DEFAULT '',
          updated_at    TEXT NOT NULL,
          updated_by    TEXT NOT NULL DEFAULT ''
        );

        -- The tax name and the addressee are written on each invoice when it is raised, so editing a profile or a rule later never rewrites an old invoice.
        ALTER TABLE subscription_invoices ADD COLUMN tax_label TEXT NOT NULL DEFAULT '';
        ALTER TABLE subscription_invoices ADD COLUMN bill_to   TEXT;
        ALTER TABLE topups ADD COLUMN tax_label TEXT NOT NULL DEFAULT '';
        ALTER TABLE topups ADD COLUMN bill_to   TEXT;
        UPDATE subscription_invoices SET tax_label = 'GST' WHERE gst_basis_points > 0;
        UPDATE topups SET tax_label = 'GST' WHERE gst_basis_points > 0;
      `);
    },
  },
  {
    id: 17,
    name: "Named administrator accounts with roles",
    up(db) {
      db.exec(`
        CREATE TABLE admin_accounts (
          id            TEXT PRIMARY KEY,
          email         TEXT NOT NULL UNIQUE,
          name          TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          role          TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
          status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
          created_at    TEXT NOT NULL,
          created_by    TEXT NOT NULL DEFAULT '',
          last_login_at TEXT
        );
      `);
    },
  },
  {
    id: 18,
    name: "Global pricing: countries, currencies, roles, levels, market rates with sources, pricing settings",
    up(db) {
      db.exec(`
        CREATE TABLE pricing_currencies (
          code         TEXT PRIMARY KEY,
          name         TEXT NOT NULL,
          symbol       TEXT NOT NULL,
          minor_digits INTEGER NOT NULL CHECK (minor_digits BETWEEN 0 AND 3),
          active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
        );
        CREATE TABLE pricing_countries (
          code       TEXT PRIMARY KEY CHECK (length(code) = 2),
          name       TEXT NOT NULL,
          currency   TEXT NOT NULL REFERENCES pricing_currencies(code),
          active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          sort_order INTEGER NOT NULL DEFAULT 100
        );
        CREATE TABLE pricing_roles (
          id         TEXT PRIMARY KEY,
          label      TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 100,
          active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
        );
        CREATE TABLE pricing_levels (
          id         TEXT PRIMARY KEY,
          label      TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 100,
          active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
        );

        -- One row per figure ever entered. A figure is never edited: a new row with a later start date replaces it, and the old one stays as history.
        -- Only 'enabled' can be switched. Every row carries where it came from and who entered it.
        CREATE TABLE country_market_rates (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          country        TEXT NOT NULL REFERENCES pricing_countries(code),
          role_id        TEXT NOT NULL REFERENCES pricing_roles(id),
          level_id       TEXT NOT NULL REFERENCES pricing_levels(id),
          kind           TEXT NOT NULL CHECK (kind IN ('employee', 'freelancer', 'agency')),
          currency       TEXT NOT NULL REFERENCES pricing_currencies(code),
          min_minor      INTEGER NOT NULL CHECK (min_minor > 0),
          median_minor   INTEGER NOT NULL CHECK (median_minor >= min_minor),
          max_minor      INTEGER NOT NULL CHECK (max_minor >= median_minor),
          source         TEXT NOT NULL CHECK (length(source) >= 8),
          source_url     TEXT NOT NULL DEFAULT '',
          effective_date TEXT NOT NULL,
          entered_by     TEXT NOT NULL DEFAULT '',
          entered_at     TEXT NOT NULL,
          enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          illustrative   INTEGER NOT NULL DEFAULT 0 CHECK (illustrative IN (0, 1)),
          note           TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX country_market_rates_lookup ON country_market_rates(country, role_id, level_id, kind, effective_date);
        CREATE TRIGGER country_market_rates_no_edit BEFORE UPDATE ON country_market_rates
          WHEN NEW.country != OLD.country OR NEW.role_id != OLD.role_id OR NEW.level_id != OLD.level_id OR NEW.kind != OLD.kind OR NEW.currency != OLD.currency
            OR NEW.min_minor != OLD.min_minor OR NEW.median_minor != OLD.median_minor OR NEW.max_minor != OLD.max_minor OR NEW.source != OLD.source
            OR NEW.source_url != OLD.source_url OR NEW.effective_date != OLD.effective_date OR NEW.entered_by != OLD.entered_by OR NEW.entered_at != OLD.entered_at
            OR NEW.illustrative != OLD.illustrative
          BEGIN SELECT RAISE(ABORT, 'a market rate cannot be edited: add a new one with a later start date'); END;
        CREATE TRIGGER country_market_rates_no_delete BEFORE DELETE ON country_market_rates BEGIN SELECT RAISE(ABORT, 'market rates are kept as history'); END;

        CREATE TABLE pricing_configurations (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          updated_by TEXT NOT NULL DEFAULT ''
        );
      `);
      const at = new Date().toISOString();
      const cur = db.prepare("INSERT INTO pricing_currencies (code, name, symbol, minor_digits) VALUES (?, ?, ?, ?)");
      for (const c of CURRENCIES) cur.run(c.code, c.name, c.symbol, minorDigits(c.code));
      const country = db.prepare("INSERT INTO pricing_countries (code, name, currency, sort_order) VALUES (?, ?, ?, ?)");
      COUNTRIES.forEach((c, i) => country.run(c.code, c.name, c.currency, i + 1));
      const role = db.prepare("INSERT INTO pricing_roles (id, label, sort_order) VALUES (?, ?, ?)");
      [["any", "Any software role"], ["frontend", "Frontend Developer"], ["backend", "Backend Developer"], ["full-stack", "Full Stack Developer"], ["react-next", "React / Next.js Developer"], ["nodejs", "Node.js Developer"], ["php-laravel", "PHP / Laravel Developer"], ["python", "Python Developer"], ["mobile", "Mobile Developer"], ["ui-ux", "UI/UX Designer"], ["qa", "QA Engineer"], ["devops", "DevOps Engineer"], ["ai-engineer", "AI Engineer"], ["architect", "Software Architect"], ["project-manager", "Project Manager"]].forEach(([id, label], i) => role.run(id!, label!, i));
      const level = db.prepare("INSERT INTO pricing_levels (id, label, sort_order) VALUES (?, ?, ?)");
      [["junior", "Junior"], ["mid", "Mid-level"], ["senior", "Senior"], ["expert", "Expert"]].forEach(([id, label], i) => level.run(id!, label!, i));
      // The ONLY figures supplied with the pricing brief: illustrative yearly salaries for India, as employee wages. They are an assumption, not a market
      // rate, and are labelled so everywhere they are used. No other rate is loaded: the rest must be entered with a source.
      const rate = db.prepare(
        "INSERT INTO country_market_rates (country, role_id, level_id, kind, currency, min_minor, median_minor, max_minor, source, source_url, effective_date, entered_by, entered_at, enabled, illustrative, note) VALUES ('IN', 'any', ?, 'employee', 'INR', ?, ?, ?, ?, '', ?, 'system', ?, 1, 1, ?)",
      );
      for (const [levelId, annualRupees] of [["junior", 600_000], ["mid", 1_500_000], ["senior", 3_000_000]] as const) {
        const hourly = hourlyFromAnnual(annualRupees * 100, 2080);
        rate.run(levelId, hourly, hourly, hourly, "Illustrative assumption from the SILPI AI pricing brief (yearly salary / 2,080 hours). Not a market rate.", at.slice(0, 10), at, `Yearly salary assumed: Rs ${annualRupees.toLocaleString("en-IN")}`);
      }
      db.prepare("INSERT INTO pricing_configurations (key, value, updated_at, updated_by) VALUES ('global', ?, ?, 'system')").run(JSON.stringify(DEFAULT_PRICING_CONFIG), at);
    },
  },
];

function assertValid(list: readonly Migration[]): void {
  let last = 0;
  for (const m of list) {
    if (!Number.isInteger(m.id) || m.id <= last) throw new Error(`Migration ids must be whole numbers in strictly increasing order (found ${m.id} after ${last}).`);
    last = m.id;
  }
}

/**
 * Applies every migration not yet recorded. Returns the ids applied (empty when up to date).
 * `beforeApply` is called once, only when something is pending, before the first change. A failure there stops everything.
 */
export function runMigrations(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS, beforeApply?: (pendingIds: number[]) => void): number[] {
  assertValid(migrations);
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const done = new Set((db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[]).map((r) => r.id));
  const pending = migrations.filter((m) => !done.has(m.id));
  if (pending.length === 0) return [];
  beforeApply?.(pending.map((m) => m.id));
  const applied: number[] = [];
  for (const m of pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      m.up(db);
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(m.id, m.name, new Date().toISOString());
      db.exec("COMMIT");
      applied.push(m.id);
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${m.id} (${m.name}) failed and was rolled back: ${(error as Error).message}`);
    }
  }
  return applied;
}

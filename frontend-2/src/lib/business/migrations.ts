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

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

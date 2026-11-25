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

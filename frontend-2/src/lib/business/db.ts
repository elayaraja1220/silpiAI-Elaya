import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * SQLite database (Node's built-in driver, nothing to install).
 * Lives in frontend-2/storage/ (git-ignored) unless SILPI_DB_PATH is set.
 * Server-only: import from API routes, never from client components.
 */

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS leads (
  id          TEXT PRIMARY KEY,
  stage       TEXT NOT NULL,
  client      TEXT NOT NULL,
  requirement TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quotations (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  number     TEXT NOT NULL UNIQUE,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS quotations_lead ON quotations(lead_id, created_at);

CREATE TABLE IF NOT EXISTS stage_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id    TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage   TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id          TEXT PRIMARY KEY,
  lead_id     TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  amount      REAL NOT NULL,
  mode        TEXT NOT NULL,
  reference   TEXT NOT NULL DEFAULT '',
  received_on TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_lead ON payments(lead_id, recorded_at);

CREATE TABLE IF NOT EXISTS work_log (
  id          TEXT PRIMARY KEY,
  lead_id     TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  item        TEXT NOT NULL,
  hours       REAL NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  logged_on   TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_log_lead ON work_log(lead_id, logged_on);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Reuse one connection across Next.js hot reloads in development.
// The schema applied is remembered too, so a code change that adds a table
// is applied to the open connection instead of failing with "no such table".
const globalForDb = globalThis as unknown as { silpiDb?: DatabaseSync; silpiSchema?: string };

function applySchema(db: DatabaseSync): void {
  db.exec(SCHEMA);
  migrate(db);
  globalForDb.silpiSchema = SCHEMA + migrate.toString();
}

export function getDb(): DatabaseSync {
  const cached = globalForDb.silpiDb;
  if (cached) {
    if (globalForDb.silpiSchema !== SCHEMA + migrate.toString()) applySchema(cached);
    return cached;
  }
  const file = path.resolve(process.env.SILPI_DB_PATH || path.join(process.cwd(), "storage", "silpi.db"));
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  applySchema(db);
  globalForDb.silpiDb = db;
  return db;
}

/** Adds columns introduced after the first release. */
function migrate(db: DatabaseSync): void {
  const columns = (db.prepare("PRAGMA table_info(leads)").all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes("share_token")) db.exec("ALTER TABLE leads ADD COLUMN share_token TEXT");
  if (!columns.includes("client_response")) db.exec("ALTER TABLE leads ADD COLUMN client_response TEXT");
  if (!columns.includes("project_name")) db.exec("ALTER TABLE leads ADD COLUMN project_name TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS leads_share_token ON leads(share_token)");
}

/** Runs fn inside a transaction; rolls back if it throws. */
export function transaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MIGRATIONS, runMigrations } from "./migrations";

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

CREATE TABLE IF NOT EXISTS exec_jobs (
  id                 TEXT PRIMARY KEY,
  lead_id            TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  project_name       TEXT NOT NULL,
  state              TEXT NOT NULL,
  mode               TEXT,
  phase              TEXT,
  scope_confirmed_at TEXT NOT NULL,
  brief_sha          TEXT NOT NULL,
  brief_bytes        INTEGER NOT NULL,
  restart_of         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  started_at         TEXT,
  finished_at        TEXT,
  exit_code          INTEGER,
  error              TEXT,
  approval           TEXT,
  cost               TEXT,
  result             TEXT,
  verification       TEXT,
  review             TEXT
);
CREATE INDEX IF NOT EXISTS exec_jobs_lead ON exec_jobs(lead_id, created_at);

CREATE TABLE IF NOT EXISTS exec_events (
  job_id TEXT NOT NULL REFERENCES exec_jobs(id) ON DELETE CASCADE,
  seq    INTEGER NOT NULL,
  at     TEXT NOT NULL,
  kind   TEXT NOT NULL,
  text   TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);

-- Running services (domain, hosting, maintenance...) per lead: the admin's arrangements. Internal; the client only
-- ever sees what publicRunningServices() builds from them. Absent row = nothing configured (the default).
CREATE TABLE IF NOT EXISTS running_services (
  lead_id    TEXT PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Originals collected from the client after approval (logos, images, page content). Files live on disk under
-- storage/client-assets/<lead id>/; only their names and metadata are kept here.
CREATE TABLE IF NOT EXISTS client_assets (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  position   INTEGER NOT NULL,
  group_name TEXT NOT NULL,
  label      TEXT NOT NULL,
  hint       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  required   INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  text       TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE (lead_id, key)
);
CREATE INDEX IF NOT EXISTS client_assets_lead ON client_assets(lead_id, position);

CREATE TABLE IF NOT EXISTS asset_files (
  id          TEXT PRIMARY KEY,
  asset_id    TEXT NOT NULL REFERENCES client_assets(id) ON DELETE CASCADE,
  lead_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  stored      TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL,
  uploaded_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS asset_files_asset ON asset_files(asset_id);

-- Private demo previews of a generated website, shown to a client through a secret link (see src/lib/demo). The copy of the
-- site lives on disk under storage/demos/<id>/; nothing here is ever sent to the client except the link.
CREATE TABLE IF NOT EXISTS demo_links (
  id             TEXT PRIMARY KEY,
  lead_id        TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  token          TEXT NOT NULL UNIQUE,
  label          TEXT NOT NULL,
  mode           TEXT NOT NULL,
  framework      TEXT NOT NULL DEFAULT '',
  project_name   TEXT NOT NULL,
  spa            INTEGER NOT NULL DEFAULT 0,
  app_dir        TEXT NOT NULL DEFAULT '',
  start_command  TEXT NOT NULL DEFAULT '',
  password_hash  TEXT NOT NULL DEFAULT '',
  show_to_client INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  revoked_at     TEXT,
  views          INTEGER NOT NULL DEFAULT 0,
  last_view_at   TEXT,
  report         TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS demo_links_lead ON demo_links(lead_id, created_at);

-- A document analysed before: the same documents and notes always give the same draft (and so the same estimate).
CREATE TABLE IF NOT EXISTS analysis_cache (
  key        TEXT PRIMARY KEY,
  draft      TEXT NOT NULL,
  model      TEXT NOT NULL DEFAULT '',
  cost_usd   REAL NOT NULL DEFAULT 0,
  runs       INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- The chat between the client (on their quotation link) and the team. "read" means the other side has seen the message.
CREATE TABLE IF NOT EXISTS chat_messages (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  sender  TEXT NOT NULL,
  name    TEXT NOT NULL DEFAULT '',
  text    TEXT NOT NULL,
  at      TEXT NOT NULL,
  read    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chat_lead ON chat_messages(lead_id, id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Reuse one connection across Next.js hot reloads in development.
// The schema applied is remembered too, so a code change that adds a table
// is applied to the open connection instead of failing with "no such table".
const globalForDb = globalThis as unknown as { silpiDb?: DatabaseSync; silpiSchema?: string };

const schemaSignature = () => SCHEMA + migrate.toString() + MIGRATIONS.map((m) => m.id).join(",");

/** The file behind this connection, asked of the connection itself ("" for an in-memory database). */
function fileOf(db: DatabaseSync): string {
  const main = (db.prepare("PRAGMA database_list").all() as { name: string; file: string }[]).find((d) => d.name === "main");
  return main?.file ?? "";
}

/**
 * Before the first pending migration changes a database that holds data, keep a consistent copy beside it
 * (VACUUM INTO works with WAL). The path is read from the connection, not remembered: a connection opened by older
 * code during a dev-server hot reload must be protected too. If the copy cannot be made, the error stops the migration.
 */
function backupBeforeMigrating(db: DatabaseSync, pendingIds: number[]): void {
  const file = fileOf(db);
  if (!file || !existsSync(file)) return;
  const hasData = db.prepare("SELECT 1 FROM leads LIMIT 1").get();
  if (!hasData) return;
  const dir = path.join(path.dirname(file), "backups");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  db.exec(`VACUUM INTO '${path.join(dir, `silpi-before-migration-${pendingIds[0]}-${stamp}.db`).replace(/'/g, "''")}'`);
}

function applySchema(db: DatabaseSync): void {
  db.exec(SCHEMA);
  migrate(db);
  runMigrations(db, MIGRATIONS, (ids) => backupBeforeMigrating(db, ids));
  globalForDb.silpiSchema = schemaSignature();
}

export function getDb(): DatabaseSync {
  const cached = globalForDb.silpiDb;
  if (cached) {
    if (globalForDb.silpiSchema !== schemaSignature()) applySchema(cached);
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

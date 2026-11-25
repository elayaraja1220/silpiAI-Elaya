#!/usr/bin/env node
/**
 * A safe copy of the database while the site is running: `npm run backup`.
 *
 * It uses SQLite's own VACUUM INTO, which makes a consistent copy even though the server is writing (copying the .db file by hand can catch it half-written).
 * The copy goes to a "backups" folder beside the database, named by the time, and is checked by opening it and counting its tables. It never overwrites an
 * existing file and never touches the original. Old copies are not deleted. Copy the file somewhere ELSE too (another machine or storage): a backup on the
 * same disk does not survive the disk.
 *
 * Which database: SILPI_DB_PATH if set, otherwise storage/silpi.db under the folder you run it from (the same rule the server uses).
 */
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const source = path.resolve(process.env.SILPI_DB_PATH || path.join(process.cwd(), "storage", "silpi.db"));
if (!fs.existsSync(source)) {
  console.error(`No database at ${source}. Run this from the frontend-2 folder, or set SILPI_DB_PATH.`);
  process.exit(1);
}
const dir = path.join(path.dirname(source), "backups");
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = path.join(dir, `silpi-manual-${stamp}.db`);
if (fs.existsSync(target)) {
  console.error(`${target} already exists; not overwriting it.`);
  process.exit(1);
}

const db = new DatabaseSync(source, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} finally {
  db.close();
}
const copy = new DatabaseSync(target, { readOnly: true });
try {
  const tables = copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
  const check = copy.prepare("PRAGMA integrity_check").get().integrity_check;
  if (check !== "ok" || tables === 0) throw new Error(`The copy did not check out (integrity: ${check}, tables: ${tables}).`);
  console.log(`Backup written: ${target}\n  ${tables} tables, integrity ok, ${(fs.statSync(target).size / 1024).toFixed(0)} KB.\nNow copy it to another machine or storage.`);
} finally {
  copy.close();
}

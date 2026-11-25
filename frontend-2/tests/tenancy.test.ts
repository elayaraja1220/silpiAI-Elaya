// Phase 1: versioned migrations, the tenant tables, passwords and tenant-scoped lead access.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";

import { AGENCY_ORG_ID, MIGRATIONS, runMigrations, type Migration } from "@/lib/business/migrations";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import { parseRequirement } from "@/lib/business/validate";

// The old leads table, exactly as it was before any tenancy column existed.
const LEGACY_LEADS = `CREATE TABLE leads (id TEXT PRIMARY KEY, stage TEXT NOT NULL, client TEXT NOT NULL, requirement TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;
const tableNames = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
const noop = (name: string, id: number): Migration => ({ id, name, up: (db) => db.exec(`CREATE TABLE ${name} (x INTEGER)`) });

// =================================================================================================
describe("1. the migration runner", () => {
  it("applies pending migrations once, in order, and records them", () => {
    const db = new DatabaseSync(":memory:");
    assert.deepEqual(runMigrations(db, [noop("a", 1), noop("b", 2)]), [1, 2]);
    assert.deepEqual(runMigrations(db, [noop("a", 1), noop("b", 2)]), [], "a second run does nothing");
    assert.deepEqual((db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[]).map((r) => r.id), [1, 2]);
    assert.deepEqual(runMigrations(db, [noop("a", 1), noop("b", 2), noop("c", 3)]), [3], "only the new one runs");
  });
  it("a failing migration is rolled back completely and stops everything after it", () => {
    const db = new DatabaseSync(":memory:");
    const bad: Migration = { id: 2, name: "bad", up: (d) => { d.exec("CREATE TABLE half_done (x INTEGER)"); throw new Error("boom"); } };
    assert.throws(() => runMigrations(db, [noop("a", 1), bad, noop("c", 3)]), /Migration 2 \(bad\) failed and was rolled back: boom/);
    const tables = tableNames(db);
    assert.ok(tables.includes("a"), "the earlier migration stays applied");
    assert.ok(!tables.includes("half_done"), "the failed one left nothing behind");
    assert.ok(!tables.includes("c"), "nothing after it ran");
    assert.deepEqual((db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[]).map((r) => r.id), [1]);
  });
  it("calls beforeApply once, only when something is pending, before any change", () => {
    const db = new DatabaseSync(":memory:");
    const calls: number[][] = [];
    runMigrations(db, [noop("a", 1)], (ids) => { calls.push(ids); assert.ok(!tableNames(db).includes("a"), "nothing applied yet"); });
    runMigrations(db, [noop("a", 1)], (ids) => calls.push(ids));
    assert.deepEqual(calls, [[1]]);
  });
  it("a failing backup step stops the migration before it changes anything", () => {
    const db = new DatabaseSync(":memory:");
    assert.throws(() => runMigrations(db, [noop("a", 1)], () => { throw new Error("disk full"); }), /disk full/);
    assert.ok(!tableNames(db).includes("a"));
  });
  it("rejects ids that are duplicated, out of order or not whole numbers", () => {
    const db = new DatabaseSync(":memory:");
    for (const list of [[noop("a", 1), noop("b", 1)], [noop("a", 2), noop("b", 1)], [noop("a", 0)], [noop("a", 1.5)]]) assert.throws(() => runMigrations(db, list), /strictly increasing/);
  });
});

// =================================================================================================
describe("2. migration 1 on an existing database", () => {
  it("keeps every lead, puts them in the SILPI Agency organization, and sends new leads there too", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(LEGACY_LEADS);
    const insert = db.prepare("INSERT INTO leads (id, stage, client, requirement, created_at, updated_at) VALUES (?, 'quoted', '{\"name\":\"A\"}', '{}', 't', 't')");
    insert.run("old-1");
    insert.run("old-2");
    assert.deepEqual(runMigrations(db), MIGRATIONS.map((m) => m.id));
    const rows = db.prepare("SELECT id, stage, client, org_id FROM leads ORDER BY id").all() as { id: string; stage: string; client: string; org_id: string }[];
    assert.deepEqual(rows.map((r) => [r.id, r.stage, r.client, r.org_id]), [["old-1", "quoted", '{"name":"A"}', AGENCY_ORG_ID], ["old-2", "quoted", '{"name":"A"}', AGENCY_ORG_ID]]);
    insert.run("new-1");
    assert.equal((db.prepare("SELECT org_id FROM leads WHERE id = 'new-1'").get() as { org_id: string }).org_id, AGENCY_ORG_ID, "the trigger keeps new leads in the agency");
    assert.deepEqual(db.prepare("SELECT id, name, type, status FROM organizations").all().map((r) => ({ ...r })), [{ id: AGENCY_ORG_ID, name: "SILPI Agency", type: "internal", status: "active" }]);
  });
  it("the database itself refuses a bad organization type, role or status", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(LEGACY_LEADS);
    runMigrations(db);
    assert.throws(() => db.prepare("INSERT INTO organizations (id, name, type, status, created_at) VALUES ('o', 'X', 'galaxy', 'active', 't')").run(), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO organizations (id, name, type, status, created_at) VALUES ('o', 'X', 'agency', 'deleted', 't')").run(), /CHECK/);
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u', 'a@b.co', 'A', 'h', 't')").run();
    assert.throws(() => db.prepare("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, 'u', 'emperor', 't')").run(AGENCY_ORG_ID), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u2', 'A@B.CO', 'A', 'h', 't')").run(), /UNIQUE/, "emails are unique regardless of case");
  });
});

// =================================================================================================
describe("3. through the real database: backup before migrating, then tenant isolation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "silpi-tenancy-"));
  const file = path.join(dir, "legacy.db");
  let legacyLeadId = "legacy-lead";

  before(() => {
    // A database from before tenancy: the original leads table with one real-looking row.
    const legacy = new DatabaseSync(file);
    legacy.exec(LEGACY_LEADS);
    legacy.prepare("INSERT INTO leads (id, stage, client, requirement, created_at, updated_at) VALUES (?, 'requirement', ?, ?, 't', 't')").run(
      legacyLeadId,
      JSON.stringify({ name: "Old client", email: "o@example.com", phone: "1", company: "", gstin: "", state: "Tamil Nadu", address: "" }),
      "{}",
    );
    legacy.close();
    process.env.SILPI_DB_PATH = file;
  });
  after(() => {
    const cached = globalThis as unknown as { silpiDb?: { close(): void } };
    cached.silpiDb?.close();
    delete cached.silpiDb;
    rmSync(dir, { recursive: true, force: true });
  });

  it("copies the old database to storage/backups before the first migration changes it", async () => {
    const { getDb } = await import("@/lib/business/db");
    const db = getDb();
    const backups = readdirSync(path.join(dir, "backups"));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^silpi-before-migration-1-.*\.db$/);
    const copy = new DatabaseSync(path.join(dir, "backups", backups[0]), { readOnly: true });
    const cols = (copy.prepare("PRAGMA table_info(leads)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(!cols.includes("org_id"), "the backup is the state BEFORE the migration");
    assert.equal((copy.prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number }).n, 1);
    copy.close();
    assert.equal((db.prepare("SELECT org_id FROM leads WHERE id = ?").get(legacyLeadId) as { org_id: string }).org_id, AGENCY_ORG_ID);
    assert.ok(existsSync(file));
  });

  it("a connection opened by older code (dev-server hot reload) is backed up too", async () => {
    // The exact situation that once skipped the backup: an already-open connection that this code did not open.
    const { getDb } = await import("@/lib/business/db");
    getDb().close();
    const reloadDir = mkdtempSync(path.join(tmpdir(), "silpi-reload-"));
    try {
      const reloadFile = path.join(reloadDir, "old.db");
      const old = new DatabaseSync(reloadFile);
      old.exec(LEGACY_LEADS);
      old.prepare("INSERT INTO leads (id, stage, client, requirement, created_at, updated_at) VALUES ('x', 'requirement', '{}', '{}', 't', 't')").run();
      const g = globalThis as unknown as { silpiDb?: DatabaseSync; silpiSchema?: string };
      g.silpiDb = old; // opened elsewhere: this module never saw its path
      g.silpiSchema = "an older code version";
      getDb();
      const made = readdirSync(path.join(reloadDir, "backups"));
      assert.equal(made.length, 1, "the backup was made");
      const copy = new DatabaseSync(path.join(reloadDir, "backups", made[0]), { readOnly: true });
      assert.ok(!(copy.prepare("PRAGMA table_info(leads)").all() as { name: string }[]).some((c) => c.name === "org_id"), "and it is the state before the migration");
      copy.close();
      old.close();
    } finally {
      delete (globalThis as unknown as { silpiDb?: unknown }).silpiDb;
      rmSync(reloadDir, { recursive: true, force: true });
    }
    // Reopen the main test database for the tests that follow.
    const { getDb: reopen } = await import("@/lib/business/db");
    assert.ok(reopen());
  });

  it("does not back up again when nothing is pending", async () => {
    const { getDb } = await import("@/lib/business/db");
    getDb();
    assert.equal(readdirSync(path.join(dir, "backups")).length, 1);
  });

  const client = { name: "Test", email: "t@example.com", phone: "9876543210", company: "", gstin: "", state: "Tamil Nadu", address: "" };
  const newLead = async (orgId: string) => {
    const store = await import("@/lib/business/store");
    const { getDb } = await import("@/lib/business/db");
    const requirement = parseRequirement(
      { title: "Site", summary: "Two page responsive informational website built with HTML, CSS and JavaScript.", scope: "full", existingProject: "", version: "", projectType: "business-website", complexity: "basic", pages: ["Home", "Contact Us"], modules: [], design: "ai", references: "", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 }, hosting: { needed: false, choice: "self", plan: "static", years: 1 }, deadlineWeeks: 0, budget: 0 },
      DEFAULT_RATE_CARD,
    );
    const lead = store.createLead(client, requirement, "basic");
    getDb().prepare("UPDATE leads SET org_id = ? WHERE id = ?").run(orgId, lead.id); // until lead creation takes an organization
    return lead.id;
  };

  it("a lead is visible only through the organization that owns it", async () => {
    const t = await import("@/server/tenancy");
    const a = t.createOrganization({ name: "Studio A", type: "agency" });
    const b = t.createOrganization({ name: "Freelancer B", type: "freelancer" });
    const idA = await newLead(a.id);
    const idB = await newLead(b.id);

    assert.equal(t.getLeadForOrg(a.id, idA)?.id, idA);
    assert.equal(t.getLeadForOrg(b.id, idA), null, "B cannot open A's lead by its id");
    assert.equal(t.getLeadForOrg(a.id, idB), null, "A cannot open B's lead by its id");
    assert.equal(t.getLeadForOrg(AGENCY_ORG_ID, idA), null, "not even the SILPI agency can through this path");
    assert.equal(t.getLeadForOrg(a.id, "does-not-exist"), null);

    assert.deepEqual(t.listLeadsForOrg(a.id).map((l) => l.id), [idA]);
    assert.deepEqual(t.listLeadsForOrg(b.id).map((l) => l.id), [idB]);
    const agency = t.listLeadsForOrg(AGENCY_ORG_ID).map((l) => l.id);
    assert.ok(agency.includes(legacyLeadId) && !agency.includes(idA) && !agency.includes(idB), "the agency list holds only agency leads");
    assert.deepEqual(t.listLeadsForOrg("org_nobody"), []);
  });

  it("customers can never be created as the internal organization", async () => {
    const t = await import("@/server/tenancy");
    assert.throws(() => t.createOrganization({ name: "Fake", type: "internal" }), /internal organization cannot be created/);
    assert.throws(() => t.createOrganization({ name: "  ", type: "agency" }), /name is required/);
    assert.throws(() => t.createOrganization({ name: "X", type: "galaxy" as never }), /type must be one of/);
  });

  it("roles: a member holds a role only in their own organization, and only while both are active", async () => {
    const t = await import("@/server/tenancy");
    const { getDb } = await import("@/lib/business/db");
    const org = t.createOrganization({ name: "Roles Co", type: "business" });
    const other = t.createOrganization({ name: "Other Co", type: "business" });
    const user = await t.createUser({ email: "roles@example.com", name: "Roles", password: "a-long-password" });
    t.addMember(org.id, user.id, "member");
    assert.equal(t.roleOf(org.id, user.id), "member");
    assert.equal(t.roleOf(other.id, user.id), null, "no role in an organization they do not belong to");
    assert.throws(() => t.addMember(org.id, user.id, "admin"), /already a member/);
    assert.throws(() => t.addMember(org.id, "usr_missing", "viewer"), /does not exist/);
    assert.throws(() => t.addMember("org_missing", user.id, "viewer"), /organization does not exist/);
    assert.throws(() => t.addMember(org.id, user.id, "emperor" as never), /role must be one of/);
    assert.deepEqual(t.organizationsOf(user.id).map((x) => [x.org.id, x.role]), [[org.id, "member"]]);

    getDb().prepare("UPDATE organizations SET status = 'suspended' WHERE id = ?").run(org.id);
    assert.equal(t.roleOf(org.id, user.id), null, "a suspended organization grants nothing");
    assert.deepEqual(t.organizationsOf(user.id), []);
    getDb().prepare("UPDATE organizations SET status = 'active' WHERE id = ?").run(org.id);
    getDb().prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(user.id);
    assert.equal(t.roleOf(org.id, user.id), null, "a disabled user holds nothing");
  });

  it("the permission table: viewers read, members also write, only owners and admins manage people and billing", async () => {
    const { can } = await import("@/server/tenancy");
    const table = { viewer: [1, 0, 0, 0], member: [1, 1, 0, 0], admin: [1, 1, 1, 1], owner: [1, 1, 1, 1] } as const;
    const perms = ["lead:read", "lead:write", "members:manage", "billing:manage"] as const;
    for (const [role, expected] of Object.entries(table)) perms.forEach((p, i) => assert.equal(can(role as never, p), expected[i] === 1, `${role} ${p}`));
    assert.equal(can(null, "lead:read"), false);
    assert.equal(can(undefined, "lead:read"), false);
    assert.equal(can("hacker" as never, "lead:read"), false, "an unknown role can do nothing");
  });
});

// =================================================================================================
describe("4. passwords and sign-in", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "silpi-auth-"));
  before(() => { process.env.SILPI_DB_PATH = path.join(dir, "auth.db"); });
  after(() => {
    const cached = globalThis as unknown as { silpiDb?: { close(): void } };
    cached.silpiDb?.close();
    delete cached.silpiDb;
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores a salted scrypt hash, never the password", async () => {
    const t = await import("@/server/tenancy");
    const { getDb } = await import("@/lib/business/db");
    await t.createUser({ email: "Mixed.Case@Example.com", name: "Mixed", password: "correct horse battery" });
    const row = getDb().prepare("SELECT email, password_hash FROM users").get() as { email: string; password_hash: string };
    assert.equal(row.email, "mixed.case@example.com");
    assert.match(row.password_hash, /^scrypt\$[\w-]+\$[\w-]+$/);
    assert.ok(!row.password_hash.includes("correct horse battery"));
    const again = await t.hashPassword("correct horse battery");
    assert.notEqual(again, row.password_hash, "a fresh salt each time");
  });

  it("signs in with the right password (email case does not matter) and refuses everything else the same way", async () => {
    const t = await import("@/server/tenancy");
    const ok = await t.authenticate("MIXED.case@example.com", "correct horse battery");
    assert.equal(ok?.email, "mixed.case@example.com");
    assert.ok(!("hash" in ok!) && !("password_hash" in ok!), "no hash leaves this function");
    assert.equal(await t.authenticate("mixed.case@example.com", "wrong password here"), null);
    assert.equal(await t.authenticate("nobody@example.com", "correct horse battery"), null);
    assert.equal(await t.authenticate("", ""), null);
  });

  it("a disabled account cannot sign in even with the right password", async () => {
    const t = await import("@/server/tenancy");
    const { getDb } = await import("@/lib/business/db");
    getDb().prepare("UPDATE users SET status = 'disabled' WHERE email = ?").run("mixed.case@example.com");
    assert.equal(await t.authenticate("mixed.case@example.com", "correct horse battery"), null);
  });

  it("validates new users: email, name, password length, duplicates", async () => {
    const t = await import("@/server/tenancy");
    await assert.rejects(t.createUser({ email: "not-an-email", name: "X", password: "long enough pw" }), /valid email/);
    await assert.rejects(t.createUser({ email: "a@b.co", name: " ", password: "long enough pw" }), /name is required/);
    await assert.rejects(t.createUser({ email: "a@b.co", name: "X", password: "short" }), /at least 10/);
    await assert.rejects(t.createUser({ email: "MIXED.CASE@example.com", name: "Dup", password: "long enough pw" }), /already registered/);
  });

  it("verifyPassword rejects a malformed stored value instead of throwing", async () => {
    const { verifyPassword } = await import("@/server/tenancy");
    for (const stored of ["", "plain", "bcrypt$a$b", "scrypt$$", "scrypt$only"]) assert.equal(await verifyPassword("whatever-password", stored), false, stored);
  });
});

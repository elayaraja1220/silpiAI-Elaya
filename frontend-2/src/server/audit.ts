import type { DatabaseSync } from "node:sqlite";

import type { NextRequest } from "next/server";

import { adminActor } from "@/lib/admin-auth";
import { getDb } from "@/lib/business/db";

/**
 * The audit trail: who changed money, prices, plans, credits or access, and when. Append-only (the database refuses updates and deletes).
 * Entries carry the facts of the change, never a secret: keys that look like passwords, tokens or secrets are dropped, and long text is cut.
 * The administrator is recorded as "admin" (one shared token, so individual administrators cannot be told apart yet).
 */
export type AuditInput = { actor: string; action: string; entityType: string; entityId?: string | number | null; orgId?: string | null; detail?: Record<string, unknown> };
export type AuditEntry = { id: number; at: string; actor: string; action: string; entityType: string; entityId: string; orgId: string | null; detail: Record<string, unknown> };

const SECRET_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key/i;
const MAX_DETAIL = 2000;

function clean(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 300 ? `${value.slice(0, 300)}...` : value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 3) return "...";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => clean(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) out[k] = SECRET_KEY.test(k) ? "[hidden]" : clean(v, depth + 1);
    return out;
  }
  return undefined;
}

/** Writes one entry inside the caller's transaction, so the change and its record stand or fall together. */
export function recordAuditIn(db: DatabaseSync, e: AuditInput, at = new Date().toISOString()): void {
  let detail = JSON.stringify(clean(e.detail ?? {}));
  if (detail.length > MAX_DETAIL) detail = JSON.stringify({ truncated: true, text: detail.slice(0, MAX_DETAIL - 40) });
  db.prepare("INSERT INTO audit_logs (at, actor, action, entity_type, entity_id, org_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(at, String(e.actor).slice(0, 80), String(e.action).slice(0, 80), String(e.entityType).slice(0, 60), String(e.entityId ?? "").slice(0, 120), e.orgId ?? null, detail);
}
export const recordAudit = (e: AuditInput): void => recordAuditIn(getDb(), e);

/** What the administrator did, from an admin route, after it succeeded. */
export const auditAdmin = (request: NextRequest, action: string, entityType: string, entityId: string | number | null | undefined, detail?: Record<string, unknown>, orgId?: string | null): void =>
  recordAudit({ actor: adminActor(request), action, entityType, entityId, orgId: orgId ?? null, detail });

type Row = { id: number; at: string; actor: string; action: string; entity_type: string; entity_id: string; org_id: string | null; detail: string };
/** Newest first. `action` matches a prefix ("payment." finds every payment event). */
export function listAudit(opts: { limit?: number; before?: number; action?: string; orgId?: string; actor?: string } = {}): AuditEntry[] {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 500);
  const where: string[] = ["id < ?"];
  const args: (string | number)[] = [opts.before ?? Number.MAX_SAFE_INTEGER];
  if (opts.action) { where.push("action LIKE ? ESCAPE '\\'"); args.push(`${opts.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
  if (opts.orgId) { where.push("org_id = ?"); args.push(opts.orgId); }
  if (opts.actor) { where.push("actor = ?"); args.push(opts.actor); }
  const rows = getDb().prepare(`SELECT * FROM audit_logs WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...args, limit) as Row[];
  return rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, action: r.action, entityType: r.entity_type, entityId: r.entity_id, orgId: r.org_id, detail: JSON.parse(r.detail) as Record<string, unknown> }));
}

import { NextRequest } from "next/server";

import { auditAdmin } from "@/server/audit";
import { requireAdmin } from "@/lib/admin-auth";
import { getDb } from "@/lib/business/db";
import { MEMBER_ROLES, ORG_TYPES } from "@/lib/business/migrations";
import { handle } from "@/lib/business/http";
import { ValidationError } from "@/lib/business/validate";
import { startSubscription } from "@/server/subscriptions";
import { addMember, createOrganization, createUser, getOrganization, type OrgType, type Role } from "@/server/tenancy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/users - every user with their organizations and roles. Admin only. Never returns a password hash. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return handle("USERS LIST", () => ({
    users: getDb()
      .prepare(
        `SELECT u.id, u.email, u.name, u.status, u.created_at AS createdAt, u.last_login_at AS lastLoginAt,
                m.org_id AS orgId, o.name AS orgName, m.role AS role
           FROM users u LEFT JOIN memberships m ON m.user_id = u.id LEFT JOIN organizations o ON o.id = m.org_id
          ORDER BY u.created_at`,
      )
      .all(),
  }));
}

/**
 * POST /api/admin/users - invite-only for now: the administrator creates an account.
 * { email, name, password, role?, orgId }  -> member of an existing organization (the agency included), or
 * { email, name, password, newOrg: { name, type } } -> becomes the owner of a new organization (never "internal").
 */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return handle("USERS CREATE", async () => {
    const b = (await request.json()) as { email?: string; name?: string; password?: string; role?: string; orgId?: string; newOrg?: { name?: string; type?: string } };
    if (!b.orgId === !b.newOrg) throw new ValidationError("Give exactly one of orgId (join an organization) or newOrg (create one).");
    if (b.orgId && !getOrganization(b.orgId)) throw new ValidationError("That organization does not exist.");
    if (b.newOrg) {
      // Everything about the organization is checked BEFORE the user is created, so a bad request never leaves a user behind.
      if (!(ORG_TYPES as readonly string[]).includes(String(b.newOrg.type)) || b.newOrg.type === "internal") throw new ValidationError(`newOrg.type must be one of: ${ORG_TYPES.filter((t) => t !== "internal").join(", ")}.`);
      if (!String(b.newOrg.name ?? "").trim() || String(b.newOrg.name).trim().length > 120) throw new ValidationError("newOrg.name is required (up to 120 characters).");
    }
    const role = (b.newOrg ? "owner" : b.role ?? "member") as Role;
    if (!(MEMBER_ROLES as readonly string[]).includes(role)) throw new ValidationError(`role must be one of: ${MEMBER_ROLES.join(", ")}.`);
    const user = await createUser({ email: String(b.email ?? ""), name: String(b.name ?? ""), password: String(b.password ?? "") });
    const org = b.newOrg ? createOrganization({ name: String(b.newOrg.name ?? ""), type: b.newOrg.type as OrgType }) : getOrganization(b.orgId!)!;
    addMember(org.id, user.id, role);
    if (b.newOrg) startSubscription({ orgId: org.id, planId: "free" }); // a new customer organization starts on the Free plan, with its credits
    auditAdmin(request, "user.created", "user", user.id, { email: user.email, role }, org.id);
    return { user, organization: { id: org.id, name: org.name, type: org.type }, role };
  });
}

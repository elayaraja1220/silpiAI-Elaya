import { NextRequest, NextResponse } from "next/server";

import { adminIdentity, requireAdmin } from "@/lib/admin-auth";
import { ValidationError } from "@/lib/business/validate";
import { createAdminAccount, listAdminAccounts, updateAdminAccount } from "@/server/admin-accounts";
import { auditAdmin } from "@/server/audit";
import { apiHandle } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Managing administrator accounts is for an administrator (the token or an account with the admin role), not for a read-only viewer. */
function gate(request: NextRequest): NextResponse | null {
  const denied = requireAdmin(request);
  if (denied) return denied;
  if (adminIdentity(request)?.role !== "admin") return NextResponse.json({ success: false, error: "Only an administrator can manage administrator accounts." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  return null;
}

/** GET /api/admin/admins - the named administrator accounts (never their passwords). */
export async function GET(request: NextRequest) {
  const denied = gate(request);
  if (denied) return denied;
  return apiHandle("ADMINS LIST", () => ({ accounts: listAdminAccounts() }));
}

/** POST /api/admin/admins - { email, name, password (12+ characters), role: "admin" | "viewer" }: creates an account. */
export async function POST(request: NextRequest) {
  const denied = gate(request);
  if (denied) return denied;
  return apiHandle("ADMINS CREATE", async () => {
    const b = (await request.json()) as { email?: unknown; name?: unknown; password?: unknown; role?: unknown };
    const account = await createAdminAccount({ email: b.email, name: b.name, password: b.password, role: b.role, createdBy: adminIdentity(request)!.actor });
    auditAdmin(request, "admin_account.created", "admin_account", account.id, { email: account.email, role: account.role });
    return { account };
  });
}

/** PUT /api/admin/admins - { id, name?, role?, status?, password? }: changes an account. The last active administrator cannot be demoted or disabled. */
export async function PUT(request: NextRequest) {
  const denied = gate(request);
  if (denied) return denied;
  return apiHandle("ADMINS UPDATE", async () => {
    const { id, ...patch } = (await request.json()) as { id?: unknown; name?: unknown; role?: unknown; status?: unknown; password?: unknown };
    if (typeof id !== "string") throw new ValidationError("id is required.");
    const account = await updateAdminAccount(id, patch);
    auditAdmin(request, "admin_account.updated", "admin_account", account.id, { email: account.email, role: account.role, status: account.status, passwordChanged: patch.password !== undefined, nameChanged: patch.name !== undefined });
    return { account };
  });
}

import { NextRequest } from "next/server";

import { adminActor, requireAdmin } from "@/lib/admin-auth";
import { ValidationError } from "@/lib/business/validate";
import { apiHandle } from "@/server/http";
import { addRole, listReference, requireReason, setActive } from "@/server/pricing-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT /api/admin/pricing/reference - { kind: country|currency|role|level, id, active, reason }: switches one on or off for new quotations. Nothing is deleted. Admin only. */
export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("PRICING REFERENCE SWITCH", async () => {
    const b = (await request.json()) as { kind?: unknown; id?: unknown; active?: unknown; reason?: unknown };
    if (!["country", "currency", "role", "level"].includes(String(b.kind)) || typeof b.id !== "string" || typeof b.active !== "boolean") throw new ValidationError("kind, id and active are required.");
    setActive(b.kind as "country", b.id, b.active, adminActor(request), requireReason(b.reason));
    return { reference: listReference({ includeInactive: true }) };
  });
}

/** POST /api/admin/pricing/reference - { id, label }: adds a developer role. Admin only. */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("PRICING ROLE ADD", async () => {
    addRole((await request.json()) as { id: unknown; label: unknown }, adminActor(request));
    return { reference: listReference({ includeInactive: true }) };
  });
}

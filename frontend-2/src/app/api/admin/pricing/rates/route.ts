import { NextRequest } from "next/server";

import { adminActor, requireAdmin } from "@/lib/admin-auth";
import { ValidationError } from "@/lib/business/validate";
import { apiHandle } from "@/server/http";
import { addRate, setRateEnabled, type RateInput } from "@/server/pricing-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/admin/pricing/rates - adds one market rate: { country, roleId, levelId, kind, min, median, max (smallest unit), source, sourceUrl?, effectiveDate, note? }. A source and a date are mandatory. Admin only. */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("PRICING RATE ADD", async () => ({ rate: addRate((await request.json()) as RateInput, adminActor(request)) }));
}

/** PUT /api/admin/pricing/rates - { id, enabled }: switches one rate on or off. Its figures cannot be changed. Admin only. */
export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("PRICING RATE SWITCH", async () => {
    const b = (await request.json()) as { id?: unknown; enabled?: unknown };
    if (typeof b.id !== "number" || typeof b.enabled !== "boolean") throw new ValidationError("id and enabled are required.");
    setRateEnabled(b.id, b.enabled, adminActor(request));
    return { id: b.id, enabled: b.enabled };
  });
}

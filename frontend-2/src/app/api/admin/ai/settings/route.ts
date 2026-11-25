import { NextRequest } from "next/server";

import { auditAdmin } from "@/server/audit";
import { requireAdmin } from "@/lib/admin-auth";
import { transaction } from "@/lib/business/db";
import { getMeteringPolicy, getUnitsPerUsd, setMeteringPolicy, setUnitsPerUsd } from "@/server/ai/catalog";
import { aiHandle } from "@/server/ai/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const current = () => ({ unitsPerUsd: getUnitsPerUsd(), ...getMeteringPolicy() });

/** GET /api/admin/ai/settings - the conversion and metering settings in force. Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return aiHandle("AI SETTINGS GET", () => current());
}

/**
 * PUT /api/admin/ai/settings - any of: { unitsPerUsd, minChargeUnits, rounding }. Only the fields sent change.
 * unitsPerUsd: credit units one US dollar of CHARGE is worth (1 credit = 1000 units). minChargeUnits: the smallest charge for a request that cost the
 * provider anything. rounding: "up" (never undercharge by rounding) or "nearest". Admin only.
 */
export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return aiHandle("AI SETTINGS", async () => {
    const body = (await request.json()) as { unitsPerUsd?: unknown; minChargeUnits?: unknown; rounding?: unknown };
    // All or nothing: a bad value in any field leaves every setting as it was.
    return transaction(() => {
      if (body.unitsPerUsd !== undefined) setUnitsPerUsd(body.unitsPerUsd as number);
      setMeteringPolicy({ rounding: body.rounding, minChargeUnits: body.minChargeUnits });
      auditAdmin("ai.charging_settings_changed", "settings", "ai_charging", { sent: body });
      return current();
    });
  });
}

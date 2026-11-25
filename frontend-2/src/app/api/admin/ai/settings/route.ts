import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { getUnitsPerUsd, setUnitsPerUsd } from "@/server/ai/catalog";
import { aiHandle } from "@/server/ai/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT /api/admin/ai/settings - { unitsPerUsd }: how many credit units one US dollar of provider cost is worth (1 credit = 1000 units). Admin only. */
export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return aiHandle("AI SETTINGS", async () => {
    const body = (await request.json()) as { unitsPerUsd?: unknown };
    setUnitsPerUsd(body.unitsPerUsd as number);
    return { unitsPerUsd: getUnitsPerUsd() };
  });
}

import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { saveModel, type ModelInput } from "@/server/ai/catalog";
import { aiHandle } from "@/server/ai/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT /api/admin/ai/models - create or update one model (only the fields sent change). Prices are whole micro-USD per million tokens. Admin only. */
export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return aiHandle("AI MODEL SAVE", async () => ({ model: saveModel((await request.json()) as ModelInput) }));
}

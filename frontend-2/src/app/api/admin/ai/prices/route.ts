import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { ValidationError } from "@/lib/business/validate";
import { getModel, listPriceHistory } from "@/server/ai/catalog";
import { aiHandle } from "@/server/ai/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/ai/prices?modelId=... - every price version a model has had, newest first (append-only history). Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return aiHandle("AI PRICES", () => {
    const modelId = request.nextUrl.searchParams.get("modelId");
    if (!modelId || !getModel(modelId)) throw new ValidationError("modelId must name an existing model.");
    return { modelId, versions: listPriceHistory(modelId) };
  });
}

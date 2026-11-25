import { NextRequest } from "next/server";

import { publicModels } from "@/server/ai/catalog";
import { aiHandle } from "@/server/ai/http";
import { getWallet } from "@/server/credits";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workspace/ai/models - the models a customer may choose, with credit prices only (never the provider's cost or markup), and the wallet. */
export async function GET(request: NextRequest) {
  const auth = requireSession(request, "ai:use");
  if ("denied" in auth) return auth.denied;
  return aiHandle("AI MODELS", () => ({ models: publicModels(), wallet: getWallet(auth.ctx.orgId) }));
}

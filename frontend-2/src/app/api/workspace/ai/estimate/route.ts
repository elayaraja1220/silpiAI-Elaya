import { NextRequest } from "next/server";

import { estimate } from "@/server/ai/gateway";
import { aiHandle } from "@/server/ai/http";
import { getWallet } from "@/server/credits";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/workspace/ai/estimate - the most a request could hold, before it is sent, and what the wallet has available. Charges nothing. */
export async function POST(request: NextRequest) {
  const auth = requireSession(request, "ai:use");
  if ("denied" in auth) return auth.denied;
  return aiHandle("AI ESTIMATE", async () => {
    const body = (await request.json()) as { messages?: unknown; system?: unknown; model?: unknown; maxOutputTokens?: unknown; taskType?: unknown };
    return { estimate: estimate({ model: typeof body.model === "string" ? body.model : "auto", messages: body.messages, system: body.system, maxOutputTokens: body.maxOutputTokens, taskType: typeof body.taskType === "string" ? body.taskType : undefined }), wallet: getWallet(auth.ctx.orgId) };
  });
}

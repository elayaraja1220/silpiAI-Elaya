import { NextRequest } from "next/server";

import { aiHandle } from "@/server/ai/http";
import { complete } from "@/server/ai/gateway";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/workspace/ai/chat - one AI request through the gateway, paid from the caller's organization wallet.
 * { messages: [{role, content}], system?, model?: id | "fast" | "balanced" | "best" | "auto", maxOutputTokens?, purpose? }
 * Header `Idempotency-Key` (6 to 200 characters) is required: repeating a request with the same key never charges twice.
 * The organization comes from the session, never from the body.
 */
export async function POST(request: NextRequest) {
  const auth = requireSession(request, "ai:use");
  if ("denied" in auth) return auth.denied;
  return aiHandle("AI CHAT", async () => {
    const body = (await request.json()) as { messages?: unknown; system?: unknown; model?: unknown; maxOutputTokens?: unknown; purpose?: unknown };
    const result = await complete({
      orgId: auth.ctx.orgId,
      userId: auth.ctx.user.id,
      model: typeof body.model === "string" ? body.model : "auto",
      messages: body.messages,
      system: body.system,
      maxOutputTokens: body.maxOutputTokens,
      purpose: typeof body.purpose === "string" ? body.purpose : "chat",
      idempotencyKey: request.headers.get("idempotency-key") ?? "",
    });
    return { result };
  });
}

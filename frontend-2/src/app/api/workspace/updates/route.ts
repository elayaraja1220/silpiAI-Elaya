import { NextRequest } from "next/server";

import { aiUpdates } from "@/server/ai-updates";
import { aiHandle } from "@/server/ai/http";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workspace/updates - the AI workspace's updates for this organization (builds, credits, a failed payment), newest first, and how many need the person's action. Any member. */
export async function GET(request: NextRequest) {
  const auth = requireSession(request, "lead:read");
  if ("denied" in auth) return auth.denied;
  return aiHandle("AI UPDATES", () => {
    const updates = aiUpdates(auth.ctx.orgId);
    return { updates, needsAction: updates.filter((u) => u.needsAction).length };
  });
}

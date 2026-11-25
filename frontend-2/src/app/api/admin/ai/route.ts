import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { adminOverview } from "@/server/ai/catalog";
import { providerBreaker } from "@/server/ai/circuit";
import { aiHandle } from "@/server/ai/http";
import { defaultProviders } from "@/server/ai/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/ai - the providers (key set or not, circuit state), models with their real provider prices and markup, the credit conversion, and this month's cost versus charges per organization. Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return aiHandle("AI ADMIN", () => ({ overview: { ...adminOverview(), providers: Object.values(defaultProviders()).filter((p) => p.id !== "echo").map((p) => ({ id: p.id, configured: p.isConfigured(), circuit: providerBreaker.state(p.id) })) } }));
}

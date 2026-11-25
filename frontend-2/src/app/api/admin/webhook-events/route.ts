import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { apiHandle } from "@/server/http";
import { listPaymentProviders } from "@/server/payments/provider";
import { listWebhookEvents } from "@/server/payments/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/webhook-events - the payment providers that are set up, and the latest notices received from them with what became of each. Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("WEBHOOK EVENTS", () => ({ providers: listPaymentProviders(), events: listWebhookEvents(Number(request.nextUrl.searchParams.get("limit") ?? 50) || 50) }));
}

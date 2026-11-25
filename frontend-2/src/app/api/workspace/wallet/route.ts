import { NextRequest } from "next/server";

import { bucketSummary, getBuckets, getWallet } from "@/server/credits";
import { apiHandle } from "@/server/http";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/workspace/wallet - this organization's credits: the wallet, the totals per category (promotional, subscription, purchased),
 * the next expiry, and each bucket in the order it will be spent. The organization comes from the session. Any member may read it.
 */
export async function GET(request: NextRequest) {
  const auth = requireSession(request, "lead:read");
  if ("denied" in auth) return auth.denied;
  const { orgId } = auth.ctx;
  return apiHandle("WALLET GET", () => ({
    wallet: getWallet(orgId),
    summary: bucketSummary(orgId),
    // What a customer sees of a bucket: its kind, size and expiry. Where it came from (internal references) stays private.
    buckets: getBuckets(orgId).map((b) => ({ id: b.id, category: b.category, remainingUnits: b.remainingUnits, heldUnits: b.heldUnits, expiresAt: b.expiresAt, expired: b.expired })),
  }));
}

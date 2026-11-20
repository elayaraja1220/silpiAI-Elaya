import { NextRequest } from "next/server";

import { handle, notFound } from "@/lib/business/http";
import { getLead, shareToken } from "@/lib/business/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/business/leads/:id/share - the client's private approval link. */
export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("SHARE", () => ({ path: `/q/${shareToken(id)}` }));
}

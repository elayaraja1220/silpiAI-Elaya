import { NextRequest } from "next/server";

import { handle, notFound } from "@/lib/business/http";
import { approvalRecord, getLead } from "@/lib/business/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/business/leads/:id/approvals - every version of the quotation, every approval with the terms that were agreed, and whether each is still intact. Read only. */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("APPROVALS", () => approvalRecord(id));
}

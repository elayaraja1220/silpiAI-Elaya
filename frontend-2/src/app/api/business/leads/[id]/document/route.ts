import { NextRequest } from "next/server";

import { quotationDownload } from "@/lib/business/download";
import { notFound } from "@/lib/business/http";
import { getLead } from "@/lib/business/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/business/leads/:id/document?format=pdf|docx - download the latest quotation. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const lead = getLead(id);
  if (!lead) return notFound();
  return quotationDownload(lead, request.nextUrl.searchParams.get("format"));
}

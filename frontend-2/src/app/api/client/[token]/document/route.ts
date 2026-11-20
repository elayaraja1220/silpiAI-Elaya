import { NextRequest, NextResponse } from "next/server";

import { quotationDownload } from "@/lib/business/download";
import { getLeadByToken } from "@/lib/business/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/client/:token/document?format=pdf|docx - client's download. Public. */
export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const lead = getLeadByToken(token);
  if (!lead) return NextResponse.json({ success: false, error: "This quotation link is not valid." }, { status: 404 });
  // The file never includes internal notes; strip them before rendering.
  const { insights: _i, references: _r, ...requirement } = lead.requirement;
  const quotation = lead.quotation && { ...lead.quotation, requirement: lead.quotation.requirement && { ...lead.quotation.requirement, insights: undefined, references: "" } };
  return quotationDownload({ ...lead, requirement: { ...requirement, references: "" }, quotation }, request.nextUrl.searchParams.get("format"));
}

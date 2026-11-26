import { NextRequest } from "next/server";

import { handleAnalyze } from "@/lib/business/analyze-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/business/analyze (multipart: files[], notes, fresh?)
 * Reads the client's requirement documents with AI and returns a draft for the requirement form. The team reviews the draft first.
 * The work is in lib/business/analyze-request.ts, shared with the client's own door (/api/workspace/fixed-price/analyze).
 */
export async function POST(request: NextRequest) {
  return handleAnalyze(request);
}

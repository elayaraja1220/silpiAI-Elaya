import { NextRequest } from "next/server";

import { fileResponse } from "@/lib/business/asset-http";
import { readFile } from "@/lib/business/asset-store";
import { handle, notFound } from "@/lib/business/http";
import { getLead } from "@/lib/business/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/business/leads/:id/assets/files/:fileId[?inline=1] - download a collected file (team). */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string; fileId: string }> }) {
  const { id, fileId } = await context.params;
  if (!getLead(id)) return notFound();
  let file: { name: string; bytes: Buffer } | undefined;
  const failed = await handle("ASSETS FILE", () => { file = readFile(id, fileId); return {}; });
  if (!file) return failed;
  return fileResponse(file.name, file.bytes, request.nextUrl.searchParams.get("inline") === "1");
}

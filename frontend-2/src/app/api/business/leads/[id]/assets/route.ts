import { NextRequest } from "next/server";

import { readUpload } from "@/lib/business/asset-http";
import { ensureChecklist, listAssets, removeFile, saveFiles, updateAsset } from "@/lib/business/asset-store";
import { assetsOpen } from "@/lib/business/assets";
import { handle, notFound } from "@/lib/business/http";
import { getLead } from "@/lib/business/store";
import { ValidationError } from "@/lib/business/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** GET /api/business/leads/:id/assets - the checklist of originals to collect (created on first use, after approval). */
export async function GET(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  const lead = getLead(id);
  if (!lead) return notFound();
  return handle("ASSETS GET", () => {
    const available = assetsOpen(lead.stage);
    if (available) ensureChecklist(lead);
    return { available, assets: available ? listAssets(id) : [] };
  });
}

/** PATCH { assetId, status?, note?, text? } - the team confirms an item, asks for it again, or edits the text. */
export async function PATCH(request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("ASSETS UPDATE", async () => {
    const body = (await request.json()) as { assetId?: unknown; status?: unknown; note?: unknown; text?: unknown };
    if (typeof body.assetId !== "string") throw new ValidationError("Choose an item.");
    updateAsset(id, body.assetId, body);
    return { available: true, assets: listAssets(id) };
  });
}

/** POST multipart { assetId, files } - the team uploads on the client's behalf (for example files sent on WhatsApp). */
export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("ASSETS UPLOAD", async () => {
    const { assetId, files } = await readUpload(request);
    saveFiles(id, assetId, files, "team");
    return { available: true, assets: listAssets(id) };
  });
}

/** DELETE ?fileId=... - the team removes a file. */
export async function DELETE(request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("ASSETS DELETE", () => {
    removeFile(id, request.nextUrl.searchParams.get("fileId") ?? "", "team");
    return { available: true, assets: listAssets(id) };
  });
}

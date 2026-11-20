import { NextRequest, NextResponse } from "next/server";

import { readUpload } from "@/lib/business/asset-http";
import { ensureChecklist, listAssets, removeFile, saveFiles, saveText } from "@/lib/business/asset-store";
import { assetsOpen } from "@/lib/business/assets";
import { handle } from "@/lib/business/http";
import { getLeadByToken } from "@/lib/business/store";
import { StageError } from "@/lib/business/store";
import { ValidationError } from "@/lib/business/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };
const gone = () => NextResponse.json({ success: false, error: "This link is not valid." }, { status: 404 });

/** Small per-link limit so a leaked link cannot be used to fill the disk. */
const uploads = new Map<string, number[]>();
function allowUpload(token: string, limit = 80, windowMs = 60 * 60 * 1000): boolean {
  const recent = (uploads.get(token) ?? []).filter((t) => Date.now() - t < windowMs);
  if (recent.length >= limit) return false;
  uploads.set(token, [...recent, Date.now()]);
  return true;
}

/** The client's view of the checklist. The team's note is shown to the client on purpose; nothing else internal is. */
function openLead(token: string) {
  const lead = getLeadByToken(token);
  if (!lead) return null;
  if (!assetsOpen(lead.stage)) throw new StageError("Sending your files opens after you approve the quotation.");
  ensureChecklist(lead);
  return lead;
}

/** GET /api/client/:token/assets - what we need from the client, and what is already received. Public (secret link). */
export async function GET(_request: NextRequest, context: Context) {
  const { token } = await context.params;
  const exists = getLeadByToken(token);
  if (!exists) return gone();
  return handle("CLIENT ASSETS", () => {
    const available = assetsOpen(exists.stage);
    if (available) ensureChecklist(exists);
    return { available, assets: available ? listAssets(exists.id) : [] };
  });
}

/** POST - multipart { assetId, files } to upload, or JSON { assetId, text } to save typed content. */
export async function POST(request: NextRequest, context: Context) {
  const { token } = await context.params;
  if (!getLeadByToken(token)) return gone();
  if (!allowUpload(token)) return NextResponse.json({ success: false, error: "Too many uploads for now. Please try again in a while or contact us." }, { status: 429 });
  return handle("CLIENT ASSETS SAVE", async () => {
    const lead = openLead(token)!;
    if ((request.headers.get("content-type") ?? "").includes("application/json")) {
      const body = (await request.json()) as { assetId?: unknown; text?: unknown };
      if (typeof body.assetId !== "string") throw new ValidationError("Choose an item.");
      saveText(lead.id, body.assetId, body.text);
    } else {
      const { assetId, files } = await readUpload(request);
      saveFiles(lead.id, assetId, files, "client");
    }
    return { available: true, assets: listAssets(lead.id) };
  });
}

/** DELETE ?fileId=... - the client removes a file they sent (until the team has confirmed the item). */
export async function DELETE(request: NextRequest, context: Context) {
  const { token } = await context.params;
  if (!getLeadByToken(token)) return gone();
  return handle("CLIENT ASSETS DELETE", () => {
    const lead = openLead(token)!;
    removeFile(lead.id, request.nextUrl.searchParams.get("fileId") ?? "", "client");
    return { available: true, assets: listAssets(lead.id) };
  });
}

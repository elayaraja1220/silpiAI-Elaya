import { NextRequest, NextResponse } from "next/server";

import { isInlineImage, extensionOf } from "./assets";
import type { IncomingFile } from "./asset-store";
import { ValidationError } from "./validate";

/** Largest single upload request (a few photos at a time; use several requests or a ZIP for more). */
const MAX_REQUEST_BYTES = 45 * 1024 * 1024;

/** Reads a multipart upload: one `assetId` field and any number of `files`. */
export async function readUpload(request: NextRequest): Promise<{ assetId: string; files: IncomingFile[] }> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_REQUEST_BYTES) throw new ValidationError("That is too much to send at once. Send fewer files at a time, or put them in a ZIP file.");
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ValidationError("The upload could not be read. Please try again.");
  }
  const assetId = form.get("assetId");
  if (typeof assetId !== "string") throw new ValidationError("Choose which item the file is for.");
  const files: IncomingFile[] = [];
  for (const entry of form.getAll("files")) {
    if (typeof entry === "string") continue;
    files.push({ name: entry.name, bytes: Buffer.from(await entry.arrayBuffer()) });
  }
  return { assetId, files };
}

/**
 * A download response. Always an attachment with a neutral type and no sniffing, so an uploaded file can never run
 * as a page. Only raster pictures may be shown inline (`inline=1`) for the team's thumbnails.
 */
export function fileResponse(name: string, bytes: Buffer, inline: boolean): NextResponse {
  const showInline = inline && isInlineImage(name);
  const ext = extensionOf(name);
  const type = showInline ? (ext === "jpg" ? "image/jpeg" : `image/${ext}`) : "application/octet-stream";
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `${showInline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    },
  });
}

import { NextRequest } from "next/server";

import { handle } from "@/lib/business/http";
import { ValidationError } from "@/lib/business/validate";
import { requireAdminOrDevStart } from "@/lib/dev-start"; // TEMP DEV: see dev-start.ts
import { overview } from "@/lib/demo/service";
import { setPublicBase } from "@/lib/demo/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT { publicUrl } - the address clients open demos at (a tunnel or host). Empty = this computer only. Team only. */
export async function PUT(request: NextRequest) {
  const denied = requireAdminOrDevStart(request);
  if (denied) return denied;
  return handle("DEMO SETTINGS", async () => {
    const body = (await request.json().catch(() => ({}))) as { publicUrl?: unknown };
    if (typeof body.publicUrl !== "string") throw new ValidationError("Give the public address, or leave it empty.");
    try {
      setPublicBase(body.publicUrl);
    } catch (e) {
      throw new ValidationError((e as Error).message);
    }
    return overview();
  });
}

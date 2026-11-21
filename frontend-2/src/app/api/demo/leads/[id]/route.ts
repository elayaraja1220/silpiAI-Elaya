import { NextRequest } from "next/server";

import { handle, notFound } from "@/lib/business/http";
import { getLead } from "@/lib/business/store";
import { ValidationError } from "@/lib/business/validate";
import { requireAdminOrDevStart } from "@/lib/dev-start"; // TEMP DEV: see dev-start.ts
import { createDemo, demosOfLead, overview, stopDemo } from "@/lib/demo/service";
import { ensureGatewayIfNeeded } from "@/lib/demo/gateway";
import { getDemo } from "@/lib/demo/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Building and checking a site can take a while.
export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

/** GET /api/demo/leads/:id - this project's demos and the gateway state. Team only. */
export async function GET(request: NextRequest, context: Context) {
  const denied = requireAdminOrDevStart(request);
  if (denied) return denied;
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("DEMO LEAD LIST", async () => {
    await ensureGatewayIfNeeded();
    return { ...overview(), demos: demosOfLead(id) };
  });
}

/** POST { days?, password?, label?, showToClient? } - copy the site, check it, and make a private link. Team only. */
export async function POST(request: NextRequest, context: Context) {
  const denied = requireAdminOrDevStart(request);
  if (denied) return denied;
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("DEMO CREATE", async () => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const demo = await createDemo(id, body);
    return { ...overview(), demo, demos: demosOfLead(id) };
  });
}

/** DELETE ?demoId=... - stop a demo. The link stops working at once. Team only. */
export async function DELETE(request: NextRequest, context: Context) {
  const denied = requireAdminOrDevStart(request);
  if (denied) return denied;
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("DEMO STOP", () => {
    const demoId = request.nextUrl.searchParams.get("demoId") ?? "";
    const row = getDemo(demoId);
    if (!row || row.lead_id !== id) throw new ValidationError("That demo was not found.");
    stopDemo(demoId);
    return { ...overview(), demos: demosOfLead(id) };
  });
}

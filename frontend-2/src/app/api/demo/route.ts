import { NextRequest } from "next/server";

import { handle } from "@/lib/business/http";
import { requireAdminOrDevStart } from "@/lib/dev-start"; // TEMP DEV: see dev-start.ts
import { ensureGatewayIfNeeded } from "@/lib/demo/gateway";
import { liveDemos, overview } from "@/lib/demo/service";
import { purgeEnded } from "@/lib/demo/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/demo - every live demo (all projects) and the state of the demo gateway. Team only. */
export async function GET(request: NextRequest) {
  const denied = requireAdminOrDevStart(request);
  if (denied) return denied;
  return handle("DEMO LIST", async () => {
    purgeEnded();
    await ensureGatewayIfNeeded();
    return { ...overview(), demos: liveDemos() };
  });
}

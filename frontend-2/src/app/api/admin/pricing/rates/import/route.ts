import { NextRequest } from "next/server";

import { adminActor, requireAdmin } from "@/lib/admin-auth";
import { ValidationError } from "@/lib/business/validate";
import { apiHandle } from "@/server/http";
import { importRates } from "@/server/pricing-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/admin/pricing/rates/import - { csv }: many rates at once, all or none. Header: country,role,level,kind,min,median,max,source,source_url,effective_date (amounts in the main unit). Admin only. */
export async function POST(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("PRICING RATE IMPORT", async () => {
    const b = (await request.json()) as { csv?: unknown };
    if (typeof b.csv !== "string" || b.csv.length > 2_000_000) throw new ValidationError("Send the CSV text (up to 2 MB) as csv.");
    return importRates(b.csv, adminActor(request));
  });
}

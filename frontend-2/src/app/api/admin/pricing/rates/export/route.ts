import { NextRequest, NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { exportRates } from "@/server/pricing-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/pricing/rates/export?country=GB - the rates as a CSV file, with their sources, for review in a spreadsheet. Read only; a viewer may download it. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const country = request.nextUrl.searchParams.get("country") ?? "";
  const csv = exportRates(/^[A-Za-z]{2}$/.test(country) ? { country } : {});
  return new NextResponse(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="silpi-market-rates.csv"', "Cache-Control": "no-store" } });
}

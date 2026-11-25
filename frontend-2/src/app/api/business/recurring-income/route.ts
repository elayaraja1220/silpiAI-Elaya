import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { allRunningServices } from "@/lib/business/running-store";
import { recurringIncome } from "@/lib/business/running-services";
import { getLead, getRateCard } from "@/lib/business/store";
import type { Stage } from "@/lib/business/types";
import { run } from "@/lib/execution/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Projects that are approved and still alive: only these are really being billed. */
const BILLING: Stage[] = ["approved", "advance_paid", "in_development", "testing", "demo_ready", "final_paid", "delivered"];

/**
 * GET /api/business/recurring-income - ADMIN ONLY (it uses provider cost).
 * What SILPI earns each month from the repeating services it bills, over approved projects.
 */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return run("RECURRING INCOME GET", () => {
    const names = new Map<string, string>();
    const entries = allRunningServices().filter((e) => {
      const lead = getLead(e.leadId);
      if (!lead || !BILLING.includes(lead.stage)) return false;
      names.set(e.leadId, lead.client.company || lead.client.name);
      return true;
    });
    const income = recurringIncome(entries, getRateCard().gstRate);
    return { income: { ...income, rows: income.rows.map((r) => ({ ...r, client: names.get(r.leadId) ?? "" })) } };
  });
}

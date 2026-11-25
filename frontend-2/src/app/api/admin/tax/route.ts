import { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/admin-auth";
import { auditAdmin } from "@/server/audit";
import { apiHandle } from "@/server/http";
import { gstBasisPoints, listTaxRules, saveTaxRule } from "@/server/tax";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/tax - the tax rules, and the GST rate that applies to rupee invoices when no rule matches. Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("TAX LIST", () => ({ rules: listTaxRules(), gstBasisPoints: gstBasisPoints() }));
}

/** PUT /api/admin/tax - { country, currency?, label, rateBasisPoints, active?, note? }: adds or changes a rule. Invoices already raised keep the rate they were raised at. Admin only. */
export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return apiHandle("TAX SAVE", async () => {
    const rule = saveTaxRule((await request.json()) as Parameters<typeof saveTaxRule>[0]);
    auditAdmin(request, "tax_rule.saved", "tax_rule", rule.id, { ...rule });
    return { rule, rules: listTaxRules() };
  });
}

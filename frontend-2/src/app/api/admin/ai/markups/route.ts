import { NextRequest } from "next/server";

import { auditAdmin } from "@/server/audit";
import { requireAdmin } from "@/lib/admin-auth";
import { ValidationError } from "@/lib/business/validate";
import { deleteMarkupRule, listMarkupRules, saveMarkupRule } from "@/server/ai/catalog";
import { aiHandle } from "@/server/ai/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/ai/markups - every markup rule. Admin only. */
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return aiHandle("AI MARKUPS", () => ({ rules: listMarkupRules() }));
}

/**
 * PUT /api/admin/ai/markups - { id?, provider?, modelId?, taskType?, markupBasisPoints, enabled?, note? }. Creates a rule, or changes the one named by id.
 * Markup is basis points (10000 = charge the provider's cost as is, 25000 = 2.5 times). At least one of provider, modelId, taskType is required. Admin only.
 */
export async function PUT(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return aiHandle("AI MARKUP SAVE", async () => {
    const rule = saveMarkupRule((await request.json()) as Parameters<typeof saveMarkupRule>[0]);
    auditAdmin(request, "markup_rule.saved", "markup_rule", rule.id, { ...rule });
    return { rule };
  });
}

/** DELETE /api/admin/ai/markups?id=... - removes a rule (the model's own markup applies again). Admin only. */
export async function DELETE(request: NextRequest) {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return aiHandle("AI MARKUP DELETE", () => {
    const id = Number(request.nextUrl.searchParams.get("id"));
    if (!Number.isSafeInteger(id) || id < 1) throw new ValidationError("id is required.");
    deleteMarkupRule(id);
    auditAdmin(request, "markup_rule.deleted", "markup_rule", id);
    return { deleted: id };
  });
}

import { NextRequest } from "next/server";

import { ValidationError } from "@/lib/business/validate";
import { apiHandle } from "@/server/http";
import { requireSession } from "@/server/session-auth";
import { taxDocument } from "@/server/tax";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workspace/billing/document?kind=invoice|topup&id=... - an invoice or credit-pack order as a printable document. Only this organization's own. Owners and admins only. */
export async function GET(request: NextRequest) {
  const auth = requireSession(request, "billing:manage");
  if ("denied" in auth) return auth.denied;
  return apiHandle("BILLING DOCUMENT", () => {
    const kind = request.nextUrl.searchParams.get("kind");
    const id = request.nextUrl.searchParams.get("id") ?? "";
    if (kind !== "invoice" && kind !== "topup") throw new ValidationError('kind must be "invoice" or "topup".');
    const document = taxDocument(auth.ctx.orgId, kind, id);
    if (!document) throw new ValidationError("That document does not exist.");
    return { document };
  });
}

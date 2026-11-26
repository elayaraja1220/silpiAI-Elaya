import { NextRequest } from "next/server";

import { sameSite } from "@/lib/admin-auth";
import { unlinkIdentity } from "@/server/account";
import { failure, json } from "@/server/auth-http";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/account/identities/google|facebook - disconnects that sign-in method (refused when it is the person's only way in). */
export async function DELETE(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const auth = requireSession(request);
  if ("denied" in auth) return auth.denied;
  if (!sameSite(request)) return json({ success: false, error: "Cross-site request blocked." }, 403);
  try {
    unlinkIdentity(auth.ctx.user.id, (await context.params).provider);
    return json({ success: true });
  } catch (error) {
    return failure("ACCOUNT UNLINK", error);
  }
}

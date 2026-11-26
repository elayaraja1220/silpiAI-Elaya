import { NextRequest } from "next/server";

import { allowLoginAttempt } from "@/lib/admin-auth";
import { validateEmail } from "@/lib/client-auth";
import { failure, json, openDoor, publicBaseUrl } from "@/server/auth-http";
import { requestPasswordReset } from "@/server/client-accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAME_ANSWER = { success: true, message: "If that email has an account, we have sent a link to reset the password. It works for 60 minutes." };

/**
 * POST /api/auth/forgot - { email }. Always answers the same way, whether or not the address has an account, so it cannot be used to find out who has one.
 * A few requests per address and per e-mail per ten minutes. The link points to SILPI_PUBLIC_URL (or, on a development server only, to this server).
 */
export async function POST(request: NextRequest) {
  const door = await openDoor(request, "forgot", 6);
  if ("answer" in door) return door.answer;
  try {
    let email = "";
    try { email = validateEmail(door.body.email); } catch { return json(SAME_ANSWER); }
    if (!allowLoginAttempt(`forgot-email:${email}`, Date.now(), 3)) return json(SAME_ANSWER);
    const base = publicBaseUrl(request);
    if (!base) {
      console.error("SILPI FORGOT: SILPI_PUBLIC_URL is not set on a production server, so no reset link can be sent.");
      return json(SAME_ANSWER);
    }
    // Not waited for: how long sending takes would otherwise tell a visitor whether the address has an account. A failure is for the operator's log, not the visitor.
    void requestPasswordReset(email, base).catch((error: Error) => console.error("SILPI FORGOT: the reset message could not be sent:", error.message));
    return json(SAME_ANSWER);
  } catch (error) {
    return failure("FORGOT", error);
  }
}

import { NextRequest } from "next/server";

import { signOutEverywhere } from "@/server/account";
import { json } from "@/server/auth-http";
import { sameSite } from "@/lib/admin-auth";
import { requireSession, sessionCookie } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/account/sign-out-everywhere - ends every session of this account, this browser's included. */
export async function POST(request: NextRequest) {
  const auth = requireSession(request);
  if ("denied" in auth) return auth.denied;
  if (!sameSite(request)) return json({ success: false, error: "Cross-site request blocked." }, 403);
  const ended = signOutEverywhere(auth.ctx.user.id);
  const response = json({ success: true, ended });
  response.cookies.set(sessionCookie(request, ""));
  return response;
}

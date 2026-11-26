import { NextRequest } from "next/server";

import { allowLoginAttempt } from "@/lib/admin-auth";
import { changePassword } from "@/server/account";
import { failure, json, openDoor } from "@/server/auth-http";
import { requireSession } from "@/server/session-auth";
import { SESSION_COOKIE } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/account/password - { current, password }: changes the password. The current one must be right; every other session of the account ends. A few tries an hour. */
export async function POST(request: NextRequest) {
  const auth = requireSession(request);
  if ("denied" in auth) return auth.denied;
  const door = await openDoor(request, "password", 10);
  if ("answer" in door) return door.answer;
  if (!allowLoginAttempt(`password-user:${auth.ctx.user.id}`, Date.now(), 6, 60 * 60_000)) return json({ success: false, error: "Too many attempts. Try again later." }, 429);
  try {
    await changePassword(auth.ctx.user.id, door.body.current, door.body.password, request.cookies.get(SESSION_COOKIE)?.value);
    return json({ success: true, message: "Your password has been changed. Your other sessions were signed out." });
  } catch (error) {
    return failure("ACCOUNT PASSWORD", error);
  }
}

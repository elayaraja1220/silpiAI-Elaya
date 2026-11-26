import { NextRequest } from "next/server";

import { failure, json, openDoor } from "@/server/auth-http";
import { resetPassword } from "@/server/client-accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/reset - { token, password }. Sets a new password from a reset link (it works once and expires) and ends every session of that account. It does not sign anyone in. */
export async function POST(request: NextRequest) {
  const door = await openDoor(request, "reset", 8);
  if ("answer" in door) return door.answer;
  try {
    await resetPassword(door.body.token, door.body.password);
    return json({ success: true, message: "Your password has been changed. Sign in with the new password." });
  } catch (error) {
    return failure("RESET", error);
  }
}

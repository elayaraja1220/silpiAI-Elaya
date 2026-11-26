import { NextRequest } from "next/server";

import { validateEmail } from "@/lib/client-auth";
import { failure, json, openDoor } from "@/server/auth-http";
import { allowLoginAttempt } from "@/lib/admin-auth";
import { signUp } from "@/server/client-accounts";
import { sessionCookie } from "@/server/session-auth";
import { createSession } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/signup - { name, email, password, acceptTerms: true }. Public by design: it is a door.
 * Creates the account, the person's own workspace (organization) and a signed-in session in one step. The password is stored only as a salted scrypt hash.
 * Limited per address and per e-mail, and it must come from this site.
 */
export async function POST(request: NextRequest) {
  const door = await openDoor(request, "signup", 6);
  if ("answer" in door) return door.answer;
  try {
    let key = "";
    try { key = validateEmail(door.body.email); } catch { /* the validation below says what is wrong */ }
    if (key && !allowLoginAttempt(`signup-email:${key}`, Date.now(), 4)) return json({ success: false, error: "Too many attempts. Try again in a few minutes." }, 429);
    const { user, organization } = await signUp({ name: door.body.name, email: door.body.email, password: door.body.password, acceptTerms: door.body.acceptTerms });
    const session = createSession(user.id);
    const response = json({ success: true, user: { id: user.id, email: user.email, name: user.name }, organization: { id: organization.id, name: organization.name, type: organization.type } }, 201);
    response.cookies.set(sessionCookie(request, session.token));
    return response;
  } catch (error) {
    return failure("SIGNUP", error);
  }
}

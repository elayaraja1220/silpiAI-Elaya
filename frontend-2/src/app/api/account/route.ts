import { NextRequest } from "next/server";

import { configuredProviders } from "@/server/oauth";
import { getProfile, updateName } from "@/server/account";
import { failure, json, openDoor, publicBaseUrl } from "@/server/auth-http";
import { requireSession } from "@/server/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/account - the signed-in person's own details, connected sign-in methods and which methods can be connected. */
export async function GET(request: NextRequest) {
  const auth = requireSession(request);
  if ("denied" in auth) return auth.denied;
  try {
    const usable = publicBaseUrl(request) !== null;
    const set = configuredProviders();
    return json({ success: true, profile: getProfile(auth.ctx.user.id), providers: { google: usable && set.google, facebook: usable && set.facebook } });
  } catch (error) {
    return failure("ACCOUNT GET", error);
  }
}

/** PUT /api/account - { name }: changes the person's name. */
export async function PUT(request: NextRequest) {
  const auth = requireSession(request);
  if ("denied" in auth) return auth.denied;
  const door = await openDoor(request, "account", 30);
  if ("answer" in door) return door.answer;
  try {
    return json({ success: true, name: updateName(auth.ctx.user.id, door.body.name) });
  } catch (error) {
    return failure("ACCOUNT PUT", error);
  }
}

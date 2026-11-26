import { NextRequest } from "next/server";

import { json, publicBaseUrl } from "@/server/auth-http";
import { configuredProviders } from "@/server/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/providers - which social sign-in methods can be used right now: { google, facebook }. Only yes or no: no id, secret or address is revealed. */
export async function GET(request: NextRequest) {
  const usable = publicBaseUrl(request) !== null;
  const set = configuredProviders();
  return json({ success: true, google: usable && set.google, facebook: usable && set.facebook });
}

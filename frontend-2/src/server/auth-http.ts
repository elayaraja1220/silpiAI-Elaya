// Small helpers shared by the public sign-up, forgot-password and reset-password doors (server only).
import { NextRequest, NextResponse } from "next/server";

import { allowLoginAttempt, sameSite } from "@/lib/admin-auth";
import { ValidationError } from "@/lib/business/validate";

export const json = (body: object, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export const addressOf = (request: NextRequest): string => request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("host") || "local";

/** The request must come from this site, be JSON, and not be repeated too often. Returns the body or the answer to send instead. */
export async function openDoor(request: NextRequest, key: string, limit = 8): Promise<{ body: Record<string, unknown> } | { answer: NextResponse }> {
  if (!sameSite(request)) return { answer: json({ success: false, error: "Cross-site request blocked." }, 403) };
  if (!allowLoginAttempt(`${key}-ip:${addressOf(request)}`, Date.now(), limit)) return { answer: json({ success: false, error: "Too many attempts. Try again in a few minutes." }, 429) };
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return { answer: json({ success: false, error: "Request body must be a JSON object." }, 400) };
    return { body: body as Record<string, unknown> };
  } catch {
    return { answer: json({ success: false, error: "Request body must be JSON." }, 400) };
  }
}

/** A refusal the person can act on is shown as it is; anything unexpected is logged and answered plainly without details. */
export function failure(label: string, error: unknown): NextResponse {
  if (error instanceof ValidationError) return json({ success: false, error: error.message }, 400);
  console.error(`SILPI ${label} ERROR:`, error);
  return json({ success: false, error: "Something went wrong on the server." }, 500);
}

/**
 * The address a reset link points to. When SILPI_PUBLIC_URL is set it is always used. Without it the request's own address is used only on a development server
 * (a Host header is something a visitor can write, so on a real server it must not decide where a password-reset link points).
 */
export function publicBaseUrl(request: NextRequest, env: NodeJS.ProcessEnv = process.env): string | null {
  const fixed = env.SILPI_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (fixed) return fixed;
  if (env.NODE_ENV === "production") return null;
  return request.nextUrl.origin;
}

import { NextResponse } from "next/server";

import { apiHandle } from "@/server/http";
import { GatewayError, type GatewayErrorCode } from "./gateway";
import { JobError } from "./orchestrator";

const STATUS: Record<GatewayErrorCode, number> = { invalid: 400, "model-unavailable": 404, "provider-not-configured": 503, "daily-cap": 429, "too-many-requests": 429, "in-progress": 409, "provider-failed": 502, "provider-unavailable": 503 };

const refusal = (e: GatewayError | JobError) =>
  e instanceof JobError
    ? NextResponse.json({ success: false, error: e.message, code: e.code }, { status: e.code === "not-found" ? 404 : 409, headers: { "Cache-Control": "no-store" } })
    : NextResponse.json({ success: false, error: e.message, code: e.code, ...e.details }, { status: STATUS[e.code], headers: { "Cache-Control": "no-store" } });

/** apiHandle plus the gateway's and the builder's own errors (clear status and code); credit errors keep their 402/409 mapping. */
export async function aiHandle(label: string, fn: () => unknown): Promise<NextResponse> {
  const held: { refused: GatewayError | JobError | null } = { refused: null };
  const response = await apiHandle(label, async () => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof GatewayError || e instanceof JobError) { held.refused = e; return {}; }
      throw e;
    }
  });
  return held.refused ? refusal(held.refused) : response;
}

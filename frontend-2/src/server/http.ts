import { NextResponse } from "next/server";

import { handle } from "@/lib/business/http";
import { CreditError, type CreditErrorCode } from "./credits";

const STATUS: Record<CreditErrorCode, number> = { invalid: 400, "not-found": 404, insufficient: 402, "over-reservation": 409, closed: 409, "idempotency-conflict": 409 };

/** Like business `handle`, and also maps a CreditError to a clear status: 402 not enough credits, 409 conflicts, 404, 400. */
export async function apiHandle(label: string, fn: () => unknown): Promise<NextResponse> {
  try {
    return NextResponse.json({ success: true, ...((await fn()) as object) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof CreditError) return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: STATUS[error.code], headers: { "Cache-Control": "no-store" } });
    return handle(label, () => { throw error; });
  }
}

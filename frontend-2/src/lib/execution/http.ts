import { NextResponse } from "next/server";

import { StageError } from "@/lib/business/store";
import { ValidationError } from "@/lib/business/validate";

import { ExecError } from "./types";

/**
 * Runs an execution route body and turns known errors into JSON responses with a code the screen can act on.
 * Nothing internal (paths, stack traces, environment) is ever put in a response.
 */
export async function run(label: string, fn: () => unknown | Promise<unknown>): Promise<NextResponse> {
  const headers = { "Cache-Control": "no-store" };
  try {
    return NextResponse.json({ success: true, ...((await fn()) as object) }, { headers });
  } catch (error) {
    if (error instanceof ExecError) {
      return NextResponse.json({ success: false, code: error.code, error: error.message, ...(error.details ?? {}) }, { status: error.status, headers });
    }
    if (error instanceof ValidationError || error instanceof StageError) {
      return NextResponse.json({ success: false, code: "invalid", error: error.message }, { status: 400, headers });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ success: false, code: "invalid", error: "Request body must be JSON." }, { status: 400, headers });
    }
    console.error(`SILPI EXECUTION ${label} ERROR:`, error);
    return NextResponse.json({ success: false, code: "server-error", error: "Something went wrong on the server." }, { status: 500, headers });
  }
}

/** Reads a JSON body that must be an object (an empty body counts as an empty object). */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  const body = JSON.parse(text) as unknown;
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ValidationError("Request body must be a JSON object.");
  return body as Record<string, unknown>;
}

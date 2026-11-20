import { NextResponse } from "next/server";

import { StageError } from "./store";
import { ValidationError } from "./validate";

/** Runs a route handler body and maps known errors to JSON responses. */
export async function handle(label: string, fn: () => unknown): Promise<NextResponse> {
  try {
    return NextResponse.json({ success: true, ...((await fn()) as object) });
  } catch (error) {
    if (error instanceof ValidationError || error instanceof StageError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ success: false, error: "Request body must be JSON." }, { status: 400 });
    }
    console.error(`SILPI ${label} ERROR:`, error);
    return NextResponse.json({ success: false, error: "Something went wrong on the server." }, { status: 500 });
  }
}

export const notFound = () => NextResponse.json({ success: false, error: "Project not found." }, { status: 404 });

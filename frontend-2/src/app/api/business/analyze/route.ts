import { NextRequest, NextResponse } from "next/server";

import { readUploads, runAnalysis } from "@/lib/business/analyze";
import { ValidationError } from "@/lib/business/validate";
import { AgentUnavailableError } from "@/lib/silpi-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 200;

/**
 * POST /api/business/analyze (multipart: files[], notes)
 * Reads the client's requirement documents with AI and returns a draft for
 * the requirement form. Nothing is saved; the team reviews the draft first.
 */
export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    const notes = String(form.get("notes") ?? "").slice(0, 10_000);
    const docs = await readUploads(files);
    if (docs.length === 0 && !notes.trim()) {
      return NextResponse.json({ success: false, error: "Upload a document or type the requirement notes." }, { status: 400 });
    }
    const result = await runAnalysis(docs, notes);
    return NextResponse.json(result, { status: result.success ? 200 : 502 });
  } catch (error) {
    if (error instanceof ValidationError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    if (error instanceof AgentUnavailableError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 503 });
    }
    console.error("SILPI ANALYZE ERROR:", error);
    return NextResponse.json({ success: false, error: "Could not analyse the documents." }, { status: 500 });
  }
}

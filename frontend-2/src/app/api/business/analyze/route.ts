import { NextRequest, NextResponse } from "next/server";

import { analysisKey, getSavedAnalysis, saveAnalysis } from "@/lib/business/analysis-cache";
import { needed, stableDraft } from "@/lib/business/analysis-stable";
import { composeNotes, manifestNote, parseManifest } from "@/lib/business/analyze-sample";
import { readUploads, runAnalysis } from "@/lib/business/analyze";
import { defaultSections } from "@/lib/business/pricing";
import { getRateCard } from "@/lib/business/store";
import { ValidationError } from "@/lib/business/validate";
import { AgentUnavailableError } from "@/lib/silpi-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** The AI reads a document differently each time, so it reads it this many times and only what most runs agree on is kept. */
const RUNS = Math.min(5, Math.max(1, Number(process.env.SILPI_ANALYZE_RUNS) || 3));

/**
 * POST /api/business/analyze (multipart: files[], notes, fresh?)
 * Reads the client's requirement documents with AI and returns a draft for the requirement form. The team reviews the draft first.
 *
 * The same documents always give the same draft (and so the same estimate): a result already worked out for them is reused,
 * a new one is the agreement of several readings with the page names, section counts and order fixed by rules (see analysis-stable.ts).
 * `fresh=1` ignores the saved result and reads the documents again.
 */
export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    const docs = await readUploads(files);
    // The AI read only a sample when many files were supplied. Tell it how many there really are and what they are called.
    let manifest = null;
    try { manifest = parseManifest(form.get("manifest")); } catch (e) { throw new ValidationError((e as Error).message); }
    const extra = manifest ? manifestNote(manifest, docs.map((d) => d.name)) : "";
    const notes = composeNotes(String(form.get("notes") ?? ""), extra);
    if (docs.length === 0 && !notes.trim()) {
      return NextResponse.json({ success: false, error: "Upload a document or type the requirement notes." }, { status: 400 });
    }
    const key = analysisKey(docs, notes);
    if (form.get("fresh") !== "1") {
      const saved = getSavedAnalysis(key);
      if (saved) return NextResponse.json({ success: true, draft: saved.draft, model: saved.model, costUsd: 0, cached: true, runs: saved.runs, savedAt: saved.createdAt });
    }
    const results = await Promise.all(Array.from({ length: RUNS }, () => runAnalysis(docs, notes)));
    const ok = results.flatMap((r) => (r.success ? [r] : []));
    if (ok.length === 0) {
      const failed = results.find((r) => !r.success);
      return NextResponse.json(failed ?? { success: false, error: "Could not analyse the documents." }, { status: 502 });
    }
    const rates = getRateCard();
    const draft = stableDraft(ok.map((r) => r.draft), (page) => defaultSections(page, rates));
    const costUsd = Number(ok.reduce((sum, r) => sum + r.costUsd, 0).toFixed(4));
    // A result from fewer readings than a majority needs is not kept: the next try should not be stuck with it.
    const reliable = ok.length >= Math.min(RUNS, needed(RUNS));
    if (reliable) saveAnalysis(key, { draft, model: ok[0].model, costUsd, runs: ok.length });
    return NextResponse.json({ success: true, draft, model: ok[0].model, costUsd, cached: false, runs: ok.length, requested: RUNS, ...(reliable ? {} : { partial: true }) });
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

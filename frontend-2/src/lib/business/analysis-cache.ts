import { createHash } from "node:crypto";

import { ANALYSIS_VERSION } from "./analysis-stable";
import { getDb } from "./db";
import type { RequirementDraft } from "./types";

/**
 * Server-only. A saved analysis per set of documents. The key is the CONTENT of the files and the notes (not the file names or
 * their order), so uploading the same document again, renamed or in another order, finds the same result and the same estimate.
 * It also changes when the analysis rules change (ANALYSIS_VERSION), so an old result is never reused after a fix.
 */

const KEEP = 300;

export function analysisKey(docs: { data: string }[], notes: string): string {
  const parts = docs.map((d) => createHash("sha256").update(Buffer.from(d.data, "base64")).digest("hex")).sort();
  // Notes are compared the way a person would: extra spaces and capital letters do not make a different note.
  const note = notes.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(JSON.stringify([ANALYSIS_VERSION, parts, note])).digest("hex");
}

export type SavedAnalysis = { draft: RequirementDraft; model: string; costUsd: number; runs: number; createdAt: string };

export function getSavedAnalysis(key: string): SavedAnalysis | null {
  const row = getDb().prepare("SELECT draft, model, cost_usd AS costUsd, runs, created_at AS createdAt FROM analysis_cache WHERE key = ?").get(key) as
    | { draft: string; model: string; costUsd: number; runs: number; createdAt: string }
    | undefined;
  if (!row) return null;
  try {
    return { draft: JSON.parse(row.draft) as RequirementDraft, model: row.model, costUsd: row.costUsd, runs: row.runs, createdAt: row.createdAt };
  } catch {
    return null;
  }
}

export function saveAnalysis(key: string, value: Omit<SavedAnalysis, "createdAt">): void {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO analysis_cache (key, draft, model, cost_usd, runs, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(key, JSON.stringify(value.draft), value.model, value.costUsd, value.runs, new Date().toISOString());
  // Old entries are dropped so the table never grows without limit.
  db.prepare("DELETE FROM analysis_cache WHERE key NOT IN (SELECT key FROM analysis_cache ORDER BY created_at DESC LIMIT ?)").run(KEEP);
}

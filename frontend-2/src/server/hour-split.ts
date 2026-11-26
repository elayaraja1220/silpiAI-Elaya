// Hour split suggestions (server only). Asks an AI how the quotation's hours might be shared between roles, falls back to a plain rule, and records the suggestion.
// It reads a quotation and writes ONLY to quotation_hour_estimates and the audit log: it never changes a quotation, an hour total or a price.
import { getDb } from "@/lib/business/db";
import { DEFAULT_RATE_CARD } from "@/lib/business/rate-card";
import { normaliseSplit, parseSplitAnswer, ruleSplit, splitPrompt, totalHoursOf, type HourSplit, type SplitLine } from "@/lib/business/hour-split";
import { StageError } from "@/lib/business/store";
import type { Quotation } from "@/lib/business/types";
import { ValidationError } from "@/lib/business/validate";
import { listModels } from "@/server/ai/catalog";
import { defaultProviders, type ProviderResult } from "@/server/ai/providers";
import { recordAudit } from "@/server/audit";

export type HourEstimate = {
  id: number;
  leadId: string;
  quotationId: string;
  totalHours: number;
  lines: SplitLine[];
  source: "rule" | "ai";
  model: string;
  reason: string;
  /** Why the rule was used instead of an AI (empty when an AI answered). */
  aiNote: string;
  inputTokens: number;
  outputTokens: number;
  status: "suggested" | "accepted" | "dismissed";
  createdBy: string;
  createdAt: string;
  decidedBy: string;
  decidedAt: string;
};

/** Asks a model for text. Injected in tests; by default it uses the first enabled, configured fast model. */
export type SplitAsk = (system: string, user: string) => Promise<{ text: string; model: string; inputTokens: number; outputTokens: number } | { unavailable: string }>;

export const askConfiguredModel: SplitAsk = async (system, user) => {
  const providers = defaultProviders();
  const model = listModels({ enabledOnly: true }).find((m) => m.tier === "fast" && providers[m.provider]?.isConfigured());
  if (!model) return { unavailable: "No AI model is switched on and configured for this, so the default rule was used." };
  try {
    const r: ProviderResult = await providers[model.provider]!.complete({ providerModel: model.providerModel, system, messages: [{ role: "user", content: user }], maxOutputTokens: 600, signal: AbortSignal.timeout(30_000) });
    return { text: r.text, model: model.id, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
  } catch (e) {
    return { unavailable: `The AI did not answer (${(e as Error).message.slice(0, 120)}), so the default rule was used.` };
  }
};

type Row = { id: number; lead_id: string; quotation_id: string; total_hours: number; split: string; source: "rule" | "ai"; model: string; reason: string; ai_note: string; input_tokens: number; output_tokens: number; status: HourEstimate["status"]; created_by: string; created_at: string; decided_by: string; decided_at: string };
const toEstimate = (r: Row): HourEstimate => ({ id: r.id, leadId: r.lead_id, quotationId: r.quotation_id, totalHours: r.total_hours, lines: JSON.parse(r.split) as SplitLine[], source: r.source, model: r.model, reason: r.reason, aiNote: r.ai_note, inputTokens: r.input_tokens, outputTokens: r.output_tokens, status: r.status, createdBy: r.created_by, createdAt: r.created_at, decidedBy: r.decided_by, decidedAt: r.decided_at });

export function listEstimates(leadId: string): HourEstimate[] {
  return (getDb().prepare("SELECT * FROM quotation_hour_estimates WHERE lead_id = ? ORDER BY id DESC").all(leadId) as Row[]).map(toEstimate);
}

function latestQuotation(leadId: string): Quotation | null {
  const row = getDb().prepare("SELECT data FROM quotations WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(leadId) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Quotation) : null;
}

/** Makes a suggestion for the lead's current quotation and records it. The quotation is read, never written. */
export async function suggestSplit(leadId: string, by: string, ask: SplitAsk = askConfiguredModel): Promise<HourEstimate> {
  const q = latestQuotation(leadId);
  if (!q) throw new StageError("There is no quotation to split the hours of.");
  const total = totalHoursOf(q);
  if (!(total > 0)) throw new ValidationError("This quotation has no hours to share between roles.");
  const { system, user } = splitPrompt(q, total);

  let split: HourSplit | null = null;
  let model = "";
  let aiNote = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const answer = await ask(system, user);
  if ("unavailable" in answer) aiNote = answer.unavailable;
  else {
    inputTokens = answer.inputTokens;
    outputTokens = answer.outputTokens;
    const parsed = parseSplitAnswer(answer.text);
    const lines = parsed ? normaliseSplit(parsed.lines, total) : null;
    if (parsed && lines) {
      split = { totalHours: total, lines, source: "ai", reason: parsed.reason };
      model = answer.model;
    } else aiNote = "The AI's answer could not be used (it was not a valid split), so the default rule was used.";
  }
  if (!split) split = ruleSplit({ projectType: q.requirement?.projectType ?? "business-website", modules: q.requirement?.modules ?? [] }, DEFAULT_RATE_CARD, total);
  if (!split) throw new ValidationError("A split could not be made for this quotation.");

  const at = new Date().toISOString();
  const info = getDb()
    .prepare("INSERT INTO quotation_hour_estimates (lead_id, quotation_id, total_hours, split, source, model, reason, ai_note, input_tokens, output_tokens, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(leadId, q.id, total, JSON.stringify(split.lines), split.source, model, split.reason, aiNote, inputTokens, outputTokens, by.slice(0, 200), at);
  recordAudit({ actor: by, action: "hours.split_suggested", entityType: "quotation", entityId: q.number, detail: { source: split.source, model, totalHours: total, estimateId: Number(info.lastInsertRowid) } });
  return toEstimate(getDb().prepare("SELECT * FROM quotation_hour_estimates WHERE id = ?").get(Number(info.lastInsertRowid)) as Row);
}

/** Records the team's decision on a suggestion. Accepting a split records the planned staffing; it changes no hours and no price. */
export function decideSplit(leadId: string, id: number, status: "accepted" | "dismissed", by: string): HourEstimate {
  const db = getDb();
  const row = db.prepare("SELECT * FROM quotation_hour_estimates WHERE id = ? AND lead_id = ?").get(id, leadId) as Row | undefined;
  if (!row) throw new StageError("That suggestion does not exist.");
  if (row.status !== "suggested") throw new StageError(`This suggestion was already ${row.status}. Ask for a new one.`);
  db.prepare("UPDATE quotation_hour_estimates SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(status, by.slice(0, 200), new Date().toISOString(), id);
  recordAudit({ actor: by, action: `hours.split_${status}`, entityType: "hour_estimate", entityId: id, detail: { leadId } });
  return toEstimate(db.prepare("SELECT * FROM quotation_hour_estimates WHERE id = ?").get(id) as Row);
}

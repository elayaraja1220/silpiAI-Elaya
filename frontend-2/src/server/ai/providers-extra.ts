import { ProviderError, type ProviderAdapter } from "./providers";

/** More provider adapters, in their own file so providers.ts stays the small interface plus the first adapters. Server only. */

const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** A failed HTTP answer becomes a ProviderError (temporary: 408, 409, 429, 5xx; permanent: the rest). */
async function failedAnswer(response: Response): Promise<never> {
  const detail = (await response.text().catch(() => "")).slice(0, 300);
  throw new ProviderError(`Provider answered ${response.status}: ${detail}`, [408, 409, 429].includes(response.status) || response.status >= 500, response.status);
}

/** The provider's numeric usage fields, flattened ("prompt_tokens_details.cached_tokens"), never any content. */
const numericUsage = (u: Record<string, unknown>, prefix = "", into: Record<string, number> = {}): Record<string, number> => {
  for (const [k, v] of Object.entries(u)) {
    const n = count(v);
    if (n !== null) into[prefix + k] = n;
    else if (v && typeof v === "object" && !Array.isArray(v)) numericUsage(v as Record<string, unknown>, `${prefix}${k}.`, into);
  }
  return into;
};

/**
 * OpenAI Chat Completions. Key from OPENAI_API_KEY (server only). OpenAI counts cached tokens INSIDE prompt_tokens, so they are taken out of the input count
 * and reported apart (the gateway prices them at the cache-read price). Reasoning tokens are inside completion_tokens, which is how OpenAI bills them.
 */
export const openaiAdapter: ProviderAdapter = {
  id: "openai",
  isConfigured: () => !!process.env.OPENAI_API_KEY?.trim(),
  async complete(req) {
    let response: Response;
    try {
      response = await fetch(`${process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com"}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY!.trim()}` },
        body: JSON.stringify({ model: req.providerModel, max_completion_tokens: req.maxOutputTokens, messages: [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages] }),
        signal: req.signal,
      });
    } catch (e) {
      throw new ProviderError(`Network or timeout: ${(e as Error).message}`, true);
    }
    if (!response.ok) return failedAnswer(response);
    const body = (await response.json().catch(() => null)) as { id?: string; choices?: { message?: { content?: unknown } }[]; usage?: Record<string, unknown> } | null;
    if (!body || !Array.isArray(body.choices) || body.choices.length === 0) throw new ProviderError("The provider's answer had no readable content.", false);
    const content = body.choices[0]!.message?.content;
    const text = typeof content === "string" ? content : "";
    const u = body.usage ?? {};
    const raw = numericUsage(u);
    const prompt = count(u.prompt_tokens);
    const completion = count(u.completion_tokens);
    const cached = count((u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens) ?? 0;
    // Missing or contradictory usage: the work was done and will be billed, so keep the answer and let the gateway price it from its own estimate.
    if (prompt === null || completion === null || cached > prompt) return { text, inputTokens: 0, outputTokens: 0, usageMissing: true, raw, providerRequestId: body.id ?? null };
    return { text, inputTokens: prompt - cached, outputTokens: completion, cacheReadTokens: cached, cacheWriteTokens: 0, raw, providerRequestId: body.id ?? null };
  },
};

/**
 * Google Gemini generateContent. Key from GEMINI_API_KEY, sent in a header (never in the URL, so it cannot end up in a log). Gemini counts cached tokens inside
 * promptTokenCount (taken out here) and "thinking" tokens APART from candidatesTokenCount although it bills them as output (added back here).
 */
export const geminiAdapter: ProviderAdapter = {
  id: "gemini",
  isConfigured: () => !!process.env.GEMINI_API_KEY?.trim(),
  async complete(req) {
    // The model name goes into the URL path: only plain names are allowed, so a stored name can never redirect the request.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(req.providerModel)) throw new ProviderError("The model name is not a valid Gemini model name.", false);
    let response: Response;
    try {
      response = await fetch(`${process.env.GEMINI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com"}/v1beta/models/${req.providerModel}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY!.trim() },
        body: JSON.stringify({
          ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
          contents: req.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens: req.maxOutputTokens },
        }),
        signal: req.signal,
      });
    } catch (e) {
      throw new ProviderError(`Network or timeout: ${(e as Error).message}`, true);
    }
    if (!response.ok) return failedAnswer(response);
    const body = (await response.json().catch(() => null)) as { responseId?: string; candidates?: { content?: { parts?: { text?: unknown; thought?: unknown }[] } }[]; promptFeedback?: { blockReason?: string }; usageMetadata?: Record<string, unknown> } | null;
    if (!body) throw new ProviderError("The provider's answer had no readable content.", false);
    const parts = body.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) throw new ProviderError(body.promptFeedback?.blockReason ? `The provider blocked the request (${body.promptFeedback.blockReason}).` : "The provider's answer had no readable content.", false);
    const text = parts.filter((p) => p.thought !== true).map((p) => (typeof p.text === "string" ? p.text : "")).join("");
    const u = body.usageMetadata ?? {};
    const raw = numericUsage(u);
    const prompt = count(u.promptTokenCount);
    const candidates = count(u.candidatesTokenCount);
    const thoughts = count(u.thoughtsTokenCount) ?? 0;
    const cached = count(u.cachedContentTokenCount) ?? 0;
    if (prompt === null || candidates === null || cached > prompt) return { text, inputTokens: 0, outputTokens: 0, usageMissing: true, raw, providerRequestId: body.responseId ?? null };
    return { text, inputTokens: prompt - cached, outputTokens: candidates + thoughts, cacheReadTokens: cached, cacheWriteTokens: 0, raw, providerRequestId: body.responseId ?? null };
  },
};

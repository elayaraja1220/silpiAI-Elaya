/**
 * Provider adapters. The gateway talks to every AI company through this one small interface, so adding or replacing a
 * provider is one new adapter and a row in ai_models: nothing else changes. Server only.
 */

export type ChatMessage = { role: "user" | "assistant"; content: string };
export type ProviderRequest = { providerModel: string; system?: string; messages: ChatMessage[]; maxOutputTokens: number; signal?: AbortSignal };
/**
 * What a provider returns. Token counts are the provider's own. Cached tokens are counted APART from inputTokens. If the provider did not
 * report usage at all, usageMissing is true and the gateway prices the request from its own estimate instead of guessing here.
 * raw holds only the provider's numeric usage fields, never any content.
 */
export type ProviderResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  otherChargesMicroUsd?: number;
  usageMissing?: boolean;
  raw?: Record<string, number>;
  providerRequestId: string | null;
};

const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** retryable: worth trying again (rate limit, overload, network, timeout). Otherwise the request itself is the problem. */
export class ProviderError extends Error {
  retryable: boolean;
  status: number | null;
  constructor(message: string, retryable: boolean, status: number | null = null) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
    this.status = status;
  }
}

export interface ProviderAdapter {
  id: string;
  /** False when its key is missing: the gateway never reserves credits for a model whose provider cannot answer. */
  isConfigured(): boolean;
  complete(request: ProviderRequest): Promise<ProviderResult>;
}

/** Anthropic Messages API. The key is read from ANTHROPIC_API_KEY on the server and is never sent anywhere else. */
export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  isConfigured: () => !!process.env.ANTHROPIC_API_KEY?.trim(),
  async complete(req) {
    let response: Response;
    try {
      response = await fetch(`${process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!.trim(), "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: req.providerModel, max_tokens: req.maxOutputTokens, ...(req.system ? { system: req.system } : {}), messages: req.messages }),
        signal: req.signal,
      });
    } catch (e) {
      throw new ProviderError(`Network or timeout: ${(e as Error).message}`, true);
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      // 408 timeout, 409 conflict, 429 rate limit, 5xx and 529 (overloaded) are temporary; 400/401/403/404 are not.
      throw new ProviderError(`Provider answered ${response.status}: ${detail}`, [408, 409, 429].includes(response.status) || response.status >= 500, response.status);
    }
    const body = (await response.json().catch(() => null)) as { id?: string; content?: { type: string; text?: string }[]; usage?: Record<string, unknown> } | null;
    if (!body || !Array.isArray(body.content)) throw new ProviderError("The provider's answer had no readable content.", false);
    const text = body.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    const u = body.usage ?? {};
    const input = count(u.input_tokens);
    const output = count(u.output_tokens);
    const raw: Record<string, number> = {};
    for (const [k, v] of Object.entries(u)) { const n = count(v); if (n !== null) raw[k] = n; }
    // Content arrived but the usage is missing or unreadable: the work was done and the provider will bill it, so do not throw the answer away.
    // The gateway prices it from its own estimate and records that it did.
    if (input === null || output === null) return { text, inputTokens: 0, outputTokens: 0, usageMissing: true, raw, providerRequestId: body.id ?? null };
    return { text, inputTokens: input, outputTokens: output, cacheReadTokens: count(u.cache_read_input_tokens) ?? 0, cacheWriteTokens: count(u.cache_creation_input_tokens) ?? 0, raw, providerRequestId: body.id ?? null };
  },
};

/** The free built-in "demo" model: answers locally without any provider, so a fresh install can be tried at no cost. */
export const echoAdapter: ProviderAdapter = {
  id: "echo",
  isConfigured: () => true,
  async complete(req) {
    const last = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    // Demo mode for the project builder: fixed, free answers so the whole flow can be tried without any provider.
    const sys = req.system ?? "";
    const canned = sys.includes("SILPI_JOB_PLAN")
      ? JSON.stringify({ summary: "Demo plan: a small static page (no AI model was used).", files: [{ path: "index.html", purpose: "The page", complexity: "low" }, { path: "styles.css", purpose: "Styling", complexity: "low" }, { path: "app.js", purpose: "Behaviour", complexity: "high" }] })
      : sys.includes("SILPI_JOB_FILE")
        ? `/* Demo file (no AI model was used): ${/File to write: (.+)/.exec(last)?.[1] ?? "file"} */\n`
        : sys.includes("SILPI_JOB_REVIEW")
          ? "Demo review: no real review was performed because no AI model was used."
          : null;
    if (canned !== null) return { text: canned, inputTokens: Math.ceil(last.length / 4), outputTokens: Math.ceil(canned.length / 4), providerRequestId: null };
    const text = `Demo reply (no AI model was called). You wrote ${last.length} characters:\n\n"${last.slice(0, 400)}${last.length > 400 ? "..." : ""}"\n\nChoose Fast, Balanced or Best, and connect a provider key, to get real answers.`;
    return { text, inputTokens: Math.ceil(last.length / 4), outputTokens: Math.ceil(text.length / 4), providerRequestId: null };
  },
};

export const defaultProviders = (): Record<string, ProviderAdapter> => ({ anthropic: anthropicAdapter, echo: echoAdapter });

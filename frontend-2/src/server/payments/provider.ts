/**
 * The payment-provider interface (server only). Everything the platform knows about a provider is here; the rest of the billing code only sees
 * these normalized shapes, so connecting Razorpay, Stripe or any other provider means writing one adapter that implements `PaymentProvider`,
 * not touching billing. No real provider is connected yet: only "manual" (the administrator records a payment by hand) exists.
 */

/** What a payment is for. Our own ids travel through the provider (as metadata) and come back on the notice. */
export type PaymentTarget = { kind: "invoice"; invoiceId: string } | { kind: "topup"; topupId: string };

/** A provider's notice, reduced to the few things billing cares about. An adapter turns its own event names into these. */
export type PaymentEvent =
  | { type: "payment.succeeded"; eventId: string; providerPaymentId: string; target: PaymentTarget; amountMinor: number; currency: string }
  | { type: "payment.failed"; eventId: string; providerPaymentId: string; target: PaymentTarget; reason: string }
  | { type: "refund.succeeded"; eventId: string; providerPaymentId: string; providerRefundId: string; amountMinor: number; reason?: string }
  | { type: "dispute.opened" | "dispute.won" | "dispute.lost"; eventId: string; providerPaymentId: string }
  /** A notice about something billing does not act on: recorded, not applied. */
  | { type: "ignored"; eventId: string; original: string };

/** A webhook that must be answered with an error status (bad signature, unknown provider, bad body). */
export class WebhookError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "WebhookError";
    this.status = status;
  }
}

export interface PaymentProvider {
  id: string;
  label: string;
  /** False while its credentials are missing: nothing is offered through it and its webhook address answers "not found". */
  isConfigured(): boolean;
  /**
   * Checks the signature of a notice and turns it into events. Receives the RAW body text and the request headers (lower-case names).
   * Must throw WebhookError(401) when the signature is wrong or too old, and WebhookError(400) when the body cannot be read. Never trusts a body it has not verified.
   */
  parseWebhook?(rawBody: string, headers: Record<string, string>): PaymentEvent[];
  /** Sends a refund to the provider. Absent for a provider that cannot, or one (manual) where the money is returned outside the system. */
  refund?(input: { providerPaymentId: string; amountMinor: number; currency: string; reason: string; idempotencyKey: string }): Promise<{ providerRefundId: string | null }>;
}

/** The administrator took the money outside the system (UPI, bank transfer, cash) and records it by hand. It has no webhook and returns money outside the system too. */
export const manualProvider: PaymentProvider = { id: "manual", label: "Recorded by the administrator", isConfigured: () => true };

const registry = (): Map<string, PaymentProvider> => {
  const g = globalThis as { silpiPaymentProviders?: Map<string, PaymentProvider> };
  if (!g.silpiPaymentProviders) g.silpiPaymentProviders = new Map([[manualProvider.id, manualProvider]]);
  return g.silpiPaymentProviders;
};

/** Makes a provider available. Called once at start-up by the code that knows its credentials. */
export function registerPaymentProvider(provider: PaymentProvider): void {
  if (!/^[a-z][a-z0-9_-]{1,30}$/.test(provider.id)) throw new Error("A payment provider id is 2 to 31 lowercase letters, digits, dashes or underscores.");
  if (provider.id === manualProvider.id) throw new Error('The "manual" provider is built in.');
  registry().set(provider.id, provider);
}
export function unregisterPaymentProvider(id: string): void {
  if (id !== manualProvider.id) registry().delete(id);
}
export const getPaymentProvider = (id: string): PaymentProvider | null => registry().get(id) ?? null;
export const listPaymentProviders = (): { id: string; label: string; configured: boolean; webhook: boolean }[] =>
  [...registry().values()].map((p) => ({ id: p.id, label: p.label, configured: p.isConfigured(), webhook: typeof p.parseWebhook === "function" }));

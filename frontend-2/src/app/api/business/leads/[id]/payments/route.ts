import { NextRequest } from "next/server";

import { handle, notFound } from "@/lib/business/http";
import { getLead, recordPayment, stageHistory } from "@/lib/business/store";
import { PAYMENT_KINDS, PAYMENT_MODES, type PaymentKind, type PaymentMode } from "@/lib/business/types";
import { ValidationError } from "@/lib/business/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/business/leads/:id/payments - record money received (UPI, bank, cash...). */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("PAYMENT", async () => {
    const b = (await request.json()) as Record<string, unknown>;
    const amount = Math.round(Number(b.amount) * 100) / 100;
    const receivedOn = typeof b.receivedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.receivedOn) ? b.receivedOn : "";
    if (!PAYMENT_KINDS.includes(b.kind as PaymentKind)) throw new ValidationError("Choose advance or balance.");
    if (!PAYMENT_MODES.includes(b.mode as PaymentMode)) throw new ValidationError("Choose how it was paid.");
    if (!Number.isFinite(amount) || amount <= 0) throw new ValidationError("Enter the amount received.");
    if (!receivedOn || new Date(receivedOn).getTime() > Date.now() + 86_400_000) throw new ValidationError("Enter the date the money was received.");
    const reference = typeof b.reference === "string" ? b.reference.trim().slice(0, 80) : "";
    if (b.mode !== "cash" && !reference) throw new ValidationError("Enter the UPI / bank reference number so it can be matched later.");
    const lead = recordPayment(id, { kind: b.kind as PaymentKind, amount, mode: b.mode as PaymentMode, reference, receivedOn });
    return { lead, history: stageHistory(id) };
  });
}

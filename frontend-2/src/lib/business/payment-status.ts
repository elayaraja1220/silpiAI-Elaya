import type { Payment, Quotation } from "./types";

/** How much of the advance and balance is due and received. Pure; used by server and screens. */
export function paymentStatus(quotation: Quotation | undefined, payments: Payment[]) {
  const advanceDue = quotation?.schedule[0]?.amount ?? 0;
  const balanceDue = quotation?.schedule[1]?.amount ?? 0;
  const sum = (kind: Payment["kind"]) => Math.round(payments.filter((p) => p.kind === kind).reduce((s, p) => s + p.amount, 0) * 100) / 100;
  const advancePaid = sum("advance");
  const balancePaid = sum("balance");
  return {
    advanceDue,
    advancePaid,
    advanceRemaining: Math.max(0, Math.round((advanceDue - advancePaid) * 100) / 100),
    balanceDue,
    balancePaid,
    balanceRemaining: Math.max(0, Math.round((balanceDue - balancePaid) * 100) / 100),
  };
}

/** UPI deep link: opens GPay / PhonePe / Paytm on a phone with the amount filled in. */
export function upiLink(upiId: string, payee: string, amount: number, note: string): string {
  const params = new URLSearchParams({ pa: upiId, pn: payee.slice(0, 50), am: amount.toFixed(2), cu: "INR", tn: note.slice(0, 50) });
  return `upi://pay?${params.toString()}`;
}

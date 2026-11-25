"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { CURRENCY_CODES, CURRENCY_INFO, formatAmount, type CurrencyCode } from "@/lib/currencies";
import { api, Button, Card, credits, inputClass, Notice, Pill } from "./light";

type Refund = { id: string; amountMinor: number; reason: string; status: string; creditsReversedUnits: number; creditsUnrecoveredUnits: number; createdAt: string };
type Payment = { id: string; orgId: string; provider: string; purpose: string; currency: string; amountMinor: number; status: string; failureReason: string | null; refundedMinor: number; createdAt: string; refunds: Refund[] };
type Pack = { id: string; name: string; creditUnits: number; active: boolean; prices: { currency: string; amountMinor: number }[] };
type Provider = { id: string; label: string; webhook: boolean; configured: boolean };
type Hook = { id: number; provider: string; eventId: string; type: string; status: string; error: string | null; receivedAt: string };

const fmt = (minor: number, c: string) => formatAmount(minor, c as CurrencyCode);
const exponent = (c: string) => CURRENCY_INFO[c as CurrencyCode]?.exponent ?? 2;
const toMinor = (text: string, c: string) => Math.round(Number(text) * 10 ** exponent(c));
const tone = (s: string): "green" | "red" | "amber" | "slate" => (s === "succeeded" || s === "processed" ? "green" : s === "failed" ? "red" : s === "pending" || s === "ignored" ? "slate" : "amber");

/** Payments: money received (recorded by hand or reported by a provider), refunds, and the audit trail of provider notices. */
export function PaymentsAdmin({ onNote, onError }: { onNote: (m: string) => void; onError: (e: unknown) => void }) {
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [hooks, setHooks] = useState<{ providers: Provider[]; events: Hook[] } | null>(null);
  const load = useCallback(() => {
    api<{ payments: Payment[] }>("/api/admin/payments").then((r) => setPayments(r.payments)).catch(onError);
    api<{ providers: Provider[]; events: Hook[] }>("/api/admin/webhook-events?limit=15").then(setHooks).catch(onError);
  }, [onError]);
  useEffect(load, [load]);
  const done = (m: string) => { onNote(m); load(); };
  return (
    <div className="space-y-5">
      <RecordPayment onDone={done} onError={onError} />
      <PaymentList payments={payments} onDone={done} onError={onError} />
      <Packs onNote={onNote} onError={onError} />
      <Hooks data={hooks} />
    </div>
  );
}

function RecordPayment({ onDone, onError }: { onDone: (m: string) => void; onError: (e: unknown) => void }) {
  const [kind, setKind] = useState<"invoiceId" | "topupId">("invoiceId");
  const [target, setTarget] = useState("");
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { [kind]: target.trim(), reference: reference.trim() };
      if (amount) body.amountMinor = Math.round(Number(amount));
      await api("/api/admin/payments/record", { method: "POST", body });
      setTarget(""); setReference(""); setAmount("");
      onDone("Payment recorded. The plan or credits are now active.");
    } catch (e) { onError(e); } finally { setBusy(false); }
  };
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Record a payment received</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">For money that arrived outside the system (UPI, bank transfer, cash). Credits and plans are given only when you record the payment. The same reference twice changes nothing. The amount is optional; when given (in the smallest unit, e.g. cents or paise) it must match the invoice or order.</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">For<select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className={inputClass + " mt-1 block !w-40"} aria-label="Payment is for"><option value="invoiceId">Plan invoice</option><option value="topupId">Credit top-up</option></select></label>
        <label className="text-xs text-slate-600">{kind === "invoiceId" ? "Invoice id" : "Top-up id"}<input value={target} onChange={(e) => setTarget(e.target.value)} className={inputClass + " mt-1 block !w-56"} aria-label="Invoice or top-up id" /></label>
        <label className="text-xs text-slate-600">Reference<input value={reference} onChange={(e) => setReference(e.target.value)} className={inputClass + " mt-1 block !w-48"} placeholder="UPI / bank reference" aria-label="Payment reference" /></label>
        <label className="text-xs text-slate-600">Amount (optional)<input value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} inputMode="numeric" className={inputClass + " mt-1 block !w-28"} aria-label="Amount in smallest unit" /></label>
        <Button onClick={() => void go()} disabled={busy || !target.trim() || reference.trim().length < 3}>{busy && <Loader2 size={15} className="animate-spin" />} Record</Button>
      </div>
    </Card>
  );
}

function PaymentList({ payments, onDone, onError }: { payments: Payment[] | null; onDone: (m: string) => void; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  if (!payments) return <Card className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Loading payments...</Card>;
  const refund = async (p: Payment) => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { paymentId: p.id, reason: reason.trim(), idempotencyKey: `ui-${p.id}-${Date.now()}` };
      if (amount) body.amountMinor = toMinor(amount, p.currency);
      await api("/api/admin/payments/refund", { method: "POST", body });
      setOpen(null); setAmount(""); setReason("");
      onDone("Refund recorded. Unspent credits from that payment were taken back.");
    } catch (e) { onError(e); } finally { setBusy(false); }
  };
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Payments</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">Newest first. A refund returns money in proportion and takes back the same share of the credits that payment bought, as far as they are unspent. For the manual method, return the money yourself; this only records it.</p>
      </div>
      {payments.length === 0 ? <p className="text-sm text-slate-500">No payments yet.</p> : (
        <ul className="divide-y divide-slate-100">
          {payments.map((p) => {
            const left = p.amountMinor - p.refundedMinor;
            const canRefund = (p.status === "succeeded" || p.status === "partially_refunded") && left > 0;
            return (
              <li key={p.id} className="space-y-2 py-2.5 text-sm">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-semibold tabular-nums text-slate-900">{fmt(p.amountMinor, p.currency)}</span>
                  <Pill tone={tone(p.status)}>{p.status.replace("_", " ")}</Pill>
                  <span className="text-xs text-slate-500">{p.purpose === "topup" ? "credit top-up" : "plan invoice"} · {p.provider} · {p.orgId} · {p.createdAt.slice(0, 10)}</span>
                  {p.refundedMinor > 0 && <span className="text-xs text-slate-500">refunded {fmt(p.refundedMinor, p.currency)}</span>}
                  {canRefund && <Button variant="ghost" className="ml-auto px-3 py-1.5" onClick={() => { setOpen(open === p.id ? null : p.id); setAmount(""); setReason(""); }}>Refund</Button>}
                </div>
                {p.failureReason && <p className="text-xs text-amber-700">{p.failureReason}</p>}
                {p.refunds.map((r) => <p key={r.id} className="text-xs text-slate-500">Refund {fmt(r.amountMinor, p.currency)} · {r.reason} · {credits(r.creditsReversedUnits)} credits taken back{r.creditsUnrecoveredUnits > 0 ? `, ${credits(r.creditsUnrecoveredUnits)} already spent` : ""} <Pill tone={tone(r.status)}>{r.status}</Pill></p>)}
                {open === p.id && (
                  <div className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <label className="text-xs text-slate-600">Amount (blank = all {fmt(left, p.currency)} left)<input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} className={inputClass + " mt-1 block !w-40"} aria-label="Refund amount" /></label>
                    <label className="text-xs text-slate-600">Reason<input value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass + " mt-1 block !w-64"} aria-label="Refund reason" /></label>
                    <Button onClick={() => void refund(p)} disabled={busy || reason.trim().length < 3}>{busy && <Loader2 size={15} className="animate-spin" />} Confirm refund</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function Packs({ onNote, onError }: { onNote: (m: string) => void; onError: (e: unknown) => void }) {
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const load = useCallback(() => { api<{ packages: Pack[] }>("/api/admin/credit-packages").then((r) => setPacks(r.packages)).catch(onError); }, [onError]);
  useEffect(load, [load]);
  if (!packs) return null;
  const saved = (m: string) => { onNote(m); setEdit({}); load(); };
  const save = (id: string, currency: string) => api("/api/admin/credit-packages/prices", { method: "PUT", body: { packageId: id, currency, amountMinor: edit[`${id}:${currency}`] === "" ? null : toMinor(edit[`${id}:${currency}`]!, currency) } }).then(() => saved("Pack price saved. Orders already made keep their price.")).catch(onError);
  const toggle = (p: Pack) => api("/api/admin/credit-packages", { method: "PUT", body: { id: p.id, active: !p.active } }).then(() => saved(p.active ? "Pack switched off." : "Pack switched on.")).catch(onError);
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Credit packs</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">Extra credits customers can buy at any time. Prices are in each currency&apos;s own units. A price change reaches new orders only. A pack is sold only in currencies that have a price.</p>
      </div>
      <ul className="divide-y divide-slate-100">
        {packs.map((p) => (
          <li key={p.id} className="space-y-2 py-2.5">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-semibold text-slate-900">{p.name}</span>
              <span className="tabular-nums text-slate-600">{credits(p.creditUnits)} credits</span>
              {!p.active && <Pill tone="red">off sale</Pill>}
              <Button variant="ghost" className="ml-auto px-3 py-1.5" onClick={() => void toggle(p)}>{p.active ? "Switch off" : "Switch on"}</Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {CURRENCY_CODES.map((c) => {
                const key = `${p.id}:${c}`;
                const current = p.prices.find((x) => x.currency === c)?.amountMinor ?? null;
                const shown = edit[key] ?? (current === null ? "" : String(current / 10 ** exponent(c)));
                return (
                  <label key={c} className="text-xs text-slate-500">{c}
                    <span className="mt-1 flex gap-1">
                      <input value={shown} onChange={(e) => setEdit({ ...edit, [key]: e.target.value.replace(/[^\d.]/g, "") })} className={inputClass + " w-24"} aria-label={`${p.name} price in ${c}`} />
                      {edit[key] !== undefined && <Button variant="ghost" className="px-2 py-1" onClick={() => void save(p.id, c)}>Save</Button>}
                    </span>
                  </label>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Hooks({ data }: { data: { providers: Provider[]; events: Hook[] } | null }) {
  if (!data) return null;
  const live = data.providers.filter((p) => p.webhook);
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Payment providers and notices</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">Providers send a signed notice when money arrives or is returned. Each notice is stored once, so a repeat does nothing. Providers: {data.providers.map((p) => `${p.label}${p.webhook ? "" : " (manual)"}`).join(", ")}.</p>
      </div>
      {live.length === 0 && <Notice tone="slate">No online payment provider is connected yet. Payments are recorded by hand above. Razorpay and Stripe can be connected later, once the accounts exist.</Notice>}
      {data.events.length === 0 ? <p className="text-sm text-slate-500">No notices received yet.</p> : (
        <ul className="divide-y divide-slate-100 text-xs">
          {data.events.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2 py-2">
              <Pill tone={tone(e.status)}>{e.status}</Pill>
              <span className="font-medium text-slate-800">{e.type}</span>
              <span className="text-slate-500">{e.provider} · {e.receivedAt.slice(0, 19).replace("T", " ")}</span>
              {e.error && <span className="text-rose-600">{e.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

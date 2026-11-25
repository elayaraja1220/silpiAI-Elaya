"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { formatAmount, isCurrency } from "@/lib/currencies";
import { api, Button, Card, credits, inputClass, Notice, Pill, Stat } from "./light";

type ByCurrency = Record<string, number>;
type Money = { received: ByCurrency; refunded: ByCurrency; net: ByCurrency };
type AiLine = { key: string; requests: number; failed: number; fallbacks: number; providerCostMicroUsd: number; chargedUnits: number; billedMicroUsd: number; uncollectedUnits: number };
type Consolidated = { currency: string; total: number; missing: string[]; ratesFrom: string | null };
type Finance = {
  month: { label: string };
  inUsd: { netThisMonth: Consolidated; netLastMonth: Consolidated; netAllTime: Consolidated; mrr: Consolidated; mrrAtRisk: Consolidated; openInvoices: Consolidated };
  unitsPerUsd: number;
  revenue: { thisMonth: Money; lastMonth: Money; allTime: Money; topupsThisMonth: { orders: number; value: ByCurrency } };
  subscriptions: { activePaid: number; pastDue: number; inTrial: number; free: number; cancelling: number; endedThisMonth: number; mrr: ByCurrency; mrrAtRisk: ByCurrency; byPlan: { planId: string; name: string; count: number }[]; openInvoices: { count: number; value: ByCurrency } };
  credits: { outstandingUnits: number; outstandingValueMicroUsd: number; byCategory: { category: string; units: number }[]; grantedThisMonthUnits: number; spentThisMonthUnits: number };
  ai: { thisMonth: AiLine; lastMonth: AiLine; byProvider: AiLine[]; byModel: AiLine[]; daily: { date: string; requests: number; providerCostMicroUsd: number; billedMicroUsd: number }[] };
  health: { walletMismatches: number; bucketMismatches: number; failedNoticesLast7Days: number; duplicatePaymentsToRefund: number; creditsNotRecoveredOnRefundUnits: number; stuckAiRequests: number; unchargedAiUnits: number };
};

const money = (m: ByCurrency): string => {
  const parts = Object.entries(m).filter(([, n]) => n !== 0).map(([c, n]) => (isCurrency(c) ? formatAmount(n, c) : `${n} ${c}`));
  return parts.length ? parts.join(" + ") : "-";
};
const dollars = (micro: number) => `$${(micro / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const CATEGORY: Record<string, string> = { promotional: "Free & bonus", subscription: "From plans", purchased: "Bought" };

/** The money view: revenue per currency, subscribers, credits owed, what the AI costs against what customers are billed, and things that should be zero. */
export function FinanceAdmin({ onError }: { onError: (e: unknown) => void }) {
  const [f, setF] = useState<Finance | null>(null);
  const load = useCallback(() => { api<{ finance: Finance }>("/api/admin/finance").then((r) => setF(r.finance)).catch(onError); }, [onError]);
  useEffect(load, [load]);
  if (!f) return <Card className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Loading...</Card>;
  const { revenue: r, subscriptions: s, credits: c, ai, health: h, inUsd } = f;
  const usdTiles = [inUsd.netThisMonth, inUsd.netLastMonth, inUsd.mrr];
  const missing = [...new Set(usdTiles.flatMap((x) => x.missing))];
  const problems = [
    h.walletMismatches > 0 && `${h.walletMismatches} wallet(s) do not match their ledger`,
    h.bucketMismatches > 0 && `${h.bucketMismatches} credit bucket check(s) fail`,
    h.duplicatePaymentsToRefund > 0 && `${h.duplicatePaymentsToRefund} duplicate payment(s) waiting to be refunded`,
    h.failedNoticesLast7Days > 0 && `${h.failedNoticesLast7Days} provider notice(s) failed in the last 7 days`,
    h.stuckAiRequests > 0 && `${h.stuckAiRequests} AI request(s) look stuck`,
  ].filter(Boolean) as string[];
  const margin = ai.thisMonth.billedMicroUsd - ai.thisMonth.providerCostMicroUsd;
  const peak = Math.max(1, ...ai.daily.map((d) => Math.max(d.providerCostMicroUsd, d.billedMicroUsd)));
  const th = "py-2 pr-4 text-xs font-medium text-slate-500";
  return (
    <div className="space-y-5">
      <Notice tone="slate">The first tiles show each currency on its own. The US-dollar totals below add them up at the exchange rates you enter in the Tax &amp; currency tab. AI figures are in US dollars. A month is a calendar month in UTC. The agency&apos;s own organization is left out.</Notice>
      {problems.length === 0 ? <Notice tone="green">All checks pass: wallets, credit buckets and payments agree with each other.</Notice> : <Notice tone="red">Needs attention: {problems.join("; ")}.</Notice>}

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Money received</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label={`Net this month (${f.month.label})`} value={money(r.thisMonth.net)} hint={`received ${money(r.thisMonth.received)} · refunded ${money(r.thisMonth.refunded)}`} />
          <Stat label="Net last month" value={money(r.lastMonth.net)} />
          <Stat label="Credit packs sold this month" value={String(r.topupsThisMonth.orders)} hint={money(r.topupsThisMonth.value)} />
          <Stat label="Net, all time" value={money(r.allTime.net)} />
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Everything in US dollars (estimate)</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Net this month" value={dollars(inUsd.netThisMonth.total * 10_000)} />
          <Stat label="Net last month" value={dollars(inUsd.netLastMonth.total * 10_000)} />
          <Stat label="Monthly recurring revenue" value={dollars(inUsd.mrr.total * 10_000)} hint={`at risk: ${dollars(inUsd.mrrAtRisk.total * 10_000)}`} />
          <Stat label="Waiting for payment" value={dollars(inUsd.openInvoices.total * 10_000)} />
        </div>
        {missing.length > 0 ? <Notice tone="amber">No exchange rate for {missing.join(", ")}, so money in {missing.length > 1 ? "those currencies is" : "that currency is"} left out of these totals. Add the rate in the Tax &amp; currency tab.</Notice> : <p className="text-xs text-slate-500">Converted at the rates you entered{usdTiles.find((x) => x.ratesFrom)?.ratesFrom ? ` (oldest used: ${usdTiles.find((x) => x.ratesFrom)!.ratesFrom!.slice(0, 10)})` : ""}. This is for reading the numbers, not for accounts: customers pay in their own currency.</p>}
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Subscribers</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Monthly recurring revenue" value={money(s.mrr)} hint="active, paying subscribers; yearly counted as a twelfth" />
          <Stat label="At risk (cancelling)" value={money(s.mrrAtRisk)} hint={`${s.cancelling} will not renew`} tone={s.cancelling ? "warn" : "default"} />
          <Stat label="Paying" value={String(s.activePaid)} hint={`${s.pastDue} past due · ${s.inTrial} in free trial · ${s.free} on Free`} tone={s.pastDue ? "warn" : "default"} />
          <Stat label="Waiting for payment" value={String(s.openInvoices.count)} hint={`invoices: ${money(s.openInvoices.value)}`} />
        </div>
        <p className="text-xs text-slate-500">Ended this month: {s.endedThisMonth}. By plan: {s.byPlan.map((p) => `${p.name} ${p.count}`).join(" · ") || "none"}.</p>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">Credits owed to customers</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Outstanding" value={credits(c.outstandingUnits)} hint={`worth ${dollars(c.outstandingValueMicroUsd)} at the credit price`} />
          {c.byCategory.map((x) => <Stat key={x.category} label={CATEGORY[x.category] ?? x.category} value={credits(x.units)} />)}
          <Stat label="Given this month" value={credits(c.grantedThisMonthUnits)} hint={`used ${credits(c.spentThisMonthUnits)}`} />
        </div>
        <p className="text-xs text-slate-500">These are credits customers can still spend on AI that has to be paid for. Credits from plans and bonuses are counted too.</p>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900">AI: cost against what customers were billed</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Provider cost this month" value={dollars(ai.thisMonth.providerCostMicroUsd)} hint={`last month ${dollars(ai.lastMonth.providerCostMicroUsd)}`} />
          <Stat label="Billed in credits" value={dollars(ai.thisMonth.billedMicroUsd)} hint={`${credits(ai.thisMonth.chargedUnits)} credits`} />
          <Stat label="Difference" value={dollars(margin)} hint="billed minus provider cost" tone={margin < 0 ? "warn" : "good"} />
          <Stat label="Requests" value={String(ai.thisMonth.requests)} hint={`${ai.thisMonth.failed} failed (not charged) · ${ai.thisMonth.fallbacks} used a backup`} />
        </div>
        {ai.thisMonth.uncollectedUnits > 0 && <Notice tone="amber">{credits(ai.thisMonth.uncollectedUnits)} credits of AI use could not be collected this month (the customer ran out mid-request).</Notice>}
        <p className="text-xs text-slate-500">Plan credits are paid for by the plan price, so compare this with money received above, not with it alone.</p>
        {ai.byProvider.length === 0 ? <p className="text-sm text-slate-500">No AI requests this month.</p> : <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 text-left"><th className={th}>This month</th><th className={th + " text-right"}>Requests</th><th className={th + " text-right"}>Failed</th><th className={th + " text-right"}>Provider cost</th><th className={th + " text-right"}>Billed</th></tr></thead>
            <tbody>
              {[...ai.byProvider.map((x) => ({ ...x, key: `provider: ${x.key}` })), ...ai.byModel.map((x) => ({ ...x, key: `model: ${x.key}` }))].map((x) => (
                <tr key={x.key} className="border-b border-slate-100 last:border-0"><td className="py-2 pr-4 font-medium text-slate-800">{x.key}</td><td className="py-2 pr-4 text-right tabular-nums">{x.requests}</td><td className="py-2 pr-4 text-right tabular-nums">{x.failed}</td><td className="py-2 pr-4 text-right tabular-nums">{dollars(x.providerCostMicroUsd)}</td><td className="py-2 text-right tabular-nums">{dollars(x.billedMicroUsd)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>}
        <div>
          <p className="mb-1.5 text-xs font-medium text-slate-700">Last 14 days: provider cost (grey) and billed (indigo), per day</p>
          <div className="space-y-1" role="list" aria-label="Daily AI cost and billing">
            {ai.daily.map((d) => (
              <div key={d.date} role="listitem" className="flex items-center gap-2 text-xs text-slate-500">
                <span className="w-20 shrink-0 tabular-nums">{d.date.slice(5)}</span>
                <div className="flex-1 space-y-0.5">
                  <div className="h-1.5 rounded-full bg-slate-400" style={{ width: `${(d.providerCostMicroUsd / peak) * 100}%`, minWidth: d.providerCostMicroUsd > 0 ? 2 : 0 }} />
                  <div className="h-1.5 rounded-full bg-indigo-500" style={{ width: `${(d.billedMicroUsd / peak) * 100}%`, minWidth: d.billedMicroUsd > 0 ? 2 : 0 }} />
                </div>
                <span className="w-36 shrink-0 text-right tabular-nums">{d.requests} req · {dollars(d.providerCostMicroUsd)} / {dollars(d.billedMicroUsd)}</span>
              </div>
            ))}
          </div>
        </div>
      </Card>
      <Button variant="ghost" onClick={load}>Refresh</Button>
    </div>
  );
}

type Entry = { id: number; at: string; actor: string; action: string; entityType: string; entityId: string; orgId: string | null; detail: Record<string, unknown> };

/** Who changed what, newest first. Cannot be edited. */
export function AuditAdmin({ onError }: { onError: (e: unknown) => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [action, setAction] = useState("");
  const [orgId, setOrgId] = useState("");
  const [more, setMore] = useState(true);
  const query = (before?: number) => `/api/admin/audit?limit=50${action.trim() ? `&action=${encodeURIComponent(action.trim())}` : ""}${orgId.trim() ? `&orgId=${encodeURIComponent(orgId.trim())}` : ""}${before ? `&before=${before}` : ""}`;
  const load = useCallback(() => {
    api<{ entries: Entry[] }>(query()).then((r) => { setEntries(r.entries); setMore(r.entries.length === 50); }).catch(onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, orgId, onError]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  const older = () => entries && entries.length > 0 && api<{ entries: Entry[] }>(query(entries.at(-1)!.id)).then((r) => { setEntries([...entries, ...r.entries]); setMore(r.entries.length === 50); }).catch(onError);
  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Audit log</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">Every change to prices, plans, coupons, credits, payments, refunds, people and settings, and every administrator sign-in. Entries cannot be edited or deleted. Passwords, tokens and keys are never written down. All administrators share one token, so they show as &quot;admin&quot;.</p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">Action starts with<input value={action} onChange={(e) => setAction(e.target.value)} placeholder="payment." className={inputClass + " mt-1 block !w-48"} aria-label="Action filter" /></label>
        <label className="text-xs text-slate-600">Organization id<input value={orgId} onChange={(e) => setOrgId(e.target.value)} className={inputClass + " mt-1 block !w-56"} aria-label="Organization filter" /></label>
      </div>
      {!entries ? <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Loading...</p> : entries.length === 0 ? <p className="text-sm text-slate-500">Nothing recorded.</p> : (
        <ul className="divide-y divide-slate-100 text-sm">
          {entries.map((e) => (
            <li key={e.id} className="space-y-1 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium text-slate-900">{e.action}</span>
                <Pill tone={e.actor === "admin" ? "indigo" : "slate"}>{e.actor}</Pill>
                <span className="text-xs text-slate-500">{e.entityType}{e.entityId ? ` ${e.entityId}` : ""}{e.orgId && e.orgId !== e.entityId ? ` · ${e.orgId}` : ""}</span>
                <span className="ml-auto text-xs text-slate-400">{e.at.slice(0, 19).replace("T", " ")} UTC</span>
              </div>
              {Object.keys(e.detail).length > 0 && <p className="break-words font-mono text-[11px] leading-4 text-slate-500">{JSON.stringify(e.detail).slice(0, 400)}</p>}
            </li>
          ))}
        </ul>
      )}
      {more && entries && entries.length > 0 && <Button variant="ghost" onClick={() => void older()}>Show older</Button>}
    </Card>
  );
}

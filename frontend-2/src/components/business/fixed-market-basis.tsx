"use client";

import { useEffect, useState } from "react";

import { minorDigits } from "@/lib/business/countries";
import { BENCHMARK_LABELS } from "@/lib/business/market-rates";
import type { MarketSnapshot } from "@/lib/business/types";
import { Field, Select, jsonFetch } from "./ui";

type Reference = { roles: { id: string; label: string }[]; levels: { id: string; label: string }[]; riskAllowanceBp: number };
type Market =
  | { ok: true; currency: string; kind: MarketSnapshot["kind"]; minMinor: number; medianMinor: number; maxMinor: number; billedMinor: number; source: string; effectiveDate: string; ageDays: number; stale: boolean; illustrative: boolean; billsAtCost: boolean; rateId: number }
  | { ok: false; message: string };

export type FixedBasisChoice = { roleId: string; levelId: string } | null;

/**
 * Fixed price: optionally base the hourly price on the verified market rate for the client's country, role and level. Left on "Rate card" nothing changes. The figure shown here is
 * only a preview: the server looks the rate up again when the quotation is saved.
 */
export function FixedBasisPicker({ country, choice, onChoice, onPreview }: { country: string; choice: FixedBasisChoice; onChoice: (c: FixedBasisChoice) => void; onPreview: (m: { market: MarketSnapshot; riskBp: number } | null) => void }) {
  const [ref, setRef] = useState<Reference | null>(null);
  const [market, setMarket] = useState<Market | null>(null);
  useEffect(() => { jsonFetch<Reference>("/api/business/pricing-reference").then(setRef).catch(() => undefined); }, []);

  const roleId = choice?.roleId ?? "";
  const levelId = choice?.levelId ?? "";
  const risk = ref?.riskAllowanceBp ?? 0;
  useEffect(() => {
    if (!choice || !country) { setMarket(null); onPreview(null); return; }
    let live = true;
    jsonFetch<{ rate: Market }>(`/api/business/market-rate?country=${country}&role=${roleId}&level=${levelId}&mode=fixed`)
      .then((r) => {
        if (!live) return;
        setMarket(r.rate);
        onPreview(r.rate.ok ? { market: { rateId: r.rate.rateId, kind: r.rate.kind, currency: r.rate.currency, minMinor: r.rate.minMinor, medianMinor: r.rate.medianMinor, maxMinor: r.rate.maxMinor, billedMinor: r.rate.billedMinor, source: r.rate.source, effectiveDate: r.rate.effectiveDate, illustrative: r.rate.illustrative, stale: r.rate.stale, billsAtCost: r.rate.billsAtCost }, riskBp: risk } : null);
      })
      .catch(() => { if (live) { setMarket(null); onPreview(null); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, roleId, levelId, risk, !!choice]);

  if (!ref) return null;
  return (
    <div className="space-y-2 sm:col-span-2" data-testid="fixed-basis">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Hourly price based on" hint="Rate card = your own price list (as before). Or use the verified market rate for the client's country.">
          <Select value={choice ? "market" : "card"} onChange={(e) => onChoice(e.target.value === "market" ? { roleId: roleId || "any", levelId: levelId || "mid" } : null)}>
            <option value="card">Rate card</option>
            <option value="market">Market rate for the client&apos;s country</option>
          </Select>
        </Field>
        {choice && (
          <>
            <Field label="Role"><Select value={roleId} onChange={(e) => onChoice({ roleId: e.target.value, levelId })}>{ref.roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</Select></Field>
            <Field label="Experience level"><Select value={levelId} onChange={(e) => onChoice({ roleId, levelId: e.target.value })}>{ref.levels.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</Select></Field>
          </>
        )}
      </div>
      {choice && !country && <p className="text-xs text-slate-400">Choose the client&apos;s country to look up its market rate.</p>}
      {choice && country && market && !market.ok && <p className="rounded-lg border border-white/[.08] bg-white/[.03] px-3 py-2 text-xs text-slate-400" data-testid="fixed-basis-none">{market.message} Until then the rate card price is used.</p>}
      {choice && market?.ok && (
        <div className="space-y-1 rounded-xl border border-emerald-400/20 bg-emerald-500/[.05] px-3 py-2.5 text-xs" data-testid="fixed-basis-panel">
          <p className="font-medium text-emerald-100">{BENCHMARK_LABELS[market.kind]} · {market.currency} {(market.billedMinor / 10 ** minorDigits(market.currency)).toFixed(minorDigits(market.currency))} an hour{risk ? `, plus a ${risk / 100}% risk allowance` : ""}</p>
          <p className="text-[11px] text-slate-400">From {market.effectiveDate}. Source: {market.source}</p>
          {market.illustrative && <p className="text-[11px] text-amber-200">This is an illustrative assumption, not a measured market rate.</p>}
          {market.stale && <p className="text-[11px] text-amber-200">This figure is {market.ageDays} days old: check it before relying on it.</p>}
          {market.billsAtCost && <p className="text-[11px] text-amber-200">This price earns nothing above cost: set a multiplier, overhead or margin in Global pricing.</p>}
        </div>
      )}
    </div>
  );
}

"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { formatMoney, INR_MONEY, moneyOf, type Money } from "@/lib/business/money";

/**
 * The currency a quotation is shown in. A screen that knows which quotation it is showing wraps its amounts in <MoneyProvider>, and every amount below it is
 * written by useMoney().fmt in that currency. Outside a provider everything is rupees, exactly as before. Amounts themselves are always held in rupees:
 * only the writing changes (see money.ts).
 */
const MoneyContext = createContext<Money>(INR_MONEY);

export function MoneyProvider({ money, quote, children }: { money?: Money; quote?: { currency?: string; inrPerUnit?: number } | null; children: ReactNode }) {
  const value = useMemo(() => money ?? moneyOf(quote), [money, quote]);
  return <MoneyContext.Provider value={value}>{children}</MoneyContext.Provider>;
}

/** The writer for amounts in the quotation being shown, and its currency. */
export function useMoney(): { money: Money; fmt: (amountInr: number) => string } {
  const money = useContext(MoneyContext);
  return useMemo(() => ({ money, fmt: (amountInr: number) => formatMoney(amountInr, money) }), [money]);
}

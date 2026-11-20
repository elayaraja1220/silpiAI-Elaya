import type { Lead, Quotation, WorkEntry } from "./types";

/**
 * Estimate vs actual hours: the owner's own price history. Pure, so the
 * project screen and the overall summary agree.
 */

export const EXTRA_WORK = "Extra work / changes";

export type HoursLine = { item: string; estimated: number; actual: number };
export type HoursReport = {
  estimated: number;
  actual: number;
  /** (actual - estimated) / estimated in percent; 0 when nothing is estimated. */
  variancePct: number;
  lines: HoursLine[];
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Quoted lines that carry hours (set-up, pages, features, design), in quotation order. */
export function quotedItems(quote: Pick<Quotation, "items"> | undefined): { item: string; hours: number }[] {
  return (quote?.items ?? []).filter((i) => i.unit === "hour" && i.qty > 0).map((i) => ({ item: i.description, hours: i.qty }));
}

export function hoursReport(quote: Pick<Quotation, "items" | "totalHours"> | undefined, log: WorkEntry[]): HoursReport {
  const planned = quotedItems(quote);
  const known = new Set(planned.map((p) => p.item));
  const lines: HoursLine[] = planned.map((p) => ({
    item: p.item,
    estimated: p.hours,
    actual: round1(log.filter((e) => e.item === p.item).reduce((s, e) => s + e.hours, 0)),
  }));
  const extra = round1(log.filter((e) => !known.has(e.item)).reduce((s, e) => s + e.hours, 0));
  if (extra > 0) lines.push({ item: EXTRA_WORK, estimated: 0, actual: extra });
  const estimated = round1(quote?.totalHours ?? planned.reduce((s, p) => s + p.hours, 0));
  const actual = round1(log.reduce((s, e) => s + e.hours, 0));
  return { estimated, actual, variancePct: estimated > 0 ? Math.round(((actual - estimated) / estimated) * 100) : 0, lines };
}

/** Across every project with logged hours: how close the estimates are. */
export function accuracy(leads: Pick<Lead, "quotation" | "workLog">[]) {
  const tracked = leads.filter((l) => l.quotation && (l.workLog?.length ?? 0) > 0);
  const estimated = tracked.reduce((s, l) => s + (l.quotation?.totalHours ?? 0), 0);
  const actual = tracked.reduce((s, l) => s + l.workLog.reduce((t, e) => t + e.hours, 0), 0);
  return { projects: tracked.length, estimated: round1(estimated), actual: round1(actual), ratio: estimated > 0 ? actual / estimated : 0 };
}

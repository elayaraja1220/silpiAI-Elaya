// Suggesting how a quotation's hours are shared between roles. This is ADVICE for planning and staffing. It never changes the quotation: the total hours always stay what the
// rate card produced, the price is never touched, and nothing in the pricing code reads a split. (A test scans the sources to keep it that way.)
import type { Quotation, Requirement, RateCard } from "./types";
import { needsBackend } from "./pricing";

/** The roles a split may use: ids of the pricing roles, so a split can later be valued with the market rates. */
export const SPLIT_ROLES = ["frontend", "backend", "full-stack", "ui-ux", "qa", "devops", "project-manager", "ai-engineer", "mobile", "architect"] as const;
export type SplitRole = (typeof SPLIT_ROLES)[number];
export const SPLIT_LABELS: Record<SplitRole, string> = { frontend: "Frontend", backend: "Backend", "full-stack": "Full stack", "ui-ux": "UI/UX design", qa: "QA / testing", devops: "DevOps / hosting", "project-manager": "Project management", "ai-engineer": "AI engineering", mobile: "Mobile", architect: "Architecture" };

export type SplitLine = { roleId: SplitRole; hours: number };
export type HourSplit = { totalHours: number; lines: SplitLine[]; source: "rule" | "ai"; reason: string };

const HALF = 2; // hours are kept to the half hour, like the rate card's

/** Total hours the split is shared over: an hourly engagement's expected hours, otherwise every hour line of the fixed price. Never invented. */
export function totalHoursOf(q: Pick<Quotation, "hourly" | "totalHours">): number {
  return q.hourly ? q.hourly.expectedHours : q.totalHours;
}

/**
 * Makes any proposed split add up to exactly `total` (in half hours), using only known roles with positive hours, largest remainders first. Returns null when nothing usable is left.
 * This is what guarantees that a suggestion, from a rule or from an AI, can never add or remove hours.
 */
export function normaliseSplit(proposed: { roleId: unknown; hours: unknown }[], total: number): SplitLine[] | null {
  const target = Math.round(total * HALF);
  if (!Number.isFinite(total) || target <= 0) return null;
  const merged = new Map<SplitRole, number>();
  for (const p of proposed) {
    const id = String(p.roleId ?? "").trim().toLowerCase() as SplitRole;
    const h = Number(p.hours);
    if (!(SPLIT_ROLES as readonly string[]).includes(id) || !Number.isFinite(h) || h <= 0) continue;
    merged.set(id, (merged.get(id) ?? 0) + h);
  }
  const sum = [...merged.values()].reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  const scaled = [...merged.entries()].map(([roleId, h]) => ({ roleId, exact: (h / sum) * target }));
  const parts = scaled.map((s) => ({ roleId: s.roleId, units: Math.floor(s.exact), frac: s.exact - Math.floor(s.exact) }));
  let left = target - parts.reduce((a, p) => a + p.units, 0);
  for (const p of [...parts].sort((a, b) => b.frac - a.frac || SPLIT_ROLES.indexOf(a.roleId) - SPLIT_ROLES.indexOf(b.roleId))) {
    if (left <= 0) break;
    p.units += 1;
    left -= 1;
  }
  const lines = parts.filter((p) => p.units > 0).map((p) => ({ roleId: p.roleId, hours: p.units / HALF }));
  return lines.sort((a, b) => SPLIT_ROLES.indexOf(a.roleId) - SPLIT_ROLES.indexOf(b.roleId));
}

/**
 * The default rule used when no AI is available or its answer cannot be used. The shares are a rule of thumb that SILPI chose, NOT a measurement: they are written here, shown as "default
 * rule" on screen, and meant to be adjusted by the team.
 */
export const DEFAULT_RULE = { frontend: 40, backend: 25, "ui-ux": 12, qa: 13, "project-manager": 10 } as const;

export function ruleSplit(req: Pick<Requirement, "projectType" | "modules">, rates: RateCard, total: number): HourSplit | null {
  const backend = needsBackend(req as Requirement, rates);
  const shares: { roleId: string; hours: number }[] = Object.entries(DEFAULT_RULE).filter(([r]) => backend || r !== "backend").map(([roleId, hours]) => ({ roleId, hours }));
  const lines = normaliseSplit(shares, total);
  if (!lines) return null;
  return { totalHours: total, lines, source: "rule", reason: `Default rule of thumb${backend ? "" : " (no backend in this project)"}: not a measurement. Adjust it to how you will really staff the work.` };
}

/** What the AI is told. It is given the facts of the quotation and the total; it is not given prices. */
export function splitPrompt(q: Quotation, total: number): { system: string; user: string } {
  const r = q.requirement;
  const system = `You advise a small software agency on how to share the hours of a quotation between roles. Answer with JSON only, no other text, in this exact shape: {"split":[{"role":"<role id>","hours":<number>}],"reason":"<one or two sentences>"}. Allowed role ids: ${SPLIT_ROLES.join(", ")}. The hours must add up to the total given. Never mention prices or rates.`;
  const lines = [
    `Project: ${(r?.title ?? "").slice(0, 120)}`,
    `Summary: ${(r?.summary ?? "").slice(0, 600)}`,
    `Type: ${r?.projectType ?? "unknown"}`,
    `Pages: ${(r?.pages ?? []).slice(0, 40).join(", ") || "none"}`,
    `Features: ${(r?.modules ?? []).slice(0, 40).join(", ") || "none"}`,
    q.hourly ? `Engagement: hourly, ${q.hourly.role}` : "Engagement: fixed scope",
    `Total hours to share: ${total}`,
  ];
  return { system, user: lines.join("\n") };
}

/** Reads the AI's answer. Returns null when it is not the JSON asked for. */
export function parseSplitAnswer(text: string): { lines: { roleId: unknown; hours: unknown }[]; reason: string } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as { split?: unknown; reason?: unknown };
    if (!Array.isArray(o.split)) return null;
    const lines = o.split.filter((x): x is { role?: unknown; roleId?: unknown; hours?: unknown } => !!x && typeof x === "object").map((x) => ({ roleId: x.role ?? x.roleId, hours: x.hours }));
    return { lines, reason: typeof o.reason === "string" ? o.reason.trim().slice(0, 400) : "" };
  } catch {
    return null;
  }
}

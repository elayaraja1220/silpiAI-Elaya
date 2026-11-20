import { sectionsOf } from "./pricing";
import { billablePages, scopeSummary, supportingPages } from "./scope";
import { DEFAULT_RATE_CARD } from "./rate-card";
import type { Lead, RateCard } from "./types";

/**
 * Turns the approved proposal into the build brief for the SILPI agent:
 * exactly what was sold, nothing more (phase-2 features are listed as
 * "do not build"), so the delivered site matches the quotation.
 */
export function buildBrief(lead: Lead, rates: RateCard = DEFAULT_RATE_CARD) {
  const q = lead.quotation;
  if (!q) throw new Error("No quotation to build from.");
  const req = q.requirement ?? lead.requirement;
  const module = (id: string) => rates.modules[id as keyof RateCard["modules"]];

  const lines: string[] = [
    `# ${req.title}`,
    "",
    `Client: ${lead.client.company || lead.client.name} (${lead.client.state}). Approved quotation ${q.number}${q.tier ? `, ${q.tier} proposal` : ""}.`,
    "",
    "## Requirement",
    req.summary,
    "",
    "## Pages (build exactly these)",
    ...billablePages(req).map((p) => {
      const purpose = req.pageDetails?.[p]?.purpose?.trim();
      return `- ${p}: ${sectionsOf(req, p, rates)} sections${purpose ? `. ${purpose}` : ""}`;
    }),
    ...(supportingPages(req).length ? ["", "## Supporting pages (simple)", ...supportingPages(req).map((p) => `- ${p}`)] : []),
    "",
    "## Shared components (one each, used on every page)",
    ...scopeSummary(req, rates).sharedComponents.map((c) => `- ${c}`),
    "",
    "## Features",
    ...(req.modules.length ? req.modules.map((m) => `- ${module(m)?.label ?? m}: ${module(m)?.detail ?? ""}`) : ["- None beyond the pages"]),
  ];
  const notBuilt = [...[...(req.excludedModules ?? []), ...(req.deferredModules ?? [])].map((m) => module(m)?.label ?? m), ...(req.deferredPages ?? []).map((p) => `${p} page`)];
  if (notBuilt.length) {
    lines.push("", "## Do NOT build (not in this package or moved to phase 2, not paid for)", ...notBuilt.map((m) => `- ${m}`));
  }
  lines.push(
    "",
    "## Design",
    `${rates.design[req.design]?.label ?? req.design}. ${rates.design[req.design]?.detail ?? ""}`,
    ...(req.references ? [`References and brand notes: ${req.references}`] : []),
    "",
    req.clientTech ? "## Technology (requested by the client: use exactly this, do not substitute another)" : "## Technology",
    `- Approach: ${q.stack.approach ?? "Custom code"}`,
    `- Frontend: ${q.stack.frontend}`,
    `- Backend: ${q.stack.backend}`,
    `- Database: ${q.stack.database}`,
    `- Styling: ${q.stack.styling}`,
    ...q.stack.notes.map((n) => `- ${n}`),
    "",
    "## SEO (must be done)",
    ...(q.seo?.included ?? []).map((s) => `- ${s}`),
    ...(q.seo?.keywords.length ? [`- Use these search phrases naturally in titles, headings and text: ${q.seo.keywords.join(", ")}`] : []),
  );
  const assumptions = lead.requirement.insights?.assumptions ?? [];
  if (assumptions.length) lines.push("", "## Agreed assumptions", ...assumptions.map((a) => `- ${a}`));
  lines.push(
    "",
    "## Quality",
    "- Responsive from 360px phones to desktop; accessible (labels, contrast, keyboard).",
    "- Use clearly marked placeholder text and images where the client has not supplied content.",
    "- The project must build without errors.",
  );

  const description = lines.join("\n").slice(0, 29_000);
  // "Next.js (React), exported as a static site" -> "Next.js (React)"; "None (static site)" -> nothing.
  const split = (s: string) => (s && !/^none/i.test(s) ? [s.split(",")[0].trim().slice(0, 60)] : []);
  return {
    description,
    frontend: split(q.stack.frontend),
    backend: split(q.stack.backend),
    database: split(q.stack.database),
    styling: split(q.stack.styling),
  };
}

/** Folder-safe project name from the title, e.g. "meena-silks-website-4f2a". */
export function projectNameFor(title: string, suffix: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "client-project";
  return `${slug}-${suffix}`.replace(/^[^a-z0-9]+/, "p");
}

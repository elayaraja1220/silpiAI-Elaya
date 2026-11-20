// Package feature matrix (Basic / Standard / Premium): what each package honestly promises
// for a solo developer, how it is shown, and that prices and GST did not move.
// Run: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { buildQuote } from "@/lib/business/pricing";
import { buildProposals, compareProposals, describePriority } from "@/lib/business/proposals";
import { DEFAULT_RATE_CARD, HANDOVER_LABEL } from "@/lib/business/rate-card";
import type { ComparisonRow, RateCard, Requirement, Tier } from "@/lib/business/types";
import { parseRateCard } from "@/lib/business/validate";

const rates = DEFAULT_RATE_CARD;
const TN = { state: "Tamil Nadu" };
const TIERS: Tier[] = ["basic", "standard", "premium"];

/** A four-page static website. */
function website(extra: Partial<Requirement> = {}): Requirement {
  return {
    title: "Site", summary: "A four page website that is long enough to be valid.", scope: "full", existingProject: "", version: "", projectType: "business-website", complexity: "basic",
    pages: ["Home", "About Us", "Services", "Contact Us"],
    pageDetails: { Home: { sections: 4, purpose: "" }, "About Us": { sections: 3, purpose: "" }, Services: { sections: 5, purpose: "" }, "Contact Us": { sections: 3, purpose: "" } },
    modules: [], design: "ai", references: "", domain: { needed: false, choice: "self", name: "", tld: ".com", years: 1 },
    hosting: { needed: false, choice: "self", plan: "static", years: 1 }, deadlineWeeks: 0, budget: 0, ...extra,
  };
}
const rowsFor = (card: RateCard = rates) => compareProposals(buildProposals(website(), TN, card), card);
const row = (rows: ComparisonRow[], label: string) => {
  const r = rows.find((x) => x.label === label);
  assert.ok(r, `row "${label}" is missing`);
  return r!.values;
};

describe("1. the default package terms", () => {
  it("free support after launch: 7, 15 and 30 days", () => {
    assert.deepEqual(TIERS.map((t) => rates.packages[t].supportDays), [7, 15, 30]);
  });
  it("revision rounds are unchanged", () => {
    assert.deepEqual(TIERS.map((t) => rates.packages[t].revisions), [1, 2, 3]);
  });
  it("the handover is called 'Website handover & source code' and is in all three packages", () => {
    assert.equal(HANDOVER_LABEL, "Website handover & source code");
    for (const t of TIERS) assert.ok(rates.packages[t].extras.includes(HANDOVER_LABEL), t);
  });
  it("the handover covers source code, deployment details and access information, and implies no admin login", () => {
    for (const t of TIERS) {
      const text = rates.packages[t].handover!;
      assert.match(text, /source code/);
      assert.match(text, /deployment details/);
      assert.match(text, /access information/);
      assert.ok(!/login|admin|password/i.test(`${text} ${rates.packages[t].extras.join(" ")}`), `${t} must not imply every site has a login`);
    }
  });
  it("documentation and training, by package", () => {
    assert.equal(rates.packages.basic.documentation, "Basic handover documentation or usage guide");
    assert.equal(rates.packages.standard.documentation, "Documentation plus one client training session");
    assert.equal(rates.packages.premium.documentation, "Documentation plus extended client training");
  });
  it("security and testing, by package; no package is launched without essential security checks", () => {
    assert.equal(rates.packages.basic.security, "Essential security checks and basic testing before launch");
    assert.equal(rates.packages.standard.security, "Essential security checks, responsive testing and basic performance checks");
    assert.equal(rates.packages.premium.security, "More comprehensive security and performance review");
    assert.match(rates.packages.basic.security!, /Essential security checks/);
    assert.match(rates.packages.standard.security!, /Essential security checks/);
  });
  it("priority support is Premium only", () => {
    assert.equal(rates.packages.basic.prioritySupport ?? null, null);
    assert.equal(rates.packages.standard.prioritySupport ?? null, null);
    assert.deepEqual(rates.packages.premium.prioritySupport, { responseHours: null });
  });
});

describe("2. the comparison table shows the same thing", () => {
  const rows = rowsFor();
  it("handover is ticked for every package", () => {
    assert.deepEqual(row(rows, HANDOVER_LABEL), { basic: true, standard: true, premium: true });
  });
  it("documentation & training", () => {
    assert.deepEqual(row(rows, "Documentation & training"), {
      basic: "Basic handover documentation or usage guide",
      standard: "Documentation plus one client training session",
      premium: "Documentation plus extended client training",
    });
  });
  it("security & testing before launch", () => {
    assert.deepEqual(row(rows, "Security & testing before launch"), {
      basic: "Essential security checks and basic testing before launch",
      standard: "Essential security checks, responsive testing and basic performance checks",
      premium: "More comprehensive security and performance review",
    });
  });
  it("free support after launch", () => {
    assert.deepEqual(row(rows, "Free support after launch"), { basic: "7 days", standard: "15 days", premium: "30 days" });
  });
  it("priority support is Premium only, with no promised reply time", () => {
    const r = row(rows, "Priority support");
    assert.equal(r.basic, false);
    assert.equal(r.standard, false);
    assert.equal(r.premium, "Priority queue (no fixed response time)");
  });
  it("revision rounds are still shown", () => {
    assert.deepEqual(row(rows, "Revision rounds"), { basic: "1", standard: "2", premium: "3" });
  });
  it("the old wording is gone", () => {
    const text = JSON.stringify(rows);
    for (const old of ["Website handover with login details", "Training on updating content", "Speed and security check before launch", "login details"]) assert.ok(!text.includes(old), old);
  });
  it("every package row has a value for every package", () => {
    for (const r of rows) for (const t of TIERS) assert.ok(r.values[t] !== undefined && r.values[t] !== "", `${r.label} / ${t}`);
  });
});

describe("3. nothing is promised that one person cannot deliver", () => {
  it("no guaranteed response time, round-the-clock cover or dedicated staff by default", () => {
    const everything = JSON.stringify([rates.packages, rowsFor()]);
    assert.ok(!/guarantee|24\s*[x/]\s*7|round[- ]the[- ]clock|dedicated|account manager|instant|within \d+/i.test(everything), everything.match(/guarantee|24[x/]7|dedicated|within \d+/i)?.[0]);
  });
  it("a reply time appears only when one is configured", () => {
    assert.equal(describePriority({ responseHours: null }), "Priority queue (no fixed response time)");
    assert.equal(describePriority({ responseHours: 24 }), "Priority queue, first reply within 24 working hours");
    const configured = parseRateCard({ packages: { premium: { prioritySupport: { responseHours: 24 } } } }, rates);
    assert.equal(row(rowsFor(configured), "Priority support").premium, "Priority queue, first reply within 24 working hours");
  });
  it("an unusable reply time means no promise", () => {
    for (const bad of [0, -5, 9999, "fast", NaN, null]) {
      const card = parseRateCard({ packages: { premium: { prioritySupport: { responseHours: bad } } } }, rates);
      assert.deepEqual(card.packages.premium.prioritySupport, { responseHours: null }, String(bad));
    }
  });
  it("priority support can be switched off for a package, and on for another", () => {
    const off = parseRateCard({ packages: { premium: { prioritySupport: null } } }, rates);
    assert.equal(rowsFor(off).some((r) => r.label === "Priority support"), false, "no row at all when no package has it");
    const on = parseRateCard({ packages: { standard: { prioritySupport: { responseHours: 48 } } } }, rates);
    assert.equal(row(rowsFor(on), "Priority support").standard, "Priority queue, first reply within 48 working hours");
  });
});

describe("4. prices and GST are unchanged", () => {
  const proposals = buildProposals(website(), TN, rates);
  it("the three package prices are what they were", () => {
    assert.deepEqual(proposals.map((p) => [p.title, p.quote.totalHours, p.grandTotal]), [
      ["Basic", 27.5, 16225],
      ["Standard", 32, 18880],
      ["Premium", 40.5, 23895],
    ]);
  });
  it("GST is still 18% of the taxable value, split into CGST and SGST", () => {
    for (const p of proposals) {
      assert.equal(p.quote.gst.rate, 18);
      assert.equal(p.quote.gst.total, Math.round(p.quote.taxable * 0.18 * 100) / 100);
      assert.equal(p.quote.gst.cgst, p.quote.gst.sgst);
      assert.equal(Math.round(p.quote.taxable + p.quote.gst.total), p.grandTotal);
    }
  });
  it("Premium care is still the same priced line (6 hours); only its description changed", () => {
    const care = proposals[2].quote.items.find((i) => i.description === "Premium care")!;
    assert.equal(care.qty, 6);
    assert.equal(care.amount, 3000);
    assert.match(care.detail!, /Comprehensive security and performance review, extended client training and priority support/);
    assert.ok(!/login|speed and security check/i.test(care.detail!));
    assert.ok(!proposals[0].quote.items.some((i) => i.description === "Premium care") && !proposals[1].quote.items.some((i) => i.description === "Premium care"));
  });
  it("the rate card's own prices were not touched", () => {
    assert.equal(rates.hourlyRate, 500);
    assert.equal(rates.premiumCareHours, 6);
    assert.equal(buildQuote(website(), TN, rates).grandTotal, buildQuote(website(), TN, parseRateCard({}, rates)).grandTotal);
  });
  it("the Premium feature list uses the new wording", () => {
    assert.ok(proposals[2].features.some((f) => f.includes("comprehensive security and performance review") && f.includes("extended training")));
    assert.ok(!proposals[2].features.some((f) => /speed & security check/i.test(f)));
  });
});

describe("5. saved rate cards from before keep working", () => {
  const legacy = {
    packages: {
      basic: { revisions: 1, supportDays: 15, extras: ["Mobile-friendly pages", "Website handover with login details"] },
      standard: { revisions: 2, supportDays: 30, extras: ["Mobile-friendly pages", "Website handover with login details", "Training on updating content", "Free logo tweak"] },
      premium: {
        revisions: 3,
        supportDays: 60,
        extras: ["Mobile-friendly pages", "Website handover with login details", "Training on updating content", "Speed and security check before launch", "Priority support"],
      },
    },
  };
  const card = parseRateCard(legacy, rates);
  it("the old handover wording is renamed and the dedicated rows replace the old extras", () => {
    assert.deepEqual(card.packages.basic.extras, ["Mobile-friendly pages", HANDOVER_LABEL]);
    assert.deepEqual(card.packages.premium.extras, ["Mobile-friendly pages", HANDOVER_LABEL]);
  });
  it("an extra the owner added is kept", () => {
    assert.deepEqual(card.packages.standard.extras, ["Mobile-friendly pages", HANDOVER_LABEL, "Free logo tweak"]);
  });
  it("the owner's saved support days and revisions are respected, not overwritten", () => {
    assert.deepEqual(TIERS.map((t) => card.packages[t].supportDays), [15, 30, 60]);
    assert.deepEqual(TIERS.map((t) => card.packages[t].revisions), [1, 2, 3]);
  });
  it("the new wording is filled in from the defaults", () => {
    assert.equal(card.packages.standard.documentation, rates.packages.standard.documentation);
    assert.equal(card.packages.basic.security, rates.packages.basic.security);
    assert.deepEqual(card.packages.premium.prioritySupport, { responseHours: null });
    assert.equal(card.packages.basic.prioritySupport ?? null, null);
  });
  it("saving and reading again changes nothing", () => {
    assert.deepEqual(parseRateCard(JSON.parse(JSON.stringify(card)), rates), card);
  });
  it("the owner can clear or change the wording", () => {
    const edited = parseRateCard({ packages: { basic: { documentation: "  A one-page guide  ", security: "" } } }, rates);
    assert.equal(edited.packages.basic.documentation, "A one-page guide");
    assert.equal(edited.packages.basic.security, undefined);
    const rows = rowsFor(edited);
    assert.equal(row(rows, "Security & testing before launch").basic, false, "a package with no text shows no promise");
  });
  it("very long text is cut", () => {
    const long = parseRateCard({ packages: { basic: { documentation: "x".repeat(900) } } }, rates);
    assert.ok(long.packages.basic.documentation!.length <= 200);
  });
});

describe("6. the screens show the same terms", () => {
  const read = (file: string) => readFileSync(path.resolve(file), "utf8");
  it("the package details panel shows documentation, security, priority support and the handover text", () => {
    const source = read("src/components/business/package-details.tsx");
    for (const needle of ["terms.documentation", "terms.security", "terms.prioritySupport", "describePriority", "terms.handover"]) assert.ok(source.includes(needle), needle);
  });
  it("Business & pricing can edit the new terms", () => {
    const source = read("src/components/pages/pricing-settings.tsx");
    for (const needle of ["documentation", "security", "prioritySupport", "Reply time"]) assert.ok(source.includes(needle), needle);
  });
  it("the comparison reaches the client page and documents through the same rows", () => {
    assert.ok(read("src/components/business/comparison-table.tsx").includes("row.values"));
  });
});

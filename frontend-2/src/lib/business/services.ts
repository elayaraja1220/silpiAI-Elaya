import { gstFor, suggestStack } from "./pricing";
import type { Client, RateCard, Requirement, SeparateServices, ServiceChoice, ServiceEstimate } from "./types";

/**
 * Domain and hosting: third-party services billed separately. They never
 * change the development subtotal, total, budget check or payment schedule.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Older records only have `needed`: treat that as "SILPI arranges it". */
export const domainChoice = (req: Requirement): ServiceChoice => req.domain.choice ?? (req.domain.needed ? "arrange" : "self");
export const hostingChoice = (req: Requirement): ServiceChoice => req.hosting.choice ?? (req.hosting.needed ? "arrange" : "self");

export const CHOICE_LABELS: Record<"domain" | "hosting", Record<ServiceChoice, string>> = {
  domain: { owned: "Client already owns a domain", self: "Client will buy the domain", arrange: "SILPI arranges domain registration" },
  hosting: { owned: "Client already has hosting", self: "Client will arrange hosting", arrange: "SILPI arranges hosting" },
};

function finish(kind: ServiceEstimate["kind"], title: string, details: ServiceEstimate["details"], items: ServiceEstimate["items"], renewal: number, client: Pick<Client, "state">, rates: RateCard): ServiceEstimate {
  const subtotal = round2(items.reduce((s, i) => s + i.amount, 0));
  const gst = gstFor(client, rates, subtotal).total;
  return { kind, title, details, items, subtotal, gst, total: Math.round(subtotal + gst), renewal };
}

export function separateServices(req: Requirement, client: Pick<Client, "state">, rates: RateCard): SeparateServices {
  const domain = domainChoice(req);
  const hosting = hostingChoice(req);
  const name = `${req.domain.name || "yourdomain"}${req.domain.tld}`;
  const recommended = suggestStack(req, rates).hosting;

  let domainEstimate: ServiceEstimate | undefined;
  if (domain === "arrange") {
    const price = rates.domains[req.domain.tld] ?? { register: 0, renew: 0 };
    const years = Math.max(1, req.domain.years);
    const items = [{ description: `Registration: ${name} (first year)`, amount: price.register }];
    if (years > 1) items.push({ description: `Renewal: ${years - 1} more year${years > 2 ? "s" : ""} paid now`, amount: price.renew * (years - 1) });
    domainEstimate = finish(
      "domain",
      "Domain registration",
      [
        { label: "Domain name", value: name },
        { label: "Extension", value: req.domain.tld },
        { label: "Registration period", value: `${years} year${years === 1 ? "" : "s"}` },
        { label: "Renewal", value: `₹${price.renew} per year after that` },
      ],
      items,
      price.renew,
      client,
      rates,
    );
  }

  let hostingEstimate: ServiceEstimate | undefined;
  if (hosting === "arrange") {
    const plan = rates.hosting[req.hosting.plan];
    const years = Math.max(1, req.hosting.years);
    const items: ServiceEstimate["items"] = [];
    if (plan.setup > 0) items.push({ description: "Hosting set-up (one time)", amount: plan.setup });
    items.push({ description: `${plan.label}: first year`, amount: plan.price });
    if (years > 1) items.push({ description: `${plan.label}: ${years - 1} more year${years > 2 ? "s" : ""} paid now`, amount: plan.renew * (years - 1) });
    hostingEstimate = finish(
      "hosting",
      "Web hosting",
      [
        { label: "Provider", value: plan.provider },
        { label: "Plan", value: plan.label },
        { label: "Server type", value: plan.serverType },
        { label: "Storage", value: plan.storage },
        { label: "Bandwidth", value: plan.bandwidth },
        { label: "Duration", value: `${years} year${years === 1 ? "" : "s"}` },
        { label: "Renewal", value: `₹${plan.renew} per year after that` },
      ],
      items,
      plan.renew,
      client,
      rates,
    );
  }

  return {
    domain: { choice: domain, name, estimate: domainEstimate },
    hosting: { choice: hosting, recommended, estimate: hostingEstimate },
    total: (domainEstimate?.total ?? 0) + (hostingEstimate?.total ?? 0),
    // Other third-party services: their price is the provider's, never guessed here.
    others: (req.externalServices ?? []).filter((x) => !/\b(domain|hosting)\b/i.test(x)),
  };
}

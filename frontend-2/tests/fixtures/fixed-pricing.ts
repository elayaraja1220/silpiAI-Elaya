// Fixed pricing for tests of MECHANICS (how billing and metering work), so they do not break every time the commercial catalogue changes.
// The tests that check the real catalogue (tests/pricing-currency.test.ts) do not use these.

/**
 * The credit conversion of the early days: 45,000 units per dollar of charge and a markup of 1.0 on the starting models.
 * Gateway and builder tests count exact credit units, so they pin this down instead of inheriting whatever the live settings are.
 */
export async function useFixedMetering(opts: { models?: boolean } = {}): Promise<void> {
  const cat = await import("@/server/ai/catalog");
  cat.setUnitsPerUsd(45_000);
  if (opts.models === false) return;
  for (const m of cat.listModels()) {
    if (m.provider !== "echo" && m.markupBasisPoints !== 10_000) cat.saveModel({ id: m.id, markupBasisPoints: 10_000, note: "test calibration", changedBy: "test" });
  }
}

/**
 * The plans as the billing tests were written against them: Free 10 credits; Starter Rs 499 for 100 credits; Pro Rs 1,499 for 400 credits;
 * Professional Rs 4,499 for 1,200 credits. Annual is ten months. Starter is switched on (the live catalogue sells it too).
 */
export async function useFixedCatalogue(): Promise<void> {
  const { updatePlan } = await import("@/server/subscriptions");
  updatePlan("free", { monthlyCreditUnits: 10_000 });
  updatePlan("starter", { active: true, monthlyPricePaise: 49_900, annualPricePaise: 499_000, monthlyCreditUnits: 100_000 });
  updatePlan("pro", { monthlyPricePaise: 149_900, annualPricePaise: 1_499_000, monthlyCreditUnits: 400_000 });
  updatePlan("professional", { monthlyPricePaise: 449_900, annualPricePaise: 4_499_000, monthlyCreditUnits: 1_200_000 });
}

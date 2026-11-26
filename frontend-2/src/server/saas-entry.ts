// Where "Start with SILPI AI" leads (server only).
import { getBilling } from "@/server/subscriptions";

export const AI_WORKSPACE = "/ai/builder";
/** The plans page, told where to go once a plan is active. */
export const PLANS_THEN_WORKSPACE = `/ai/billing?then=${encodeURIComponent(AI_WORKSPACE)}`;

/** The workspace when the organization has a running plan (the free plan counts); otherwise the plans, which lead on to the workspace once one is active. */
export function saasDestination(orgId: string): string {
  return getBilling(orgId).running ? AI_WORKSPACE : PLANS_THEN_WORKSPACE;
}

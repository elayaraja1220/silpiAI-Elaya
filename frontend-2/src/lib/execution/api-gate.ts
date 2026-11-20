import { ExecError, type ApiApproval, type ApiApprovalRequest, type ApiEstimate, type ExecutionSettings } from "./types";

/**
 * Rules for API-funded runs (pure). An API run only starts when ALL of these hold:
 *   1. the administrator enabled API mode,
 *   2. a spending limit is configured (the run is hard-capped at it),
 *   3. the developer confirmed THIS run, with the estimate and limit that were shown still current,
 *   4. the estimate does not exceed the limit,
 *   5. if the estimate is not reliable (or does not exist), the developer separately accepted that.
 * A cost that cannot be estimated is never treated as zero.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Estimate one run from what earlier API runs actually cost (US dollars, newest first). */
export function estimateApiCost(history: number[], limitUsd: number | null): ApiEstimate {
  const recent = history.filter((n) => Number.isFinite(n) && n >= 0).slice(0, 5);
  if (recent.length === 0) {
    return { estimatedUsd: null, reliable: false, basis: "There are no earlier API runs to base an estimate on, so the cost cannot be estimated.", limitUsd };
  }
  const sorted = [...recent].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const reliable = recent.length >= 3;
  return {
    estimatedUsd: round2(median),
    reliable,
    basis: `Median of the last ${recent.length} API run${recent.length === 1 ? "" : "s"}${reliable ? "." : ", which is too few to rely on."}`,
    limitUsd,
  };
}

const same = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 0.005);

/** Checks the approval for one API run. Throws an ExecError saying exactly what is missing. */
export function checkApiApproval(settings: ExecutionSettings, estimate: ApiEstimate, request: ApiApprovalRequest | undefined, now = new Date()): ApiApproval {
  if (!settings.apiEnabled) {
    throw new ExecError("api-disabled", "API execution is turned off. Turn on API mode in Execution settings first, or use Local Claude Code.", 403);
  }
  if (settings.apiSpendLimitUsd === null || !(settings.apiSpendLimitUsd > 0)) {
    throw new ExecError("api-limit-missing", "Set an API spending limit in Execution settings before running with the API.", 409);
  }
  if (!request || request.confirmed !== true) {
    throw new ExecError("approval-required", "This run is paid by API usage. Approve the estimated cost and spending limit to continue.", 409, { estimate });
  }
  if (!same(request.estimateUsd, estimate.estimatedUsd) || Math.abs(request.limitUsd - settings.apiSpendLimitUsd) >= 0.005) {
    throw new ExecError("approval-stale", "The estimate or the spending limit changed since you approved. Review them and approve again.", 409, { estimate });
  }
  if (estimate.estimatedUsd !== null && estimate.estimatedUsd > settings.apiSpendLimitUsd) {
    throw new ExecError("estimate-over-limit", "The estimated cost is above the spending limit. Raise the limit in Execution settings, or use Local Claude Code.", 409, { estimate });
  }
  if (!estimate.reliable && request.acceptUnreliable !== true) {
    throw new ExecError("unreliable-estimate", "The cost cannot be estimated reliably. Confirm that you accept a cost of up to the spending limit.", 409, { estimate });
  }
  return {
    mode: "api",
    approvedAt: now.toISOString(),
    estimatedUsd: estimate.estimatedUsd,
    limitUsd: settings.apiSpendLimitUsd,
    reliable: estimate.reliable,
    basis: estimate.basis,
    acceptedUnreliableEstimate: !estimate.reliable,
  };
}

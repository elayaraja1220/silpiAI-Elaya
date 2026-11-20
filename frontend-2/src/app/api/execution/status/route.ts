import { NextRequest } from "next/server";

import { requireAdminOrDevStart } from "@/lib/dev-start"; // TEMP DEV: see dev-start.ts
import { getAgentDir } from "@/lib/silpi-paths";
import { getClaudeStatus } from "@/lib/execution/claude-cli";
import { run } from "@/lib/execution/http";
import { getExecutionSettings, latestJob } from "@/lib/execution/jobs";
import { reconcile } from "@/lib/execution/runner";
import { workspaceRoot } from "@/lib/execution/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/execution/status - admin only. Is Claude Code installed here, and is it signed in with a subscription?
 * It reports facts only: never a credential, an account email, a token or a folder path.
 */
export async function GET(request: NextRequest) {
  const denied = requireAdminOrDevStart(request);
  if (denied) return denied;
  return run("STATUS", async () => {
    reconcile();
    const settings = getExecutionSettings();
    const last = latestJob();
    return {
      // Only what the settings screen shows: no log, no folder path, no brief.
      lastExecution: last ? { projectName: last.projectName, state: last.state, mode: last.mode, finishedAt: last.finishedAt, updatedAt: last.updatedAt, error: last.error ? last.error.slice(0, 200) : null, verificationPassed: last.verification?.passed ?? null } : null,
      claude: await getClaudeStatus(settings),
      workspaceConfigured: workspaceRoot() !== null,
      apiAgentConfigured: getAgentDir() !== null,
    };
  });
}

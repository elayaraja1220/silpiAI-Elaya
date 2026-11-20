import { stat } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

import { PROJECT_NAME_RE, getAgentDir, getOutputRoot } from "@/lib/silpi-paths";
import { AgentUnavailableError, streamAgentRun } from "@/lib/silpi-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/projects/:name/resume
 * Continues a run that stopped early (budget, turn limit, crash, API error)
 * from its saved session; streams NDJSON progress.
 */
export async function POST(_request: NextRequest, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params;
  if (!PROJECT_NAME_RE.test(name)) {
    return NextResponse.json({ success: false, error: "Invalid project name." }, { status: 400 });
  }

  try {
    const agentDir = getAgentDir();
    if (agentDir) {
      const session = path.join(getOutputRoot(agentDir), name, ".silpi", "session.json");
      if (!(await stat(session).catch(() => null))) {
        return NextResponse.json(
          { success: false, error: `There is no interrupted run to resume for "${name}". Request a change instead.` },
          { status: 404 },
        );
      }
    }
    return await streamAgentRun({ mode: "resume", name });
  } catch (error) {
    if (error instanceof AgentUnavailableError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 503 });
    }
    console.error("SILPI RESUME ERROR:", error);
    return NextResponse.json({ success: false, error: "Could not start the SILPI agent." }, { status: 500 });
  }
}

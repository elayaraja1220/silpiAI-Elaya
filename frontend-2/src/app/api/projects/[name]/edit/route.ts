import { stat } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

import { PROJECT_NAME_RE, getAgentDir, getOutputRoot } from "@/lib/silpi-paths";
import { AgentUnavailableError, streamAgentRun } from "@/lib/silpi-runner";
import { ValidationError, validateAttachments } from "@/lib/silpi-validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/projects/:name/edit  { instruction, attachments? }
 * Asks the SILPI agent to change an existing project; streams NDJSON progress.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, error: "Request body must be JSON." }, { status: 400 });
  }

  try {
    if (!PROJECT_NAME_RE.test(name)) throw new ValidationError("Invalid project name.");

    const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
    if (!instruction) throw new ValidationError("Describe the change you want.");
    if (instruction.length > 20_000) throw new ValidationError("The request is longer than 20,000 characters.");

    const agentDir = getAgentDir();
    if (agentDir) {
      const projectDir = path.join(getOutputRoot(agentDir), name);
      const info = await stat(projectDir).catch(() => null);
      if (!info?.isDirectory()) {
        return NextResponse.json({ success: false, error: `Project "${name}" was not found.` }, { status: 404 });
      }
    }

    return await streamAgentRun({
      mode: "edit",
      name,
      instruction,
      attachments: validateAttachments(body.attachments),
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    if (error instanceof AgentUnavailableError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 503 });
    }
    console.error("SILPI EDIT ERROR:", error);
    return NextResponse.json({ success: false, error: "Could not start the SILPI agent." }, { status: 500 });
  }
}

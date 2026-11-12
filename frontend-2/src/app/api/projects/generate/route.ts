import { readdir } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

import { PROJECT_NAME_RE, getAgentDir, getOutputRoot } from "@/lib/silpi-paths";
import { AgentUnavailableError, streamAgentRun } from "@/lib/silpi-runner";
import { ValidationError, asStringArray, normalizeDesignUrl, validateAttachments } from "@/lib/silpi-validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/projects/generate
 * Starts the SILPI agent to build a new project and streams its progress
 * back as NDJSON (one AgentEvent per line).
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, error: "Request body must be JSON." }, { status: 400 });
  }

  try {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!PROJECT_NAME_RE.test(name)) {
      throw new ValidationError("Project name must be 1-60 characters: letters, numbers, hyphens or underscores, starting with a letter or number.");
    }

    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (!description) throw new ValidationError("Add a project description.");
    if (description.length > 30_000) throw new ValidationError("Description is longer than 30,000 characters.");

    const agentDir = getAgentDir();
    if (agentDir) {
      const projectDir = path.join(getOutputRoot(agentDir), name);
      const existing = await readdir(projectDir).catch(() => []);
      if (existing.some((entry) => entry !== ".silpi")) {
        return NextResponse.json(
          { success: false, error: `A project named "${name}" already exists. Choose another name, or open it in My projects to request changes.` },
          { status: 409 },
        );
      }
    }

    return await streamAgentRun({
      mode: "create",
      name,
      description,
      frontend: asStringArray(body.frontend),
      backend: asStringArray(body.backend),
      database: asStringArray(body.database),
      styling: asStringArray(body.styling),
      designUrl: normalizeDesignUrl(body.designUrl),
      attachments: validateAttachments(body.attachments),
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    if (error instanceof AgentUnavailableError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 503 });
    }
    console.error("SILPI GENERATE ERROR:", error);
    return NextResponse.json({ success: false, error: "Could not start the SILPI agent." }, { status: 500 });
  }
}

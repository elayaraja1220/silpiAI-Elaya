
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 600;

// ============================================
// TYPES
// ============================================

type GenerateRequest = {
  name: string;
  description: string;
  designUrl?: string;
  frontend: string[];
  backend: string[];
  database: string[];
  styling: string[];
};

type SilpiRunResult = {
  output: string;
  stdout: string;
  stderr: string;
};

class SilpiProcessError extends Error {
  constructor(
    message: string,
    public readonly output: string,
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly exitCode: number | null,
    public readonly signal: NodeJS.Signals | null,
  ) {
    super(message);
    this.name = "SilpiProcessError";
  }
}

// ============================================
// CONFIGURATION
// ============================================

const FRAMEWORKS: Record<string, string> = {
  "Next.js": "nextjs",
  React: "react",
  Angular: "angular",
  "Vue.js": "vue",
  "HTML / CSS / JS": "vanilla",
};

const BACKENDS: Record<string, string> = {
  "Node.js + Express": "node-express",
  PHP: "php",
  Laravel: "laravel",
};

const DATABASES: Record<string, string> = {
  MySQL: "mysql",
  PostgreSQL: "postgresql",
  MongoDB: "mongodb",
  SQLite: "sqlite",
};

const MAX_LOG_CHARS = 18_000;
const PROCESS_TIMEOUT_MS = 9 * 60 * 1000;

// ============================================
// HELPERS
// ============================================

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.filter(
    (item): item is string => typeof item === "string",
  );
}

function appendLog(current: string, chunk: Buffer): string {
  return (current + chunk.toString("utf8")).slice(-MAX_LOG_CHARS);
}

function getSafeErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Unexpected SILPI integration error.";
}

/**
 * Normalize and validate an optional design URL.
 *
 * Accepts:
 * https://www.figma.com/design/...
 * http://example.com
 * figma.com/design/...
 *
 * Empty values are allowed.
 */
function normalizeDesignUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  const input = value.trim();

  // Reject non-HTTP protocols explicitly.
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) &&
      !/^https?:\/\//i.test(input)) {
    throw new Error(
      "Design reference must use HTTP or HTTPS."
    );
  }

  const normalizedInput = /^https?:\/\//i.test(input)
    ? input
    : `https://${input}`;

  let parsed: URL;

  try {
    parsed = new URL(normalizedInput);
  } catch {
    throw new Error(
      "Invalid design reference. Enter a valid Figma, website or HTTP/HTTPS URL."
    );
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(
      "Design reference must use HTTP or HTTPS."
    );
  }

  if (!parsed.hostname || !parsed.hostname.includes(".")) {
    throw new Error(
      "Design reference must contain a valid hostname."
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error(
      "Design reference URLs cannot contain embedded credentials."
    );
  }

  return parsed.toString();
}

// ============================================
// SILPI AGENT PROCESS
// ============================================

function runSilpi(
  args: string[],
  cwd: string,
): Promise<SilpiRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const getOutput = () =>
      [
        "========== STDOUT ==========",
        stdout,
        "========== STDERR ==========",
        stderr,
      ].join("\n");

    const finish = (error?: Error) => {
      if (settled) return;

      settled = true;
      clearTimeout(timeout);

      if (error) {
        reject(error);
      } else {
        resolve({
          output: getOutput(),
          stdout,
          stderr,
        });
      }
    };

    // ----------------------------------------
    // STDOUT
    // ----------------------------------------

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLog(stdout, chunk);
    });

    // ----------------------------------------
    // STDERR
    // ----------------------------------------

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendLog(stderr, chunk);
    });

    // ----------------------------------------
    // TIMEOUT
    // ----------------------------------------

    const timeout = setTimeout(() => {
      child.kill();

      finish(
        new SilpiProcessError(
          "SILPI generation timed out. Check agent logs.",
          getOutput(),
          stdout,
          stderr,
          null,
          null,
        ),
      );
    }, PROCESS_TIMEOUT_MS);

    // ----------------------------------------
    // PROCESS ERROR
    // ----------------------------------------

    child.once("error", (error) => {
      finish(
        new SilpiProcessError(
          `Could not start SILPI agent: ${error.message}`,
          getOutput(),
          stdout,
          stderr,
          null,
          null,
        ),
      );
    });

    // ----------------------------------------
    // PROCESS CLOSE
    // ----------------------------------------

    child.once("close", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }

      finish(
        new SilpiProcessError(
          `SILPI agent exited with code ${code ?? "unknown"}.`,
          getOutput(),
          stdout,
          stderr,
          code,
          signal,
        ),
      );
    });
  });
}

// ============================================
// POST API
// ============================================

export async function POST(request: NextRequest) {
  try {
    // ----------------------------------------
    // 1. READ REQUEST
    // ----------------------------------------

    const body = (await request.json()) as Partial<GenerateRequest>;

    const name =
      typeof body.name === "string"
        ? body.name.trim()
        : "";

    const description =
      typeof body.description === "string"
        ? body.description.trim()
        : "";

    const frontend = asStringArray(body.frontend);
    const backend = asStringArray(body.backend);
    const database = asStringArray(body.database);
    const styling = asStringArray(body.styling);

    const rawDesignUrl = body.designUrl;

    // ----------------------------------------
    // 2. VALIDATE PROJECT NAME
    // ----------------------------------------

    if (
      !name ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/.test(name)
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Project name must be 1–60 characters and contain only letters, numbers, hyphens or underscores.",
        },
        { status: 400 },
      );
    }

    // ----------------------------------------
    // 3. VALIDATE DESCRIPTION
    // ----------------------------------------

    if (!description || description.length > 30_000) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Project description is required and must be 30,000 characters or fewer.",
        },
        { status: 400 },
      );
    }

    // ----------------------------------------
    // 4. VALIDATE FRONTEND
    // ----------------------------------------

    if (
      frontend.length !== 1 ||
      !FRAMEWORKS[frontend[0]]
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Select one supported frontend: Next.js, React, Angular, Vue.js or HTML / CSS / JS.",
        },
        { status: 400 },
      );
    }

    // ----------------------------------------
    // 5. VALIDATE BACKEND
    // ----------------------------------------

    if (
      backend.length > 1 ||
      backend.some((item) => !BACKENDS[item])
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Unsupported backend. Supported: Node.js + Express, PHP, Laravel.",
        },
        { status: 400 },
      );
    }

    // ----------------------------------------
    // 6. VALIDATE DATABASE
    // ----------------------------------------

    if (
      database.length > 1 ||
      database.some((item) => !DATABASES[item])
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Unsupported database. Supported: MySQL, PostgreSQL, MongoDB, SQLite.",
        },
        { status: 400 },
      );
    }

    // ----------------------------------------
    // 7. VALIDATE AND NORMALIZE DESIGN URL
    // ----------------------------------------

    let designUrl = "";

    try {
      designUrl = normalizeDesignUrl(rawDesignUrl);
    } catch (error) {
      return NextResponse.json(
        {
          success: false,
          error: getSafeErrorMessage(error),
        },
        { status: 400 },
      );
    }

    // ----------------------------------------
    // 8. AGENT DIRECTORY
    // ----------------------------------------

    const agentDir = process.env.SILPI_AGENT_DIR;

    if (!agentDir) {
      return NextResponse.json(
        {
          success: false,
          error:
            "SILPI_AGENT_DIR is not configured in frontend-2/.env.local.",
        },
        { status: 500 },
      );
    }

    const resolvedAgentDir = path.resolve(agentDir);

    const packagePath = path.join(
      resolvedAgentDir,
      "package.json",
    );

    const cliPath = path.join(
      resolvedAgentDir,
      "dist",
      "src",
      "cli",
      "index.js",
    );

    // ----------------------------------------
    // 9. VALIDATE AGENT FILES
    // ----------------------------------------

    try {
      await access(packagePath, constants.R_OK);
      await access(cliPath, constants.R_OK);
    } catch (error) {
      console.error("SILPI FILE VALIDATION ERROR:", error);

      return NextResponse.json(
        {
          success: false,
          error:
            "SILPI agent files were not found. Check SILPI_AGENT_DIR and run npm run build inside the silpi-ai folder.",
          agentDir: resolvedAgentDir,
          expectedCli: cliPath,
        },
        { status: 500 },
      );
    }

    // ----------------------------------------
    // 10. PREPARE PROJECT OPTIONS
    // ----------------------------------------

    const selectedFramework = FRAMEWORKS[frontend[0]];

    const selectedBackend = backend[0]
      ? BACKENDS[backend[0]]
      : "none";

    const selectedDatabase = database[0]
      ? DATABASES[database[0]]
      : "none";

    // ----------------------------------------
    // 11. PREPARE AI PROMPT
    // ----------------------------------------

    const promptParts = [
      description,
      styling.length
        ? `Preferred styling: ${styling.join(", ")}.`
        : "",
      designUrl
        ? `Design reference: ${designUrl}`
        : "",
    ].filter(Boolean);

    const finalPrompt = promptParts.join("\n\n");

    // ----------------------------------------
    // 12. PREPARE CLI ARGUMENTS
    // ----------------------------------------

    const args = [
      cliPath,
      "create",
      finalPrompt,
      "--name",
      name,
      "--framework",
      selectedFramework,
      "--backend",
      selectedBackend,
      "--database",
      selectedDatabase,
      "--scope",
      "standard",
    ];

    console.log("=================================");
    console.log("SILPI PROJECT GENERATION STARTED");
    console.log("=================================");

    console.log("Project Name:", name);
    console.log("Agent Directory:", resolvedAgentDir);
    console.log("Framework:", selectedFramework);
    console.log("Backend:", selectedBackend);
    console.log("Database:", selectedDatabase);
    console.log("Design Reference:", designUrl || "Not provided");
    console.log("Node Executable:", process.execPath);

    // ----------------------------------------
    // 13. RUN SILPI AGENT
    // ----------------------------------------

    const result = await runSilpi(
      args,
      resolvedAgentDir,
    );

    console.log("SILPI AGENT COMPLETED");
    console.log("STDOUT:", result.stdout);
    console.log("STDERR:", result.stderr);

    // ----------------------------------------
    // 14. PROJECT OUTPUT PATH
    // ----------------------------------------

    const outputRoot = path.resolve(
      resolvedAgentDir,
      process.env.SILPI_OUTPUT_DIR ||
        "../generated-projects",
    );

    const projectPath = path.join(
      outputRoot,
      name,
    );

    // ----------------------------------------
    // 15. SUCCESS RESPONSE
    // ----------------------------------------

    return NextResponse.json({
      success: true,
      message:
        "SILPI generated the project successfully.",
      projectName: name,
      projectPath,
      output: result.output,
      note:
        "The CLI generates the project directly. Uploaded files are not parsed by this integration.",
    });

  } catch (error) {
    // ========================================
    // AGENT PROCESS ERROR
    // ========================================

    if (error instanceof SilpiProcessError) {
      console.error("=================================");
      console.error("SILPI AGENT FAILED");
      console.error("=================================");

      console.error("Error:", error.message);
      console.error("Exit Code:", error.exitCode);
      console.error("Signal:", error.signal);
      console.error("STDOUT:", error.stdout);
      console.error("STDERR:", error.stderr);

      const isDevelopment =
        process.env.NODE_ENV !== "production";

      return NextResponse.json(
        {
          success: false,
          error: error.message,
          exitCode: error.exitCode,
          signal: error.signal,
          ...(isDevelopment
            ? {
                details: error.output,
                stdout: error.stdout,
                stderr: error.stderr,
              }
            : {}),
        },
        { status: 500 },
      );
    }

    // ========================================
    // OTHER API ERRORS
    // ========================================

    const message = getSafeErrorMessage(error);

    console.error("SILPI API ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        error: message,
      },
      { status: 500 },
    );
  }
}

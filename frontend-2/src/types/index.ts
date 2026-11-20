export type ProjectStatus = "Ready" | "Generating" | "Needs attention" | "Draft";
export type Project = {
  id: string;
  name: string;
  description: string;
  frontend: string;
  backend: string;
  database: string;
  status: ProjectStatus;
  /** ISO timestamp of the project folder's last modification. */
  updatedAt: string;
  progress?: number;
  /** Absolute path of the generated project on disk. */
  path?: string;
  /** A run stopped early and can continue from its saved session. */
  resumable?: boolean;
  /** Total Anthropic API cost of all SILPI runs on this project, in USD. */
  costUsd?: number;
};
export type AgentInfo = { configured: boolean; built: boolean; hasApiKey: boolean };
export type ProjectsResponse = {
  success: boolean;
  error?: string;
  agent: AgentInfo;
  outputRoot?: string;
  projects: Project[];
};
export type TechnologyGroup = "Frontend" | "Backend" | "Database" | "Styling" | "Language" | "Package manager";
export type Technology = { name: string; group: TechnologyGroup; detail?: string };

/** Progress events streamed from the SILPI agent (mirrors silpi-agent/src/events.ts). */
export type SmokeTarget = { folder: string; script: string; ok: boolean; url?: string; status?: number; detail: string };

export type AgentEvent =
  | {
      type: "start";
      mode: "create" | "edit" | "resume";
      project: string;
      path: string;
      model: string;
      sandbox: "local" | "docker";
      budgetUsd: number;
    }
  | { type: "status"; message: string }
  | { type: "message"; text: string }
  | { type: "action"; tool: string; label: string }
  | { type: "result"; tool: string; ok: boolean; label: string; detail?: string }
  | {
      type: "usage";
      turn: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costUsd: number;
      totalCostUsd: number;
    }
  | { type: "smoke"; ran: boolean; ok: boolean; note?: string; targets: SmokeTarget[] }
  | {
      type: "done";
      success: boolean;
      summary: string;
      path: string;
      filesChanged: string[];
      turns: number;
      buildPassed: boolean | null;
      /** null = the app was not started (static site, non-Node stack, or the build failed). */
      appStarted: boolean | null;
      /** Total API cost in USD, including earlier runs that were resumed. */
      costUsd: number;
      resumable: boolean;
    }
  | { type: "error"; message: string };

/** A document attached to a run, base64-encoded. */
export type AgentAttachment = { name: string; mediaType: string; data: string };

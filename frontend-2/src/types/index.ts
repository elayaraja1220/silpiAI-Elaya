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
export type AgentEvent =
  | { type: "start"; mode: "create" | "edit"; project: string; path: string; model: string }
  | { type: "status"; message: string }
  | { type: "message"; text: string }
  | { type: "action"; tool: string; label: string }
  | { type: "result"; tool: string; ok: boolean; label: string; detail?: string }
  | { type: "usage"; turn: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  | { type: "done"; success: boolean; summary: string; path: string; filesChanged: string[]; turns: number; buildPassed: boolean | null }
  | { type: "error"; message: string };

/** A document attached to a run, base64-encoded. */
export type AgentAttachment = { name: string; mediaType: string; data: string };

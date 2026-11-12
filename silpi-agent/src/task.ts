import { z } from "zod";

import { PROJECT_NAME_RE } from "./config.js";

export const ATTACHMENT_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
] as const;

const Attachment = z.object({
  name: z.string().min(1).max(200),
  mediaType: z.enum(ATTACHMENT_TYPES),
  /** Base64-encoded file content. */
  data: z.string().min(1),
});

const techList = z.array(z.string().min(1).max(60)).max(6).default([]);
const projectName = z.string().regex(PROJECT_NAME_RE, "Project name must be 1-60 letters, numbers, hyphens or underscores.");

export const TaskSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("create"),
    name: projectName,
    description: z.string().trim().min(1).max(30_000),
    frontend: techList,
    backend: techList,
    database: techList,
    styling: techList,
    designUrl: z.string().url().max(2_000).optional().or(z.literal("")),
    attachments: z.array(Attachment).max(10).default([]),
  }),
  z.object({
    mode: z.literal("edit"),
    name: projectName,
    instruction: z.string().trim().min(1).max(20_000),
    attachments: z.array(Attachment).max(10).default([]),
  }),
]);

export type Task = z.infer<typeof TaskSchema>;
export type CreateTask = Extract<Task, { mode: "create" }>;
export type EditTask = Extract<Task, { mode: "edit" }>;
export type TaskAttachment = z.infer<typeof Attachment>;

/** Stored in <project>/.silpi/meta.json so later edits and the frontend know the stack. */
export type ProjectMeta = {
  name: string;
  description: string;
  stack: { frontend: string[]; backend: string[]; database: string[]; styling: string[] };
  designUrl?: string;
  createdAt: string;
  history: Array<{
    mode: "create" | "edit";
    request: string;
    at: string;
    success: boolean;
    buildPassed: boolean | null;
    filesChanged: number;
    turns: number;
  }>;
};

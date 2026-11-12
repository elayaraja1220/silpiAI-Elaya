import type { AgentAttachment } from "@/types";

/** Server-side validation shared by the generate and edit routes. */

export class ValidationError extends Error {}

export const ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);
const MAX_ATTACHMENTS = 10;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export function asStringArray(value: unknown, max = 6): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 60))
    .slice(0, max);
}

/** Normalise an optional design URL; empty is allowed. */
export function normalizeDesignUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const input = value.trim();

  if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^https?:\/\//i.test(input)) {
    throw new ValidationError("Design reference must use HTTP or HTTPS.");
  }
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new ValidationError("Invalid design reference. Enter a valid Figma, website or HTTP/HTTPS URL.");
  }
  if (!parsed.hostname.includes(".")) throw new ValidationError("Design reference must contain a valid hostname.");
  if (parsed.username || parsed.password) throw new ValidationError("Design reference URLs cannot contain embedded credentials.");
  return parsed.toString();
}

export function validateAttachments(value: unknown): AgentAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError("Attachments must be a list.");
  if (value.length > MAX_ATTACHMENTS) throw new ValidationError(`Attach at most ${MAX_ATTACHMENTS} files.`);

  let total = 0;
  return value.map((item) => {
    const file = item as Partial<AgentAttachment>;
    if (typeof file.name !== "string" || typeof file.data !== "string" || typeof file.mediaType !== "string") {
      throw new ValidationError("Each attachment needs a name, type and content.");
    }
    if (!ATTACHMENT_TYPES.has(file.mediaType)) {
      throw new ValidationError(`"${file.name}" is not a supported file type. Use PDF, images, TXT, MD, CSV or JSON.`);
    }
    if (!/^[A-Za-z0-9+/]+=*$/.test(file.data)) throw new ValidationError(`"${file.name}" could not be read.`);
    const bytes = Math.floor((file.data.length * 3) / 4);
    if (bytes > MAX_FILE_BYTES) throw new ValidationError(`"${file.name}" is larger than 5 MB.`);
    total += bytes;
    if (total > MAX_TOTAL_BYTES) throw new ValidationError("Attachments are larger than 20 MB in total.");
    return { name: file.name.slice(0, 200), mediaType: file.mediaType, data: file.data };
  });
}

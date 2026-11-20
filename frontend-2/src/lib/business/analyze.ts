import { spawn } from "node:child_process";

import { assertAgentReady } from "@/lib/silpi-runner";

import { ValidationError } from "./validate";

/**
 * Server-only. Checks uploaded requirement documents and asks the SILPI agent
 * (`analyze` command) to read them. The API key stays inside the agent; this
 * web server never sees it.
 */

export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 3 * 60 * 1000;

const TYPES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
};

/** The file's first bytes must match its extension, so a renamed file cannot slip through. */
function contentMatches(mediaType: string, bytes: Buffer): boolean {
  const head = (n: number) => bytes.subarray(0, n);
  switch (mediaType) {
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      // A .docx is a zip that contains word/document.xml (names are stored uncompressed).
      return head(4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && bytes.includes(Buffer.from("word/document.xml"));
    case "application/pdf":
      return head(5).toString("latin1") === "%PDF-";
    case "image/png":
      return head(8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/webp":
      return head(4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
    case "image/gif":
      return head(4).toString("latin1") === "GIF8";
    default: {
      // Text: valid UTF-8 and no NUL bytes (rules out binaries renamed to .txt).
      if (bytes.includes(0)) return false;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return true;
      } catch {
        return false;
      }
    }
  }
}

export type UploadedDoc = { name: string; mediaType: string; data: string };

export async function readUploads(files: File[]): Promise<UploadedDoc[]> {
  if (files.length > MAX_FILES) throw new ValidationError(`Upload at most ${MAX_FILES} files.`);
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_TOTAL_BYTES) throw new ValidationError("Files together must be 20 MB or less.");

  const docs: UploadedDoc[] = [];
  for (const file of files) {
    const name = file.name.replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "document";
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "doc") {
      throw new ValidationError(`${name}: old .doc files are not supported. In Word, use File > Save As > Word Document (.docx) or PDF.`);
    }
    const mediaType = TYPES[ext];
    if (!mediaType) throw new ValidationError(`${name}: only Word (.docx), PDF, PNG, JPG, WEBP, GIF, TXT, MD and CSV files are accepted.`);
    if (file.size === 0) throw new ValidationError(`${name} is empty.`);
    if (file.size > MAX_FILE_BYTES) throw new ValidationError(`${name} is larger than 10 MB.`);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!contentMatches(mediaType, bytes)) throw new ValidationError(`${name} does not look like a real .${ext} file.`);
    docs.push({ name, mediaType, data: bytes.toString("base64") });
  }
  return docs;
}

export type AnalyzeResult = { success: true; draft: Record<string, unknown>; model: string; costUsd: number } | { success: false; error: string };

export async function runAnalysis(attachments: UploadedDoc[], notes: string): Promise<AnalyzeResult> {
  const { agentDir, cliPath } = await assertAgentReady();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, "analyze"], { cwd: agentDir, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ success: false, error: "Analysis took too long. Try a smaller document." });
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 1_000_000) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ success: false, error: `Could not start the SILPI agent: ${error.message}` });
    });
    child.on("close", () => {
      clearTimeout(timer);
      const last = stdout.trim().split("\n").pop() ?? "";
      try {
        resolve(JSON.parse(last) as AnalyzeResult);
      } catch {
        if (stderr) console.error("SILPI ANALYZE STDERR:", stderr);
        resolve({ success: false, error: "The SILPI agent returned no result. Rebuild it with npm run build in silpi-agent." });
      }
    });
    child.stdin.end(JSON.stringify({ attachments, notes }));
  });
}

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  ASSET_STATUSES,
  MAX_FILES_PER_ITEM,
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  assetsOpen,
  buildChecklist,
  extensionOf,
  isAllowedFile,
  safeFileName,
  type AssetFile,
  type AssetGroup,
  type AssetKind,
  type AssetStatus,
  type ClientAsset,
  isDesignKey,
  isPageDesignKey,
  brandStyleLines,
  isBrandStyleText,
  parseBrandStyle,
  serializeBrandStyle,
} from "./assets";
import { getDb, transaction } from "./db";
import { StageError } from "./store";
import type { Lead } from "./types";
import { ValidationError } from "./validate";

/** Server-only storage for client assets. Metadata in SQLite, files on disk (never inside the web root). */

const now = () => new Date().toISOString();
const root = () => path.resolve(process.env.SILPI_ASSETS_DIR || path.join(process.cwd(), "storage", "client-assets"));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const leadDir = (leadId: string) => {
  if (!UUID.test(leadId)) throw new ValidationError("That project id is not valid.");
  return path.join(root(), leadId);
};

type AssetRow = { id: string; key: string; group_name: string; label: string; hint: string; kind: string; required: number; status: string; text: string; note: string; updated_at: string };
type FileRow = { id: string; asset_id: string; name: string; mime: string; size: number; uploaded_at: string; uploaded_by: string };

/** Creates the checklist for an approved lead. Safe to call again: it only adds items that are missing. */
export function ensureChecklist(lead: Lead): void {
  if (!assetsOpen(lead.stage)) return;
  const scope = lead.quotation?.requirement ?? lead.requirement;
  const wanted = buildChecklist(scope);
  transaction((db) => {
    const have = new Set((db.prepare("SELECT key FROM client_assets WHERE lead_id = ?").all(lead.id) as { key: string }[]).map((r) => r.key));
    const insert = db.prepare("INSERT INTO client_assets (id, lead_id, key, position, group_name, label, hint, kind, required, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    // Wording and type are refreshed on existing rows too, so an improved hint reaches checklists made earlier.
    const refresh = db.prepare("UPDATE client_assets SET label = ?, hint = ?, kind = ?, group_name = ?, position = ? WHERE lead_id = ? AND key = ? AND (label != ? OR hint != ? OR kind != ? OR group_name != ? OR position != ?)");
    wanted.forEach((t, i) => {
      if (!have.has(t.key)) insert.run(randomUUID(), lead.id, t.key, i, t.group, t.label, t.hint, t.kind, t.required ? 1 : 0, now());
      else refresh.run(t.label, t.hint, t.kind, t.group, i, lead.id, t.key, t.label, t.hint, t.kind, t.group, i);
    });
  });
}

export function listAssets(leadId: string): ClientAsset[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM client_assets WHERE lead_id = ? ORDER BY position, key").all(leadId) as AssetRow[];
  const files = db.prepare("SELECT id, asset_id, name, mime, size, uploaded_at, uploaded_by FROM asset_files WHERE lead_id = ? ORDER BY uploaded_at").all(leadId) as FileRow[];
  const byAsset = new Map<string, AssetFile[]>();
  for (const f of files) {
    const list = byAsset.get(f.asset_id) ?? [];
    list.push({ id: f.id, name: f.name, size: f.size, mime: f.mime, uploadedAt: f.uploaded_at, by: f.uploaded_by === "team" ? "team" : "client" });
    byAsset.set(f.asset_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    group: r.group_name as AssetGroup,
    label: r.label,
    hint: r.hint,
    kind: r.kind as AssetKind,
    required: r.required === 1,
    status: (ASSET_STATUSES as readonly string[]).includes(r.status) ? (r.status as AssetStatus) : "pending",
    text: r.text,
    note: r.note,
    files: byAsset.get(r.id) ?? [],
    updatedAt: r.updated_at,
  }));
}

function getAsset(leadId: string, assetId: string): AssetRow {
  if (!UUID.test(assetId)) throw new ValidationError("That item is not valid.");
  const row = getDb().prepare("SELECT * FROM client_assets WHERE id = ? AND lead_id = ?").get(assetId, leadId) as AssetRow | undefined;
  if (!row) throw new ValidationError("That item was not found.");
  return row;
}

/** The brand colours and fonts item is filled by a form, so it is checked strictly on the server too. */
function cleanText(key: string, text: string): string {
  if (key !== "brand-style" || text.trim() === "") return text;
  try {
    return serializeBrandStyle(JSON.parse(text));
  } catch (e) {
    throw new ValidationError(e instanceof SyntaxError ? "The colours and fonts could not be read." : (e as Error).message);
  }
}

/** Team: set the status, leave a note for the client, or edit the text. Strictly validated. */
export function updateAsset(leadId: string, assetId: string, patch: { status?: unknown; note?: unknown; text?: unknown }): void {
  const row = getAsset(leadId, assetId);
  let status = row.status;
  let note = row.note;
  let text = row.text;
  if (patch.status !== undefined) {
    if (!(ASSET_STATUSES as readonly string[]).includes(patch.status as string)) throw new ValidationError("Unknown status.");
    status = patch.status as string;
  }
  if (patch.note !== undefined) note = typeof patch.note === "string" ? patch.note.trim().slice(0, 500) : "";
  if (patch.text !== undefined) text = typeof patch.text === "string" ? cleanText(row.key, patch.text.slice(0, MAX_TEXT_CHARS)) : "";
  if (status === "redo" && !note) throw new ValidationError("Tell the client what to send again (add a short note).");
  getDb().prepare("UPDATE client_assets SET status = ?, note = ?, text = ?, updated_at = ? WHERE id = ?").run(status, note, text, now(), assetId);
}

/** Client: save typed content for an item. A new answer moves "pending" and "redo" items to "sent, to check". */
export function saveText(leadId: string, assetId: string, value: unknown): void {
  const row = getAsset(leadId, assetId);
  if (row.kind === "files") throw new ValidationError("This item takes files, not typed text.");
  if (row.status === "received") throw new StageError("We have already received and checked this item. Please contact us to change it.");
  const text = typeof value === "string" ? cleanText(row.key, value.slice(0, MAX_TEXT_CHARS)) : "";
  const status = text.trim() ? (row.status === "pending" || row.status === "redo" ? "submitted" : row.status) : row.status;
  getDb().prepare("UPDATE client_assets SET text = ?, status = ?, updated_at = ? WHERE id = ?").run(text, status, now(), assetId);
}

export type IncomingFile = { name: string; bytes: Buffer };

/** Stores uploaded files for an item. Everything is checked here: count, size, type, name. */
export function saveFiles(leadId: string, assetId: string, incoming: IncomingFile[], by: "client" | "team"): number {
  const row = getAsset(leadId, assetId);
  if (row.kind === "text") throw new ValidationError("This item takes typed text, not files.");
  if (by === "client" && row.status === "received") throw new StageError("We have already received and checked this item. Please contact us to change it.");
  if (incoming.length === 0) throw new ValidationError("Choose at least one file.");
  const existing = (getDb().prepare("SELECT COUNT(*) AS n FROM asset_files WHERE asset_id = ?").get(assetId) as { n: number }).n;
  if (existing + incoming.length > MAX_FILES_PER_ITEM) throw new ValidationError(`At most ${MAX_FILES_PER_ITEM} files for one item. Put the rest in a ZIP file.`);
  for (const f of incoming) {
    if (f.bytes.length === 0) throw new ValidationError(`"${safeFileName(f.name)}" is empty.`);
    if (f.bytes.length > MAX_FILE_BYTES) throw new ValidationError(`"${safeFileName(f.name)}" is larger than ${MAX_FILE_BYTES / 1048576} MB. Please send it as a smaller file or share a download link in the note.`);
    if (!isAllowedFile(f.name)) throw new ValidationError(`"${safeFileName(f.name)}" is not an accepted file type.`);
  }
  const dir = leadDir(leadId);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  try {
    transaction((db) => {
      const insert = db.prepare("INSERT INTO asset_files (id, asset_id, lead_id, name, stored, mime, size, uploaded_at, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const f of incoming) {
        const id = randomUUID();
        const stored = `${id}.${extensionOf(f.name)}`;
        writeFileSync(path.join(dir, stored), f.bytes);
        written.push(path.join(dir, stored));
        insert.run(id, assetId, leadId, safeFileName(f.name), stored, "application/octet-stream", f.bytes.length, now(), by);
      }
      if (by === "client" && (row.status === "pending" || row.status === "redo")) {
        db.prepare("UPDATE client_assets SET status = 'submitted', updated_at = ? WHERE id = ?").run(now(), assetId);
      } else {
        db.prepare("UPDATE client_assets SET updated_at = ? WHERE id = ?").run(now(), assetId);
      }
    });
  } catch (error) {
    for (const p of written) rmSync(p, { force: true });
    throw error;
  }
  return incoming.length;
}

type StoredFile = { id: string; asset_id: string; name: string; stored: string };
function getFileRow(leadId: string, fileId: string): StoredFile {
  if (!UUID.test(fileId)) throw new ValidationError("That file is not valid.");
  const row = getDb().prepare("SELECT id, asset_id, name, stored FROM asset_files WHERE id = ? AND lead_id = ?").get(fileId, leadId) as StoredFile | undefined;
  if (!row) throw new ValidationError("That file was not found.");
  return row;
}

export function removeFile(leadId: string, fileId: string, by: "client" | "team"): void {
  const file = getFileRow(leadId, fileId);
  if (by === "client") {
    const asset = getDb().prepare("SELECT status FROM client_assets WHERE id = ?").get(file.asset_id) as { status: string } | undefined;
    if (asset?.status === "received") throw new StageError("We have already received and checked this item. Please contact us to change it.");
  }
  getDb().prepare("DELETE FROM asset_files WHERE id = ?").run(fileId);
  rmSync(path.join(leadDir(leadId), file.stored), { force: true });
  // An item with nothing left goes back to waiting.
  const left = (getDb().prepare("SELECT COUNT(*) AS n FROM asset_files WHERE asset_id = ?").get(file.asset_id) as { n: number }).n;
  const asset = getDb().prepare("SELECT status, text FROM client_assets WHERE id = ?").get(file.asset_id) as { status: string; text: string } | undefined;
  if (asset && left === 0 && !asset.text.trim() && asset.status === "submitted") {
    getDb().prepare("UPDATE client_assets SET status = 'pending', updated_at = ? WHERE id = ?").run(now(), file.asset_id);
  }
}

/** Team download. The path is built from the stored name only, never from the request. */
export function readFile(leadId: string, fileId: string): { name: string; bytes: Buffer } {
  const file = getFileRow(leadId, fileId);
  const full = path.join(leadDir(leadId), file.stored);
  if (!existsSync(full)) throw new ValidationError("The file is missing on disk.");
  return { name: file.name, bytes: readFileSync(full) };
}

/** Removes every stored file of a lead (used when the lead is deleted). */
export function removeLeadFiles(leadId: string): void {
  if (!UUID.test(leadId)) return;
  rmSync(path.join(root(), leadId), { recursive: true, force: true });
}

// ---- readiness and hand-over to the generator ------------------------------------------------------------------------

export type ContentExport = { items: number; files: number; missing: string[]; /** The design reference images and PDFs, as paths inside the project folder. */ design?: string[] };

const folder = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";

/**
 * Copies what the client sent into the project folder, where the generator can read it:
 *   .silpi/client-content.md          the typed content and an index of every file
 *   .silpi/client-assets/<group>/<item>/<file>
 * Items the client has not provided are listed so the generator uses clearly marked placeholders for them.
 */
export function exportContent(leadId: string, projectDir: string): ContentExport {
  const assets = listAssets(leadId);
  const base = path.join(projectDir, ".silpi", "client-assets");
  mkdirSync(base, { recursive: true });
  const lines: string[] = [
    "# The client's original content",
    "",
    "The client supplied this for the project. Use it exactly as given: do not rewrite the wording, redraw logos or replace the photos.",
    "Copy the files you need from `.silpi/client-assets/` into the site's own images or content folders (copy, do not move). Do not publish the `.silpi` folder.",
    "",
  ];
  const missing: string[] = [];
  const design: string[] = [];
  // The design section lists the general reference and each page's design, under one heading.
  const designBody: string[] = [];
  const headerLength = lines.length;
  let files = 0;
  let items = 0;
  let group = "";
  for (const a of assets) {
    const has = a.files.length > 0 || a.text.trim().length > 0;
    if (!has) {
      if (a.key !== "other-files" && !isDesignKey(a.key)) missing.push(a.label);
      continue;
    }
    items += 1;
    if (isDesignKey(a.key)) {
      const forPage = isPageDesignKey(a.key) ? a.label.replace(/ page: design$/, "") : "";
      // The design to follow gets its own section at the top of the file. Its images are listed first and are never "pictures to place on a page".
      const dir = path.join(base, folder(a.group), folder(a.key));
      mkdirSync(dir, { recursive: true });
      const used = new Set<string>();
      for (const f of a.files) {
        let name = safeFileName(f.name);
        while (used.has(name.toLowerCase())) name = `${used.size}-${name}`;
        used.add(name.toLowerCase());
        const stored = (getDb().prepare("SELECT stored FROM asset_files WHERE id = ?").get(f.id) as { stored: string } | undefined)?.stored;
        const source = stored ? path.join(leadDir(leadId), stored) : "";
        if (source && existsSync(source)) {
          writeFileSync(path.join(dir, name), readFileSync(source));
          const rel = `.silpi/client-assets/${folder(a.group)}/${folder(a.key)}/${name}`;
          files += 1;
          if (/\.(png|jpe?g|webp|gif|pdf)$/i.test(name)) design.push(rel);
          designBody.push(`- \`${rel}\`${forPage ? ` (the design of the ${forPage} page)` : ""}`);
        }
      }
      if (a.text.trim()) designBody.push("", `Note about the design${forPage ? ` of the ${forPage} page` : ""}:`, "", a.text.trim(), "");
      continue;
    }
    if (a.group !== group) { group = a.group; lines.push(`## ${a.group}`, ""); }
    lines.push(`### ${a.label}`, `Status: ${a.status === "received" ? "received and checked" : "sent by the client, not yet checked"}.`);
    if (a.files.length) {
      const dir = path.join(base, folder(a.group), folder(a.key));
      mkdirSync(dir, { recursive: true });
      const used = new Set<string>();
      for (const f of a.files) {
        let name = safeFileName(f.name);
        while (used.has(name.toLowerCase())) name = `${used.size}-${name}`;
        used.add(name.toLowerCase());
        const stored = (getDb().prepare("SELECT stored FROM asset_files WHERE id = ?").get(f.id) as { stored: string } | undefined)?.stored;
        const source = stored ? path.join(leadDir(leadId), stored) : "";
        if (source && existsSync(source)) {
          writeFileSync(path.join(dir, name), readFileSync(source));
          lines.push(`- File: \`.silpi/client-assets/${folder(a.group)}/${folder(a.key)}/${name}\``);
          files += 1;
        }
      }
    }
    if (a.key === "brand-style" && isBrandStyleText(a.text)) {
      const style = parseBrandStyle(a.text);
      lines.push("", ...brandStyleLines(style));
      const css = style.fonts.filter((f) => f.source === "imported" && f.css).map((f) => `/* ${f.name} */\n${f.css}`).join("\n\n");
      if (css) writeFileSync(path.join(projectDir, ".silpi", "brand-fonts.css"), css + "\n");
    } else if (a.text.trim()) lines.push("", "Text from the client:", "", a.text.trim());
    lines.push("");
  }
  if (missing.length) {
    lines.push("## Not provided yet", "", "The client has not sent these. Use obviously marked placeholders (for example the word \"Placeholder\" in the text, a plain grey image box) and never present invented text, names or logos as real:", "");
    for (const m of missing) lines.push(`- ${m}`);
    lines.push("");
  }
  if (designBody.length > 0) {
    lines.splice(
      headerLength, 0,
      "## Design reference: reproduce this design completely", "",
      "These images are the design the client chose. Do not place them on a page as pictures. Open each one and build the website to look and work like it: every section, every element, the same layout and proportions. A file marked as the design of a page is the design of that page only: build that page from it. See the design rules in your instructions.", "",
      "Files:", ...designBody, "",
    );
  }
  writeFileSync(path.join(projectDir, ".silpi", "client-content.md"), lines.join("\n"));
  return { items, files, missing, ...(design.length ? { design } : {}) };
}

/** How many checklist items have something uploaded or typed (partial is enough to start a project, none is not). */
export function contentItemCount(leadId: string): number {
  return listAssets(leadId).filter((a) => a.files.length > 0 || a.text.trim().length > 0).length;
}

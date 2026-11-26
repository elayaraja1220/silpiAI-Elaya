/**
 * Which of the client's files the AI actually READS, and what it is told about the rest.
 *
 * There is no limit on how many files can be added: a client may send 5 documents or 1,000 page designs. What is limited is what the AI can read in one go
 * (its request has a size ceiling, every image and PDF page costs tokens, and the whole thing must finish in a few minutes). So the AI reads a sample:
 * the written documents first, then page images spread evenly from the first to the last. It is also given the TOTAL number of files and all their names,
 * so it knows how big the job is (for design pages, the number of files is the number of pages). Nothing is thrown away: the other files are simply not
 * read for this step, and belong in the client's files for the project itself.
 *
 * Pure functions, shared by the browser (to choose) and the server (to describe), so both agree. No imports from Node.
 */
export type FileInfo = { name: string; size: number };

export const READ_FILES = 12; // how many files the AI is shown at most
export const READ_DOCUMENTS = 5; // of those, at most this many written documents
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // a single file larger than this is not read (still counted)
export const READ_TOTAL_BYTES = 18 * 1024 * 1024; // what is sent together stays under the AI request's size ceiling after it grows by a third in transit
export const MAX_LISTED = 20_000; // the most file names the server will accept in a list
const MAX_NAMES_IN_NOTE = 150;
const NOTE_LIMIT = 5000;

const DOCUMENT = /\.(docx|pdf|txt|md|csv)$/i;
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
export const isDocument = (name: string) => DOCUMENT.test(name);
export const isImage = (name: string) => IMAGE.test(name);

/** "page2" before "page10": names compared with their numbers as numbers, so a numbered set stays in page order. */
export const naturalCompare = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

/**
 * The positions (in the order given) of the files to read: up to READ_DOCUMENTS documents, then page images spread evenly (the first and the last are
 * always included) until READ_FILES files are chosen, then trimmed from the biggest image down until they fit READ_TOTAL_BYTES. Files over the
 * single-file size are never chosen. Returned in natural name order.
 */
export function chooseSample(files: FileInfo[]): number[] {
  const order = files.map((_, i) => i).sort((a, b) => naturalCompare(files[a]!.name, files[b]!.name));
  const readable = order.filter((i) => files[i]!.size > 0 && files[i]!.size <= MAX_FILE_BYTES);
  const docs = readable.filter((i) => isDocument(files[i]!.name)).slice(0, READ_DOCUMENTS);
  const images = readable.filter((i) => isImage(files[i]!.name));
  const room = Math.max(0, READ_FILES - docs.length);
  let pickedImages: number[];
  if (images.length <= room) pickedImages = images;
  else if (room === 0) pickedImages = [];
  else if (room === 1) pickedImages = [images[0]!];
  else pickedImages = Array.from({ length: room }, (_, k) => images[Math.round((k * (images.length - 1)) / (room - 1))]!);
  const chosen = new Set([...docs, ...pickedImages]);
  const size = (i: number) => files[i]!.size;
  let total = [...chosen].reduce((n, i) => n + size(i), 0);
  while (total > READ_TOTAL_BYTES && chosen.size > 1) {
    // Drop the biggest image first; documents only when no image is left.
    const pool = [...chosen].filter((i) => isImage(files[i]!.name));
    const victims = pool.length ? pool : [...chosen];
    const biggest = victims.reduce((a, b) => (size(b) > size(a) ? b : a));
    chosen.delete(biggest);
    total -= size(biggest);
  }
  return order.filter((i) => chosen.has(i));
}

/**
 * How long reading takes, from what is being read. These are ROUGH planning figures, not measurements: a written document takes the AI a few seconds, each
 * image or PDF page a few more, and several readings run side by side (so they do not add up). Shown to the person so that a long wait is expected, and used to
 * give the server enough time before it gives up (it never waits less than 3 minutes, never more than 4.5).
 */
export function readingEstimate(sample: FileInfo[]): { minSeconds: number; maxSeconds: number } {
  const images = sample.filter((f) => isImage(f.name)).length;
  const docs = sample.length - images;
  const minSeconds = Math.min(230, 10 + 2 * images + 3 * docs);
  const maxSeconds = Math.min(270, Math.max(40 + 8 * images + 10 * docs, minSeconds + 20));
  return { minSeconds, maxSeconds };
}
export const analysisTimeoutMs = (fileCount: number): number => Math.min(270_000, Math.max(180_000, 120_000 + 12_000 * fileCount));

/** The notes the agent receives: what the team typed (cut if need be) and then the note about the files it was not shown. The agent accepts 10,000 characters in all. */
export function composeNotes(typed: string, extra: string, limit = 10_000): string {
  if (!extra) return typed.slice(0, limit);
  const room = Math.max(0, limit - extra.length - 2);
  const head = typed.slice(0, room).trim();
  return head ? `${head}\n\n${extra}` : extra;
}

/** A manifest sent by the browser: every file's name and size. Anything malformed is refused rather than guessed at. */
export function parseManifest(raw: unknown): FileInfo[] | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let value: unknown;
  try { value = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { throw new Error("The list of files could not be read."); }
  if (!Array.isArray(value)) throw new Error("The list of files could not be read.");
  if (value.length > MAX_LISTED) throw new Error(`That is more than ${MAX_LISTED.toLocaleString("en-US")} files. Put them in a ZIP file for the project instead.`);
  return value.map((v) => {
    const o = v as { name?: unknown; size?: unknown };
    if (typeof o?.name !== "string" || typeof o.size !== "number" || !Number.isFinite(o.size) || o.size < 0) throw new Error("The list of files could not be read.");
    return { name: o.name.replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "file", size: Math.floor(o.size) };
  });
}

/**
 * What to tell the AI about files it was NOT shown. Empty when it was shown everything. The total is stated first and as a fact, so that a set of page
 * designs is counted by its files and not by the few that were read.
 */
export function manifestNote(all: FileInfo[], sentNames: string[]): string {
  if (all.length <= sentNames.length) return "";
  const documents = all.filter((f) => isDocument(f.name)).length;
  const images = all.filter((f) => isImage(f.name)).length;
  const sent = new Set(sentNames);
  const ordered = all.map((f) => f.name).sort(naturalCompare);
  const shown = ordered.slice(0, MAX_NAMES_IN_NOTE);
  const more = ordered.length - shown.length;
  let note =
    `FILES THE CLIENT SUPPLIED: ${all.length} in total (${documents} written documents, ${images} images${all.length - documents - images > 0 ? `, ${all.length - documents - images} other` : ""}). ` +
    `You were shown only ${sentNames.length} of them: ${[...sent].join(", ")}. The rest are the same kind of material and were not shown to you. ` +
    `Count the supplied files, not just the ones you can see: if they are page designs, there are ${images} page designs. ` +
    `Names of all the files, in order: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`;
  if (note.length > NOTE_LIMIT) note = `${note.slice(0, NOTE_LIMIT - 3)}...`;
  return note;
}

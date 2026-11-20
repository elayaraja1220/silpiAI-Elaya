import type { Requirement } from "./types";

/**
 * Client assets: the originals we need from the client after they approve (logos, favicon, images, the real
 * content of every page). Pure and shared by the server and the screens. No file or database code here.
 */

export const ASSET_STATUSES = ["pending", "submitted", "received", "redo"] as const;
/** pending = nothing yet, submitted = client sent it, received = team checked it, redo = team asked for it again. */
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  pending: "Waiting for client",
  submitted: "Sent, to check",
  received: "Received",
  redo: "Please send again",
};

export const ASSET_GROUPS = ["Brand", "Business details", "Page content", "Images", "Other"] as const;
export type AssetGroup = (typeof ASSET_GROUPS)[number];

export type AssetKind = "files" | "text" | "both";

export type AssetTemplate = {
  key: string;
  group: AssetGroup;
  label: string;
  hint: string;
  kind: AssetKind;
  /** Kept for old records. Nothing is mandatory: the project uses what is uploaded and placeholders for the rest. */
  required: boolean;
};

export type AssetFile = { id: string; name: string; size: number; mime: string; uploadedAt: string; by: "client" | "team" };

export type ClientAsset = AssetTemplate & {
  id: string;
  status: AssetStatus;
  /** Content the client typed (page text, business details...). */
  text: string;
  /** The team's message to the client, for example why something must be sent again. */
  note: string;
  files: AssetFile[];
  updatedAt: string;
};

// ---- upload limits (checked again on the server; the screens only use them for friendly messages) ----
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_FILES_PER_ITEM = 30;
export const MAX_TEXT_CHARS = 20000;
/** Images, design files, documents and spreadsheets. Never scripts or executables. */
export const ALLOWED_EXTENSIONS = [
  "png", "jpg", "jpeg", "webp", "gif", "svg", "ico", "avif",
  "pdf", "ai", "eps", "psd", "fig",
  "doc", "docx", "txt", "rtf", "odt", "md",
  "xls", "xlsx", "csv", "ppt", "pptx",
  "woff", "woff2", "ttf", "otf",
  "zip",
] as const;
/** Shown to the client as the accepted file types. */
export const ACCEPT_ATTRIBUTE = ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(",");
/** Only these are ever shown inline as a picture. SVG is never inlined (it can carry scripts). */
export const INLINE_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "avif"] as const;

export const extensionOf = (name: string): string => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");
export const isAllowedFile = (name: string): boolean => (ALLOWED_EXTENSIONS as readonly string[]).includes(extensionOf(name));
export const isInlineImage = (name: string): boolean => (INLINE_IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(name));

/** A file name that is safe to store and show: no folders, no odd characters, never empty. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.normalize("NFKD").replace(/[^\w.\- ]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  return clean.replace(/^\.+/, "") || "file";
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";

/** Stages from which the originals are collected: after the client approves. */
export const ASSET_STAGES = ["approved", "advance_paid", "in_development", "testing", "demo_ready", "final_paid", "delivered"] as const;
export const assetsOpen = (stage: string): boolean => (ASSET_STAGES as readonly string[]).includes(stage);

/**
 * What to collect for this scope: always the brand files, business details and every billed page's content,
 * plus gallery, slider and product images only when the site has them.
 */
export function buildChecklist(req: Pick<Requirement, "pages" | "modules" | "projectType" | "pageDetails">): AssetTemplate[] {
  const items: AssetTemplate[] = [
    { key: "logo", group: "Brand", label: "Logo", kind: "files", required: false, hint: "The main logo. Best: PNG with a transparent background, SVG, or the original design file (AI, PSD, PDF)." },
    { key: "logo-mobile", group: "Brand", label: "Mobile logo", kind: "files", required: false, hint: "A smaller or square version of the logo for phones and the menu bar. If there is only one logo, say so in the note." },
    { key: "favicon", group: "Brand", label: "Favicon (browser tab icon)", kind: "files", required: false, hint: "A square icon, at least 512 x 512 px (PNG, SVG or ICO). We can make one from the logo if you do not have it." },
    { key: "brand-style", group: "Brand", label: "Brand colours and fonts", kind: "both", required: false, hint: "At least 9 colour codes (like #0B3D91) and your fonts: from Google Fonts, Adobe Fonts, or your own font (@font-face CSS or font files). You can also upload a brand guideline PDF." },
    { key: "business-details", group: "Business details", label: "Business and contact details", kind: "text", required: false, hint: "Business name, address, phone, email, WhatsApp number, working hours, Google Maps link and social media links." },
  ];

  for (const page of req.pages) {
    const purpose = req.pageDetails?.[page]?.purpose;
    items.push({
      key: `page:${slug(page)}`,
      group: "Page content",
      label: `${page} page: original content`,
      kind: "both",
      required: false,
      hint: `${purpose ? `${purpose}. ` : ""}The real text, headings and pictures for this page. Send a Word document, or type or paste it below.`,
    });
  }

  const has = (m: string) => (req.modules as string[]).includes(m);
  const pageLike = (re: RegExp) => req.pages.some((p) => re.test(p));
  if (has("gallery-preview") || pageLike(/gallery|photos?|portfolio/i)) {
    items.push({ key: "gallery-images", group: "Images", label: "Gallery images", kind: "files", required: false, hint: "Original, full-size photos (not screenshots or WhatsApp copies). A short caption in the note helps." });
  }
  if (has("image-slider")) {
    items.push({ key: "slider-images", group: "Images", label: "Banner / slider images", kind: "files", required: false, hint: "Wide, high-quality images for the home page slider, at least 1920 px wide." });
  }
  if (req.projectType === "ecommerce" || pageLike(/product|shop|store|catalog|menu/i)) {
    items.push({ key: "product-images", group: "Images", label: "Product images and details", kind: "both", required: false, hint: "One clear photo per product, plus name, price, description and category (an Excel or CSV sheet is ideal)." });
  }
  items.push({ key: "other-files", group: "Other", label: "Anything else", kind: "both", required: false, hint: "Videos links, certificates, testimonials, brochures or any other original material." });
  return items;
}

/** Progress: how many items have arrived and how many are checked. Nothing is mandatory; missing items get a placeholder. */
export function assetProgress(assets: Pick<ClientAsset, "status">[]) {
  const sent = assets.filter((a) => a.status === "submitted" || a.status === "received").length;
  return {
    total: assets.length,
    sent,
    received: assets.filter((a) => a.status === "received").length,
    toCheck: assets.filter((a) => a.status === "submitted").length,
    percent: assets.length ? Math.round((sent / assets.length) * 100) : 0,
  };
}

export const formatBytes = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

// ---- brand colours and fonts ------------------------------------------------------------------------------------------

/** The first nine colour fields and what each is for. More colours can be added after these. */
export const BRAND_COLOR_ROLES = ["Primary", "Secondary", "Accent", "Background", "Cards / surface", "Text", "Headings", "Buttons", "Links and borders"] as const;
export const MIN_BRAND_COLORS = BRAND_COLOR_ROLES.length;
export const MAX_BRAND_COLORS = 24;
export const MAX_BRAND_FONTS = 8;
export const MAX_FONT_CSS = 4000;

export const FONT_SOURCES = ["google", "adobe", "imported"] as const;
/** google = Google Fonts, adobe = Adobe Fonts (Typekit), imported = the client's own font, given as @font-face CSS or font files. */
export type FontSource = (typeof FONT_SOURCES)[number];
export const FONT_SOURCE_LABELS: Record<FontSource, string> = { google: "Google Fonts", adobe: "Adobe Fonts", imported: "Imported font (@font-face)" };
export const FONT_USAGES = ["heading", "body", "other"] as const;
export type FontUsage = (typeof FONT_USAGES)[number];
export const FONT_USAGE_LABELS: Record<FontUsage, string> = { heading: "Headings", body: "Body text", other: "Other" };

export type BrandFont = {
  name: string;
  source: FontSource;
  usage: FontUsage;
  /** Google Fonts link, or Adobe Fonts link / kit ID. Not used for imported fonts. */
  link: string;
  /** Imported fonts only: the @font-face CSS. */
  css: string;
};
export type BrandStyle = { colors: string[]; fonts: BrandFont[] };

export const blankFont = (): BrandFont => ({ name: "", source: "google", usage: "heading", link: "", css: "" });
/** What the form starts with: nine empty colour fields and one empty font. */
export const emptyBrandStyle = (): BrandStyle => ({ colors: Array.from({ length: MIN_BRAND_COLORS }, () => ""), fonts: [blankFont()] });

/** "#0b3d91", "0B3D91" or "#0bf" become "#0B3D91" / "#00BBFF". Empty stays empty. Anything else is null. */
export function normalizeHex(value: string): string | null {
  const v = value.trim().replace(/^#/, "");
  if (v === "") return "";
  if (/^[0-9a-f]{3}$/i.test(v)) return `#${v.split("").map((c) => c + c).join("").toUpperCase()}`;
  if (/^[0-9a-f]{6}$/i.test(v)) return `#${v.toUpperCase()}`;
  return null;
}

const GOOGLE_LINK = /^https:\/\/fonts\.(googleapis|google)\.com\//i;
const ADOBE_LINK = /^https:\/\/(use\.typekit\.net|fonts\.adobe\.com)\//i;
const ADOBE_KIT = /^[a-z0-9]{5,12}$/i;
const FONT_NAME = /^[\p{L}\p{N} .,&'+_-]{1,80}$/u;

/**
 * Strict check of what a person typed. Returns the cleaned style (blank fonts dropped, colours upper-case) or throws an Error
 * whose message is safe to show. Used by the form and, again, by the server.
 */
export function validateBrandStyle(input: unknown): BrandStyle {
  if (typeof input !== "object" || input === null) throw new Error("The colours and fonts are not valid.");
  const raw = input as { colors?: unknown; fonts?: unknown };
  const colorsIn = Array.isArray(raw.colors) ? raw.colors : [];
  const fontsIn = Array.isArray(raw.fonts) ? raw.fonts : [];
  if (colorsIn.length > MAX_BRAND_COLORS) throw new Error(`At most ${MAX_BRAND_COLORS} colours.`);
  if (fontsIn.length > MAX_BRAND_FONTS) throw new Error(`At most ${MAX_BRAND_FONTS} fonts.`);

  const colors = colorsIn.map((c, i) => {
    const hex = typeof c === "string" ? normalizeHex(c) : null;
    if (hex === null) throw new Error(`Colour ${i + 1} is not a valid colour code. Use a code like #0B3D91.`);
    return hex;
  });
  while (colors.length < MIN_BRAND_COLORS) colors.push("");
  while (colors.length > MIN_BRAND_COLORS && colors[colors.length - 1] === "") colors.pop();

  const fonts: BrandFont[] = [];
  fontsIn.forEach((f, i) => {
    const n = i + 1;
    if (typeof f !== "object" || f === null) throw new Error(`Font ${n} is not valid.`);
    const x = f as Partial<Record<keyof BrandFont, unknown>>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const name = str(x.name);
    const link = str(x.link);
    const css = typeof x.css === "string" ? x.css.trim() : "";
    const source = (FONT_SOURCES as readonly string[]).includes(x.source as string) ? (x.source as FontSource) : "google";
    const usage = (FONT_USAGES as readonly string[]).includes(x.usage as string) ? (x.usage as FontUsage) : "other";
    if (!name && !link && !css) return; // an empty font row is just ignored
    if (!name) throw new Error(`Font ${n}: type the font name.`);
    if (!FONT_NAME.test(name)) throw new Error(`Font ${n}: the name can only have letters, numbers, spaces and . , & ' + _ -`);
    if (source === "google" && link && !GOOGLE_LINK.test(link)) throw new Error(`Font ${n}: a Google Fonts link starts with https://fonts.googleapis.com/ or https://fonts.google.com/. You can also leave it empty.`);
    if (source === "adobe" && link && !ADOBE_LINK.test(link) && !ADOBE_KIT.test(link)) throw new Error(`Font ${n}: use the Adobe Fonts link (https://use.typekit.net/...) or just the kit ID.`);
    if (link.length > 500) throw new Error(`Font ${n}: the link is too long.`);
    if (source === "imported") {
      if (css.length > MAX_FONT_CSS) throw new Error(`Font ${n}: the CSS is longer than ${MAX_FONT_CSS} characters. Upload the font files instead.`);
      if (css && !/@font-face/i.test(css)) throw new Error(`Font ${n}: imported font CSS must contain an @font-face rule.`);
      if (css.includes("<")) throw new Error(`Font ${n}: paste only the CSS, without HTML tags.`);
    }
    fonts.push({ name, source, usage, link: source === "imported" ? "" : link, css: source === "imported" ? css : "" });
  });
  return { colors, fonts };
}

/** Stored text for the checklist item. Empty when nothing was filled in, so the item still counts as "not provided". */
export function serializeBrandStyle(style: BrandStyle): string {
  const cleaned = validateBrandStyle(style);
  if (cleaned.colors.every((c) => c === "") && cleaned.fonts.length === 0) return "";
  return JSON.stringify(cleaned);
}

/** Reads stored text back into the form. Old free text (before this form existed) is kept as a note, never lost. */
export function parseBrandStyle(text: string): BrandStyle {
  try {
    const parsed = JSON.parse(text) as unknown;
    const style = validateBrandStyle(parsed);
    return { colors: style.colors, fonts: style.fonts.length ? style.fonts : [blankFont()] };
  } catch {
    return emptyBrandStyle();
  }
}

/** Is this stored text a brand style produced by the form? */
export function isBrandStyleText(text: string): boolean {
  try { validateBrandStyle(JSON.parse(text)); return text.trim().startsWith("{"); } catch { return false; }
}

/** Readable lines for the generator and for people: the colour palette and how to load each font. */
export function brandStyleLines(style: BrandStyle): string[] {
  const lines: string[] = [];
  const colors = style.colors.map((c, i) => ({ c, role: i < BRAND_COLOR_ROLES.length ? BRAND_COLOR_ROLES[i] : `Extra colour ${i - BRAND_COLOR_ROLES.length + 1}` })).filter((x) => x.c);
  if (colors.length) {
    lines.push("Colour palette (define each once as a CSS variable and use it across the site):");
    for (const { c, role } of colors) lines.push(`- ${role}: ${c}`);
  }
  if (style.fonts.length) {
    if (lines.length) lines.push("");
    lines.push("Fonts:");
    for (const f of style.fonts) {
      const how =
        f.source === "google" ? `Google Fonts${f.link ? `, link: ${f.link}` : " (load it from Google Fonts by name)"}`
        : f.source === "adobe" ? `Adobe Fonts${f.link ? `, ${/^https:/i.test(f.link) ? "link" : "kit ID"}: ${f.link}` : " (the kit link was not given)"}`
        : f.css ? "imported font, @font-face CSS saved in `.silpi/brand-fonts.css`" : "imported font, use the uploaded font files with @font-face";
      lines.push(`- ${f.name} (${FONT_USAGE_LABELS[f.usage].toLowerCase()}): ${how}`);
    }
  }
  return lines;
}

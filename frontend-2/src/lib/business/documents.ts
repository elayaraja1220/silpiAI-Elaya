import { publicServiceLine, type PublicRunningServices } from "./running-services";
import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import { formatINR } from "./pricing";
import { seoAdvice } from "./seo";
import { CHOICE_LABELS } from "./services";
import type { Quotation, Requirement } from "./types";

/**
 * Server-only. Turns a saved quotation into a downloadable PDF or Word file.
 * Both are built from the same outline, so they always say the same thing.
 */

type Row = { cells: string[]; detail?: string; bold?: boolean };
type Block =
  | { kind: "heading"; text: string }
  | { kind: "text"; text: string; muted?: boolean; bold?: boolean }
  | { kind: "bullets"; items: string[] }
  | { kind: "table"; head: string[]; widths: number[]; align: ("left" | "right")[]; rows: Row[] }
  | { kind: "pairs"; rows: { label: string; value: string; bold?: boolean }[] };

const date = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

/** Common outline of the quotation document. */
function outline(q: Quotation, fallback: Requirement, running?: PublicRunningServices | null): { title: string; meta: string[]; from: string[]; to: string[]; blocks: Block[] } {
  const req = q.requirement ?? fallback;
  const money = formatINR;
  const blocks: Block[] = [];

  blocks.push({ kind: "heading", text: req.title });
  blocks.push({ kind: "text", text: req.summary });
  blocks.push({
    kind: "text",
    muted: true,
    text: [
      q.tier ? `Proposal: ${q.tier[0].toUpperCase()}${q.tier.slice(1)}` : "",
      `Estimated delivery: about ${q.estimatedWeeks} week${q.estimatedWeeks === 1 ? "" : "s"} after the advance`,
      q.totalHours ? `${q.totalHours} development hours` : "",
    ].filter(Boolean).join("  |  "),
  });

  if (q.proposals?.length) {
    blocks.push({ kind: "heading", text: "Proposals to choose from" });
    blocks.push({
      kind: "table",
      head: ["Proposal", "What you get", "Weeks", "Total (incl. GST)"],
      widths: [0.16, 0.56, 0.1, 0.18],
      align: ["left", "left", "right", "right"],
      rows: q.proposals.map((p) => ({
        cells: [`${p.title}${p.tier === q.tier ? " (this quotation)" : ""}`, p.tagline, String(p.estimatedWeeks), money(p.grandTotal)],
        detail: [`Pages: ${p.pages.join(", ")}`, p.features.length ? `Includes: ${p.features.join(", ")}` : "", p.leftOut.length ? `Not included: ${p.leftOut.join("; ")}` : ""].filter(Boolean).join("\n"),
        bold: p.tier === q.tier,
      })),
    });
  }

  if (q.comparison?.length && q.proposals?.length) {
    const tiers = q.proposals.map((p) => p.tier);
    const mark = (v: string | boolean) => (v === true ? "Yes" : v === false ? "-" : v);
    blocks.push({ kind: "heading", text: "What each package includes" });
    blocks.push({
      kind: "table",
      head: ["Feature", ...q.proposals.map((p) => p.title)],
      widths: [0.4, ...tiers.map(() => 0.6 / tiers.length)],
      align: ["left", ...tiers.map(() => "left" as const)],
      rows: q.comparison.map((row) => ({ cells: [row.label, ...tiers.map((t) => mark(row.values[t]))] })),
    });
  }

  blocks.push({ kind: "heading", text: "A. Website development estimation" });
  blocks.push({
    kind: "table",
    head: ["#", "Description", "Qty", "Rate", "Amount"],
    widths: [0.05, 0.53, 0.12, 0.14, 0.16],
    align: ["left", "left", "right", "right", "right"],
    rows: q.items.map((item, i) => ({
      cells: [String(i + 1), item.description, `${item.qty} ${item.unit}${item.qty === 1 ? "" : "s"}`, money(item.rate), money(item.amount)],
      detail: item.detail,
    })),
  });

  const totals: { label: string; value: string; bold?: boolean }[] = [{ label: "Subtotal", value: money(q.subtotal) }];
  if (q.discount > 0) totals.push({ label: "Discount", value: money(-q.discount) }, { label: "Taxable value", value: money(q.taxable) });
  if (q.gst.mode === "intra") totals.push({ label: `CGST @ ${q.gst.rate / 2}%`, value: money(q.gst.cgst) }, { label: `SGST @ ${q.gst.rate / 2}%`, value: money(q.gst.sgst) });
  if (q.gst.mode === "inter") totals.push({ label: `IGST @ ${q.gst.rate}%`, value: money(q.gst.igst) });
  if (q.gst.mode === "export") totals.push({ label: "GST: export of services (zero-rated, under LUT)", value: money(0) });
  if (q.roundOff !== 0) totals.push({ label: "Round off", value: money(q.roundOff) });
  totals.push({ label: "Development grand total", value: money(q.grandTotal), bold: true });
  blocks.push({ kind: "pairs", rows: totals });
  blocks.push({ kind: "text", muted: true, text: "Domain and hosting charges are not included in website development pricing. These services are billed separately." });

  // B and C: separately billed services, never part of the development total.
  const services = q.services;
  if (services) {
    const section = (letter: string, title: string, choice: string, est: typeof services.domain.estimate) => {
      blocks.push({ kind: "heading", text: `${letter}. ${title} (separate, optional)` });
      blocks.push({ kind: "text", text: choice });
      if (!est) return;
      blocks.push({ kind: "bullets", items: est.details.map((d) => `${d.label}: ${d.value}`) });
      blocks.push({
        kind: "pairs",
        rows: [
          ...est.items.map((i) => ({ label: i.description, value: money(i.amount) })),
          ...(est.gst > 0 ? [{ label: "GST", value: money(est.gst) }] : []),
          { label: `${title} total (separate bill)`, value: money(est.total), bold: true },
          { label: "Renewal per year (+ GST)", value: money(est.renewal) },
        ],
      });
    };
    section("B", "Domain expenses", CHOICE_LABELS.domain[services.domain.choice], services.domain.estimate);
    section("C", "Hosting expenses", CHOICE_LABELS.hosting[services.hosting.choice], services.hosting.estimate);
    if (services.others?.length) {
      blocks.push({ kind: "heading", text: "D. Other external services (separate, billed by the provider)" });
      blocks.push({ kind: "bullets", items: services.others.map((o) => `${o}: to be confirmed`) });
    }
  }

  // Running services the admin approved for the client: billed separately, never part of the development total.
  if (running && running.services.length) {
    blocks.push({ kind: "heading", text: "Running services (billed separately from development)" });
    blocks.push({ kind: "bullets", items: running.services.map((s) => publicServiceLine(s, money)) });
    blocks.push({ kind: "text", muted: true, text: running.note });
  }

  blocks.push({ kind: "heading", text: "Technology" });
  blocks.push({
    kind: "bullets",
    items: [
      ...(q.stack.approach ? [`Approach: ${q.stack.approach}`] : []),
      `Frontend: ${q.stack.frontend}`,
      `Backend: ${q.stack.backend}`,
      `Database: ${q.stack.database}`,
      `Styling: ${q.stack.styling}`,
      ...q.stack.notes,
    ],
  });

  const seo = q.seo ?? seoAdvice(req);
  blocks.push({ kind: "heading", text: "SEO" });
  blocks.push({ kind: "text", bold: true, text: "Included in every website" });
  blocks.push({ kind: "bullets", items: seo.included });
  if (seo.recommended.length) {
    blocks.push({ kind: "text", bold: true, text: "Recommended for this project" });
    blocks.push({ kind: "bullets", items: seo.recommended });
  }
  if (seo.keywords.length) blocks.push({ kind: "text", text: `Target search phrases: ${seo.keywords.join(", ")}` });

  if (q.deferred) {
    blocks.push({ kind: "heading", text: "Phase 2 (not in this quotation)" });
    blocks.push({ kind: "text", text: `${q.deferred.modules.join(", ")}: about ${money(q.deferred.amount)} + GST, quoted separately when you are ready.` });
  }

  blocks.push({ kind: "heading", text: "Development payment schedule" });
  blocks.push({ kind: "pairs", rows: q.schedule.map((s) => ({ label: `${s.percent}%  ${s.label}`, value: money(s.amount) })) });
  blocks.push({
    kind: "bullets",
    items: [
      ...(q.business.upiId ? [`Pay by UPI to ${q.business.upiId} with the note ${q.number}.`] : []),
      ...(q.business.bankDetails ? [`Bank transfer: ${q.business.bankDetails.replace(/\n+/g, ", ")}`] : []),
      "Work starts once the advance is received. Every page is tested automatically and shown in a demo before the balance is due.",
      "Source code, build files and hosting set-up are handed over after full payment.",
      "Domain and hosting are billed separately from development, at the provider's rates, and renew yearly.",
      `This quotation is valid until ${date(q.validUntil)}.`,
    ],
  });

  const b = q.business;
  const c = q.client;
  return {
    title: q.number,
    meta: [`Date: ${date(q.createdAt)}`, `Valid until: ${date(q.validUntil)}`],
    from: [b.name, b.address, [b.email, b.phone].filter(Boolean).join("  |  "), b.gstin ? `GSTIN: ${b.gstin}` : ""].filter(Boolean),
    to: [c.company || c.name, c.company ? c.name : "", c.address, `${c.email}  |  ${c.phone}`, `Place of supply: ${c.state}`, c.gstin ? `GSTIN: ${c.gstin}` : ""].filter(Boolean),
    blocks,
  };
}

// ---- PDF -----------------------------------------------------------------

const A4 = { w: 595.28, h: 841.89 };
const M = 48;
const INK = rgb(0.12, 0.14, 0.2);
const MUTED = rgb(0.42, 0.45, 0.52);
const ACCENT = rgb(0.43, 0.33, 0.9);
const LINE = rgb(0.86, 0.88, 0.92);

/** The document's content as plain blocks (what both the PDF and the Word file are drawn from). */
export function quotationOutline(q: Quotation, fallback: Requirement, running?: PublicRunningServices | null) {
  return outline(q, fallback, running);
}

export async function quotationPdf(q: Quotation, fallback: Requirement, running?: PublicRunningServices | null): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Quotation ${q.number}`);
  doc.setAuthor(q.business.name);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const o = outline(q, fallback, running);

  // The built-in PDF fonts cannot draw ₹ or non-Latin scripts: replace them.
  const okChar = new Map<string, boolean>();
  const clean = (s: string) =>
    s
      .replace(/₹/g, "Rs. ")
      .replace(/→/g, "->")
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .split("")
      .map((ch) => {
        if (ch === "\n") return ch;
        if (!okChar.has(ch)) {
          try {
            font.encodeText(ch);
            okChar.set(ch, true);
          } catch {
            okChar.set(ch, false);
          }
        }
        return okChar.get(ch) ? ch : "?";
      })
      .join("");

  let page: PDFPage = doc.addPage([A4.w, A4.h]);
  let y = A4.h - M;
  const width = A4.w - 2 * M;
  const ensure = (h: number) => {
    if (y - h < M) {
      page = doc.addPage([A4.w, A4.h]);
      y = A4.h - M;
    }
  };
  const wrap = (text: string, f: PDFFont, size: number, max: number): string[] => {
    const lines: string[] = [];
    for (const para of clean(text).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(next, size) > max && line) {
          lines.push(line);
          line = word;
        } else line = next;
      }
      lines.push(line);
    }
    return lines;
  };
  const draw = (text: string, x: number, size: number, f = font, color = INK, maxW = width, align: "left" | "right" = "left") => {
    const lines = wrap(text, f, size, maxW);
    for (const line of lines) {
      ensure(size + 4);
      const w = f.widthOfTextAtSize(line, size);
      page.drawText(line, { x: align === "right" ? x + maxW - w : x, y: y - size, size, font: f, color });
      y -= size + 4;
    }
  };

  // Header
  const top = y;
  draw(o.from[0] ?? "", M, 16, bold);
  for (const line of o.from.slice(1)) draw(line, M, 8.5, font, MUTED, width * 0.55);
  const leftEnd = y;
  y = top;
  draw("QUOTATION", M, 9, bold, ACCENT, width, "right");
  draw(o.title, M, 15, bold, INK, width, "right");
  for (const m of o.meta) draw(m, M, 8.5, font, MUTED, width, "right");
  y = Math.min(y, leftEnd) - 10;
  page.drawLine({ start: { x: M, y }, end: { x: A4.w - M, y }, thickness: 0.7, color: LINE });
  y -= 14;
  draw("BILL TO", M, 8, bold, MUTED);
  for (const [i, line] of o.to.entries()) draw(line, M, i === 0 ? 11 : 9, i === 0 ? bold : font, i === 0 ? INK : MUTED);
  y -= 6;

  for (const block of o.blocks) {
    if (block.kind === "heading") {
      ensure(40);
      y -= 10;
      draw(block.text, M, 12, bold, INK);
      y -= 2;
    } else if (block.kind === "text") {
      draw(block.text, M, 9.5, block.bold ? bold : font, block.muted ? MUTED : INK);
      y -= 2;
    } else if (block.kind === "bullets") {
      for (const item of block.items) {
        const lines = wrap(item, font, 9, width - 12);
        ensure(lines.length * 13);
        page.drawText("-", { x: M + 2, y: y - 9, size: 9, font, color: MUTED });
        for (const line of lines) {
          page.drawText(line, { x: M + 12, y: y - 9, size: 9, font, color: INK });
          y -= 13;
        }
      }
      y -= 2;
    } else if (block.kind === "table") {
      const xs = block.widths.reduce<number[]>((acc, w, i) => [...acc, i === 0 ? M : acc[i - 1] + block.widths[i - 1] * width], []);
      const cell = (text: string, i: number, f: PDFFont, size: number, color = INK) => {
        const w = block.widths[i] * width - 6;
        const lines = wrap(text, f, size, w);
        lines.forEach((line, n) => {
          const lw = f.widthOfTextAtSize(line, size);
          page.drawText(line, { x: block.align[i] === "right" ? xs[i] + w - lw : xs[i], y: y - size - n * (size + 3), size, font: f, color });
        });
        return lines.length * (size + 3);
      };
      // Keep the header with at least the first rows.
      ensure(70);
      page.drawRectangle({ x: M, y: y - 16, width, height: 16, color: rgb(0.95, 0.96, 0.98) });
      y -= 3;
      block.head.forEach((h, i) => cell(h.toUpperCase(), i, bold, 7.5, MUTED));
      y -= 17;
      for (const row of block.rows) {
        const heights = row.cells.map((c, i) => wrap(c, row.bold ? bold : font, 9, block.widths[i] * width - 6).length * 12);
        const detailLines = row.detail ? wrap(row.detail, font, 7.5, block.widths[1] * width - 6) : [];
        ensure(Math.max(...heights) + detailLines.length * 10 + 10);
        const used = Math.max(...row.cells.map((c, i) => cell(c, i, row.bold ? bold : font, 9)));
        y -= used;
        for (const line of detailLines) {
          page.drawText(line, { x: xs[1], y: y - 7.5, size: 7.5, font, color: MUTED });
          y -= 10;
        }
        y -= 5;
        page.drawLine({ start: { x: M, y }, end: { x: A4.w - M, y }, thickness: 0.4, color: LINE });
        y -= 5;
      }
    } else if (block.kind === "pairs") {
      for (const row of block.rows) {
        ensure(16);
        const f = row.bold ? bold : font;
        const size = row.bold ? 11 : 9.5;
        const label = clean(row.label);
        const value = clean(row.value);
        page.drawText(label, { x: A4.w - M - 300, y: y - size, size, font: f, color: INK });
        page.drawText(value, { x: A4.w - M - f.widthOfTextAtSize(value, size), y: y - size, size, font: f, color: INK });
        y -= size + 6;
      }
      y -= 4;
    }
  }

  const pages = doc.getPages();
  pages.forEach((p, i) =>
    p.drawText(clean(`${q.number}  |  Page ${i + 1} of ${pages.length}`), { x: M, y: 24, size: 7.5, font, color: MUTED }),
  );
  return doc.save();
}

// ---- Word ----------------------------------------------------------------

export async function quotationDocx(q: Quotation, fallback: Requirement, running?: PublicRunningServices | null): Promise<Buffer> {
  const o = outline(q, fallback, running);
  const run = (text: string, opts: { bold?: boolean; size?: number; color?: string } = {}) =>
    new TextRun({ text, bold: opts.bold, size: opts.size ?? 19, color: opts.color, font: "Calibri" });
  const para = (text: string, opts: { bold?: boolean; size?: number; color?: string; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; after?: number } = {}) =>
    new Paragraph({ alignment: opts.align, spacing: { after: opts.after ?? 60 }, children: text.split("\n").flatMap((t, i) => [...(i ? [new TextRun({ break: 1 })] : []), run(t, opts)]) });
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const noBorders = { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
  const thin = { style: BorderStyle.SINGLE, size: 4, color: "DDE1E8" };

  const children: (Paragraph | Table)[] = [
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: noBorders,
      rows: [
        new TableRow({
          children: [
            new TableCell({ width: { size: 60, type: WidthType.PERCENTAGE }, children: o.from.map((l, i) => para(l, i === 0 ? { bold: true, size: 30 } : { color: "6B7280", size: 17, after: 20 })) }),
            new TableCell({
              width: { size: 40, type: WidthType.PERCENTAGE },
              children: [
                para("QUOTATION", { bold: true, color: "6D54E6", size: 17, align: AlignmentType.RIGHT }),
                para(o.title, { bold: true, size: 28, align: AlignmentType.RIGHT }),
                ...o.meta.map((m) => para(m, { color: "6B7280", size: 17, align: AlignmentType.RIGHT, after: 20 })),
              ],
            }),
          ],
        }),
      ],
    }),
    para("", { after: 120 }),
    para("BILL TO", { bold: true, color: "6B7280", size: 16 }),
    ...o.to.map((l, i) => para(l, i === 0 ? { bold: true, size: 22, after: 20 } : { color: "4B5563", size: 18, after: 20 })),
  ];

  for (const block of o.blocks) {
    if (block.kind === "heading") {
      children.push(new Paragraph({ spacing: { before: 240, after: 80 }, children: [run(block.text, { bold: true, size: 25 })] }));
    } else if (block.kind === "text") {
      children.push(para(block.text, { bold: block.bold, color: block.muted ? "6B7280" : undefined }));
    } else if (block.kind === "bullets") {
      for (const item of block.items) children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: [run(item, { size: 18 })] }));
    } else if (block.kind === "table") {
      const align = (i: number) => (block.align[i] === "right" ? AlignmentType.RIGHT : AlignmentType.LEFT);
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: { top: thin, bottom: thin, left: none, right: none, insideHorizontal: thin, insideVertical: none },
          rows: [
            new TableRow({
              tableHeader: true,
              children: block.head.map(
                (h, i) =>
                  new TableCell({
                    width: { size: block.widths[i] * 100, type: WidthType.PERCENTAGE },
                    shading: { type: ShadingType.CLEAR, color: "auto", fill: "F2F4F7" },
                    children: [para(h.toUpperCase(), { bold: true, color: "6B7280", size: 15, align: align(i) })],
                  }),
              ),
            }),
            ...block.rows.map(
              (row) =>
                new TableRow({
                  children: row.cells.map(
                    (c, i) =>
                      new TableCell({
                        width: { size: block.widths[i] * 100, type: WidthType.PERCENTAGE },
                        children: [
                          para(c, { bold: row.bold, size: 18, align: align(i), after: 20 }),
                          ...(i === 1 && row.detail ? [para(row.detail, { color: "6B7280", size: 15 })] : []),
                        ],
                      }),
                  ),
                }),
            ),
          ],
        }),
      );
    } else if (block.kind === "pairs") {
      children.push(
        new Table({
          width: { size: 60, type: WidthType.PERCENTAGE },
          alignment: AlignmentType.RIGHT,
          borders: noBorders,
          rows: block.rows.map(
            (r) =>
              new TableRow({
                children: [
                  new TableCell({ children: [para(r.label, { bold: r.bold, size: r.bold ? 22 : 18 })] }),
                  new TableCell({ children: [para(r.value, { bold: r.bold, size: r.bold ? 22 : 18, align: AlignmentType.RIGHT })] }),
                ],
              }),
          ),
        }),
      );
    }
  }

  const doc = new Document({
    creator: q.business.name,
    title: `Quotation ${q.number}`,
    sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 900, right: 900 } } }, children }],
  });
  return Packer.toBuffer(doc);
}

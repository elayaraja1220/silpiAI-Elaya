// The layout shared by the team's "Client files & design" tab and the client's own upload section: the content menu entries
// (brand items grouped into one, a page's design beside its content), one status per entry, and the status colours.
import { Building2, FileText, Images, LayoutTemplate, Palette, Paperclip, type LucideIcon } from "lucide-react";

import { designKeyOfContent, isPageDesignKey, PAGE_CONTENT_PREFIX, type AssetGroup, type AssetStatus, type ClientAsset } from "@/lib/business/assets";

export const GROUP_ICON: Record<AssetGroup, LucideIcon> = { Brand: Palette, Design: LayoutTemplate, "Business details": Building2, "Page design": LayoutTemplate, "Page content": FileText, Images: Images, Other: Paperclip };
/** The menu heading: each page holds its design and its content side by side, so the pages sit under one heading. */
export const GROUP_LABEL: Partial<Record<AssetGroup, string>> = { "Page content": "Pages: design and content" };
export const PILL: Record<AssetStatus, string> = {
  pending: "border-white/10 bg-white/[.05] text-slate-400",
  submitted: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  received: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  redo: "border-amber-400/30 bg-amber-400/10 text-amber-300",
};
export const DOT: Record<AssetStatus, string> = { pending: "bg-slate-600", submitted: "bg-sky-400", received: "bg-emerald-400", redo: "bg-amber-400" };

export const hasContent = (a: ClientAsset) => a.files.length > 0 || a.text.trim().length > 0;

/**
 * A menu entry. Most entries are one checklist item. The brand items (logo, mobile logo, favicon, colours and fonts)
 * are one entry, "Brand identity", so they are handled in a single place.
 */
export type Entry = { key: string; group: AssetGroup; label: string; assets: ClientAsset[]; /** A page: its content and, beside it, its design. */ page?: { content: ClientAsset; design?: ClientAsset } };

export function entriesOf(list: ClientAsset[]): Entry[] {
  const out: Entry[] = [];
  const brand = list.filter((a) => a.group === "Brand");
  const byKey = new Map(list.map((a) => [a.key, a]));
  const hasContentItem = (designKey: string) => byKey.has(`${PAGE_CONTENT_PREFIX}${designKey.slice("design:".length)}`);
  for (const a of list) {
    if (a.group === "Brand") {
      if (!out.some((e) => e.key === "brand")) out.push({ key: "brand", group: "Brand", label: "Brand identity", assets: brand });
    } else if (a.key.startsWith(PAGE_CONTENT_PREFIX)) {
      // A page: its content with its design beside it (the design item is shown here, not as an entry of its own).
      const design = byKey.get(designKeyOfContent(a.key));
      out.push({ key: a.key, group: a.group, label: a.label.replace(/ page: original content$/, ""), assets: design ? [a, design] : [a], page: { content: a, ...(design ? { design } : {}) } });
    } else if (isPageDesignKey(a.key) && hasContentItem(a.key)) {
      continue;
    } else {
      out.push({ key: a.key, group: a.group, label: a.label.replace(/ page: (original content|design)$/, ""), assets: [a] });
    }
  }
  return out;
}

/** One status for several items: needs attention first, then waiting for a check, then done. */
export function entryStatus(assets: ClientAsset[]): AssetStatus {
  if (assets.some((a) => a.status === "redo")) return "redo";
  const filled = assets.filter(hasContent);
  if (filled.length === 0) return "pending";
  if (filled.some((a) => a.status === "submitted" || a.status === "pending")) return "submitted";
  return "received";
}

import { NextResponse } from "next/server";

import { quotationDocx, quotationPdf } from "./documents";
import { getRateCard } from "./store";
import type { Lead } from "./types";

/** Server-only. Sends the lead's latest quotation as a PDF or Word file. */
export async function quotationDownload(lead: Lead, format: string | null): Promise<NextResponse> {
  const saved = lead.quotation;
  if (!saved) return NextResponse.json({ success: false, error: "No quotation yet." }, { status: 404 });
  // Payment details can be added after the quotation was issued: use the current ones.
  const current = getRateCard().business;
  const q = { ...saved, business: { ...saved.business, upiId: current.upiId, bankDetails: current.bankDetails } };
  const safeName = `${q.number}-${(q.client.company || q.client.name).replace(/[^\w-]+/g, "-").slice(0, 40)}`;
  if (format === "docx") {
    const body = await quotationDocx(q, lead.requirement);
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${safeName}.docx"`,
        "Cache-Control": "no-store",
      },
    });
  }
  if (format === "pdf") {
    const body = await quotationPdf(q, lead.requirement);
    return new NextResponse(new Uint8Array(body), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${safeName}.pdf"`, "Cache-Control": "no-store" },
    });
  }
  return NextResponse.json({ success: false, error: "format must be pdf or docx." }, { status: 400 });
}

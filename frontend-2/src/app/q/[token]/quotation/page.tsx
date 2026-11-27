import type { Metadata } from "next";

import { ClientShell } from "@/components/client/client-shell";
import { clientFrame } from "@/server/client-page";

import { ClientQuotationDocument } from "./client-quotation-document";

export const metadata: Metadata = {
  title: "Your quotation",
  // Private link: keep it out of search engines.
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** The full quotation on its own page (the page before it stays short). Opens with the client's secret link, like that page, in the same frame. */
export default async function QuotationDocumentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const frame = await clientFrame();
  return (
    <ClientShell frame={frame} crumbs={[{ label: "My Projects", href: "/my-projects" }, { label: "Project Details", href: `/q/${encodeURIComponent(token)}` }, { label: "Quotation" }]}>
      <ClientQuotationDocument token={token} />
    </ClientShell>
  );
}

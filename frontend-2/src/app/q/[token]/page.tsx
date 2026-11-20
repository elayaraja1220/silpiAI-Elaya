import type { Metadata } from "next";

import { ClientQuotation } from "./client-quotation";

export const metadata: Metadata = {
  title: "Your quotation",
  // Private link: keep it out of search engines.
  robots: { index: false, follow: false },
};

export default async function QuotationLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ClientQuotation token={token} />;
}

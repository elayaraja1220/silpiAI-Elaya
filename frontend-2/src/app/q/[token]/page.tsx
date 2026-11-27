import type { Metadata } from "next";

import { ClientShell } from "@/components/client/client-shell";
import { clientFrame } from "@/server/client-page";

import { ClientQuotation } from "./client-quotation";

export const metadata: Metadata = {
  title: "Your quotation",
  // Private link: keep it out of search engines.
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** The client's quotation, in the same frame as the rest of their pages. The link itself is the key, so it also opens for someone who is not signed in. */
export default async function QuotationLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const frame = await clientFrame();
  return (
    <ClientShell frame={frame} crumbs={[{ label: "My Projects", href: "/my-projects" }, { label: "Project Details" }]}>
      <ClientQuotation token={token} signedInName={frame?.user.name ?? ""} />
    </ClientShell>
  );
}

import type { Metadata } from "next";

import { LegalPage } from "@/components/client/legal-page";

export const metadata: Metadata = { title: "Terms of Service · SILPI AI" };

export default function Page() {
  return <LegalPage title="Terms of Service" />;
}

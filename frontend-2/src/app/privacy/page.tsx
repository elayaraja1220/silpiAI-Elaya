import type { Metadata } from "next";

import { LegalPage } from "@/components/client/legal-page";

export const metadata: Metadata = { title: "Privacy Policy · SILPI AI" };

export default function Page() {
  return <LegalPage title="Privacy Policy" />;
}

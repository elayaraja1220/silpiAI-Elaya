import type { Metadata } from "next";

import { ResetPassword } from "@/components/client/client-auth";

export const metadata: Metadata = { title: "Choose a new password · SILPI AI", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function Page() {
  return <ResetPassword />;
}

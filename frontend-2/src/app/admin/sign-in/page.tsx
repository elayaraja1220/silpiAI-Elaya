import type { Metadata } from "next";

import { AdminSignInScreen } from "@/components/ai/admin-sign-in-screen";

export const metadata: Metadata = { title: "Administrator sign-in", robots: { index: false, follow: false } };

/** The only door to the studio. Not linked from any public page; the studio sends visitors here when they are not signed in as an administrator. */
export default function Page() {
  return <AdminSignInScreen />;
}

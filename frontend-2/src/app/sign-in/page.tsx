import type { Metadata } from "next";

import { ClientAuth } from "@/components/client/client-auth";

export const metadata: Metadata = { title: "Sign in · SILPI AI" };

export default function Page() {
  return <ClientAuth />;
}

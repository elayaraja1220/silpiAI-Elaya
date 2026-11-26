import type { Metadata } from "next";

import { ModelChooser } from "@/components/client/model-chooser";
import { requireClient } from "@/server/client-page";

export const metadata: Metadata = { title: "What would you like to build? · SILPI AI", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Where every client lands after signing in: choose Fixed Price or SaaS. Not signed in: the sign-in page, then back here. */
export default async function Page() {
  const session = await requireClient("/clients/new");
  return <ModelChooser name={session.user.name} />;
}

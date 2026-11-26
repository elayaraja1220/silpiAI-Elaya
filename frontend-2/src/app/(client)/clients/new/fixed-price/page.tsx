import type { Metadata } from "next";

import { ClientFixedPrice } from "@/components/client/client-fixed-price";
import { requireClient } from "@/server/client-page";
import { recordModelChoice } from "@/server/model-choice";

export const metadata: Metadata = { title: "Fixed price project · SILPI AI", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Fixed Price: records the choice and opens the requirement form, which is the studio's quotation engine run for this client's own workspace. */
export default async function Page() {
  const session = await requireClient("/clients/new/fixed-price");
  recordModelChoice(session, "fixed_price");
  return <ClientFixedPrice name={session.user.name} email={session.user.email} />;
}

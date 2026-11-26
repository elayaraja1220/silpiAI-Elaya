import { redirect } from "next/navigation";

import { requireClient } from "@/server/client-page";
import { recordModelChoice } from "@/server/model-choice";
import { saasDestination } from "@/server/saas-entry";

export const dynamic = "force-dynamic";

/**
 * Start with SILPI AI: records the choice and sends the client straight to the AI workspace. An organization with no plan yet is sent to the plans first,
 * and after choosing one (a free plan is active at once) is brought on to the workspace.
 */
export default async function Page() {
  const session = await requireClient("/clients/new/saas");
  recordModelChoice(session, "saas");
  redirect(saasDestination(session.orgId));
}

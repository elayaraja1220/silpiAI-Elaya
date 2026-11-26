// Guards for the client's own pages (server only). A client page is only ever shown to a signed-in client; anyone else is sent to the sign-in page and brought back afterwards.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { resolveSession, SESSION_COOKIE, type ResolvedSession } from "@/server/sessions";

export type ClientSession = ResolvedSession & { orgId: string };

/** The signed-in client with an active workspace, or a redirect to /sign-in that returns to `next`. */
export async function requireClient(next: string): Promise<ClientSession> {
  const session = resolveSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session || !session.orgId || !session.role) redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  return session as ClientSession;
}

/** The signed-in person if there is one (for a header), without redirecting. */
export async function currentClient(): Promise<ResolvedSession | null> {
  return resolveSession((await cookies()).get(SESSION_COOKIE)?.value);
}

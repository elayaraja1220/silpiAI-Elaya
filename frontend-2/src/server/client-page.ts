// Guards for the client's own pages (server only). A client page is only ever shown to a signed-in client; anyone else is sent to the sign-in page and brought back afterwards.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { listClientProjects } from "@/server/client-projects";
import { resolveSession, SESSION_COOKIE, type ResolvedSession } from "@/server/sessions";

export type ClientSession = ResolvedSession & { orgId: string };

/** The signed-in client with an active workspace, or a redirect to /sign-in that returns to `next`. */
export async function requireClient(next: string): Promise<ClientSession> {
  const session = resolveSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session || !session.orgId || !session.role) redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  return session as ClientSession;
}

/** What the client's frame shows: who is signed in, and their projects for the sidebar (in the same order as My Projects; title and stage only). Null when nobody is signed in. */
export async function clientFrame(): Promise<ClientFrameData | null> {
  const session = await currentClient();
  if (!session) return null;
  const projects = session.orgId ? listClientProjects(session.orgId).map((p) => ({ id: p.id, title: p.title, stage: p.stage, stageLabel: p.stageLabel })) : [];
  return { user: { name: session.user.name, email: session.user.email }, projects };
}

export type ClientFrameData = { user: { name: string; email: string }; projects: { id: string; title: string; stage: string; stageLabel: string }[] };

/** The signed-in person if there is one (for a header), without redirecting. */
export async function currentClient(): Promise<ResolvedSession | null> {
  return resolveSession((await cookies()).get(SESSION_COOKIE)?.value);
}

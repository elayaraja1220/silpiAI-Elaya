import { ClientShell } from "@/components/client/client-shell";
import { currentClient } from "@/server/client-page";

export const dynamic = "force-dynamic";

/** The client interface: its own frame, separate from the studio's. Each page checks the client sign-in itself. */
export default async function ClientLayout({ children }: { children: React.ReactNode }) {
  const session = await currentClient();
  return <ClientShell user={session ? { name: session.user.name, email: session.user.email } : null}>{children}</ClientShell>;
}

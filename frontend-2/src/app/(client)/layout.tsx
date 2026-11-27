import { ClientShell } from "@/components/client/client-shell";
import { clientFrame } from "@/server/client-page";

export const dynamic = "force-dynamic";

/** The client interface: its own frame, separate from the studio's. Each page checks the client sign-in itself. */
export default async function ClientLayout({ children }: { children: React.ReactNode }) {
  return <ClientShell frame={await clientFrame()}>{children}</ClientShell>;
}

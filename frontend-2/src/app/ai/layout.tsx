import type { Metadata } from "next";

import { AiShell } from "@/components/ai/ai-shell";
import { clientFrame } from "@/server/client-page";

export const metadata: Metadata = { title: "SILPI AI" };
export const dynamic = "force-dynamic";

/** The AI workspace. Signed in, it sits in the client's own frame (so the sidebar and the projects are the same everywhere); the administrator console stays light. */
export default async function AiLayout({ children }: { children: React.ReactNode }) {
  return <AiShell frame={await clientFrame()}>{children}</AiShell>;
}

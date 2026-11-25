import type { Metadata } from "next";

import { AiShell } from "@/components/ai/ai-shell";

export const metadata: Metadata = { title: "AI Gateway | SILPI AI" };

/** The AI Gateway section: its own light layout, outside the dark workspace shell. */
export default function AiLayout({ children }: { children: React.ReactNode }) {
  return <AiShell>{children}</AiShell>;
}

import Link from "next/link";
import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";

import { requireClient } from "@/server/client-page";
import { recordModelChoice } from "@/server/model-choice";

export const metadata: Metadata = { title: "Fixed price project · SILPI AI", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const JOURNEY = ["Describe your project", "Requirement analysis", "Your quotation", "Your approval", "Advance payment", "Development and tracking", "Private demo preview", "Final delivery"];

/**
 * Fixed Price: records the choice. The client's own requirement form (the existing quotation engine, run for the client's workspace with the studio's internal costs
 * hidden) is connected in the next step; until then this page says so plainly instead of pretending.
 */
export default async function Page() {
  const session = await requireClient("/clients/new/fixed-price");
  recordModelChoice(session, "fixed_price");
  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/clients/new" className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"><ArrowLeft size={14} /> Back to your choices</Link>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">Fixed Price Project</h1>
      <p className="mt-3 text-sm leading-6 text-slate-400">Your complete project, designed and developed with a predefined budget, approved requirements and an agreed scope.</p>
      <ol className="mt-8 space-y-3" data-testid="journey">
        {JOURNEY.map((step, i) => (
          <li key={step} className="flex items-center gap-3 rounded-xl border border-white/[.08] bg-[#121622] px-4 py-3 text-sm">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-xs font-semibold text-violet-200">{i + 1}</span>
            {step}
          </li>
        ))}
      </ol>
      <p role="status" className="mt-8 rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100" data-testid="fixed-price-pending">
        The requirement form for fixed-price projects is not open for your account yet. Your choice has been saved.
      </p>
    </div>
  );
}

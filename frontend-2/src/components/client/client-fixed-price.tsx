"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";

import { RequirementWizard } from "@/components/business/requirement-wizard";
import { FIXED_IDEA_KEY, takeIdea } from "@/lib/pending-idea";

/**
 * A client's fixed-price request: the studio's requirement form and quotation engine, run for the client's own workspace. When the quotation is made the client is
 * taken to their quotation page (the secret link), where they compare the packages, choose technology, approve and see how to pay the advance.
 */
export function ClientFixedPrice({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  // The idea typed on the front page (if any) is read once, before the form opens, so it is waiting in the notes.
  const [idea, setIdea] = useState<string | null>(null);
  useEffect(() => setIdea(takeIdea(FIXED_IDEA_KEY)), []);
  return (
    <div>
      <Link href="/clients/new" className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"><ArrowLeft size={14} /> Back to your choices</Link>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">Fixed Price Project</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">Tell us what you want built. Upload a document or describe it, choose the pages and features, and you get a quotation with a fixed price. Nothing is charged until you approve it.</p>
      {idea && <p className="mt-6 rounded-xl border border-violet-400/25 bg-violet-500/[.07] px-4 py-3 text-sm text-slate-300" data-testid="idea-carried">We kept what you wrote on the front page. Add documents if you have them, then press <b className="text-white">Analyse &amp; fill the form</b>.</p>}
      <div className="mt-8">
        {idea !== null && <RequirementWizard
          initialBrief={idea}
          mode="client"
          defaults={{ name, email }}
          onCancel={() => router.push("/clients/new")}
          onCreated={() => undefined}
          onClientCreated={(r) => router.push(`/q/${r.token}`)}
        />}
      </div>
    </div>
  );
}

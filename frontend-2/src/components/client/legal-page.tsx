import Link from "next/link";

import { TERMS_VERSION } from "@/lib/client-auth";

/**
 * The page a sign-up links to. The legal wording is the studio's to write: this page says so plainly and must be replaced with the real text before the site is
 * opened to the public. The version below is recorded with every account that accepts it.
 */
export function LegalPage({ title }: { title: string }) {
  return (
    <main className="min-h-screen bg-[#0e1118] px-4 py-12 text-[#f5f6fb]">
      <article className="mx-auto max-w-2xl space-y-4">
        <Link href="/sign-in" className="text-xs text-violet-300 underline">Back to sign in</Link>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          The text of the {title} has not been added yet. The studio must write or approve it (ideally with legal advice) and replace this page before the site is opened to the public.
        </p>
        <p className="text-xs text-slate-500">Version recorded with each acceptance: {TERMS_VERSION}</p>
      </article>
    </main>
  );
}

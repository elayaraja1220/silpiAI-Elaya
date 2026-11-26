import Link from "next/link";
import type { Metadata } from "next";

import { clientUpdates } from "@/server/client-projects";
import { requireClient } from "@/server/client-page";

export const metadata: Metadata = { title: "Updates · SILPI AI", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** What has changed on the client's projects, newest first. */
export default async function Page() {
  const session = await requireClient("/notifications");
  const updates = clientUpdates(session.orgId, 50);
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div><p className="text-xs font-medium uppercase tracking-[.18em] text-violet-300">Updates</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">What has changed</h1></div>
      {updates.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-white/15 p-8 text-center text-sm text-slate-400" data-testid="empty">Nothing yet. When something changes on one of your projects it appears here.</p>
      ) : (
        <ul className="divide-y divide-white/[.06] rounded-2xl border border-white/[.08] bg-[#121622]" data-testid="updates">
          {updates.map((u, i) => (
            <li key={`${u.projectId}-${i}`}><Link href={`/my-projects/${u.projectId}`} className="block px-5 py-4 hover:bg-white/[.03]"><span className="text-sm text-slate-100">{u.project}</span><span className="text-sm text-slate-400"> · {u.label}</span><span className="block text-xs text-slate-500">{when(u.at)}</span></Link></li>
          ))}
        </ul>
      )}
    </div>
  );
}

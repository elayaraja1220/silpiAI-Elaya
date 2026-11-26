import Link from "next/link";
import type { Metadata } from "next";
import { Plus } from "lucide-react";

import { ProgressSteps } from "@/components/client/progress";
import { listClientProjects } from "@/server/client-projects";
import { requireClient } from "@/server/client-page";

export const metadata: Metadata = { title: "My projects · SILPI AI", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** All of the client's fixed-price projects. */
export default async function Page() {
  const session = await requireClient("/my-projects");
  const projects = listClientProjects(session.orgId);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="text-xs font-medium uppercase tracking-[.18em] text-violet-300">My projects</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Your fixed-price projects</h1></div>
        <Link href="/clients/new" className="inline-flex items-center gap-2 rounded-xl bg-violet-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-400"><Plus size={16} /> New project</Link>
      </div>
      {projects.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/15 p-10 text-center" data-testid="empty">
          <p className="text-sm text-slate-300">You have no projects yet.</p>
          <Link href="/clients/new" className="mt-4 inline-flex rounded-lg bg-violet-500 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-400">Start your first project</Link>
        </div>
      ) : (
        <ul className="space-y-4" data-testid="projects">
          {projects.map((p) => (
            <li key={p.id}>
              <Link href={`/my-projects/${p.id}`} className="block rounded-2xl border border-white/[.08] bg-[#121622] p-5 transition hover:border-violet-400/40">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div><span className="font-medium">{p.title}</span><span className="mt-0.5 block text-xs text-slate-500">{p.quotationNumber ? `${p.quotationNumber} · ` : ""}{p.total ?? "Quotation being prepared"}</span></div>
                  <span className="rounded-full border border-white/10 px-2.5 py-0.5 text-[11px] text-slate-300">{p.stageLabel}</span>
                </div>
                <div className="mt-4"><ProgressSteps step={p.step} /></div>
                <p className="mt-4 text-xs text-slate-400">{p.next.text}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

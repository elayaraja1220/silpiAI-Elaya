"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Bell, ChevronRight, Command, CreditCard, FolderKanban, Home, LogIn, Menu, Plus, Sparkles, UserRound, X, type LucideIcon } from "lucide-react";

import { ProfileMenu } from "@/components/client/profile-menu";
import { cn } from "@/lib/utils";
import type { ClientFrameData } from "@/server/client-page";

/**
 * The Fixed Price side's own frame (dark): a sidebar with the client's links and their projects, and the signed-in person at the bottom (their account menu holds Sign out). Nothing in it
 * names the studio, and no link in it leads to an administrator area. (What a client may open is decided on the server for every page and request; this frame is only
 * what is shown.) The AI workspace is a separate product with its own light frame (src/components/ai/ai-frame.tsx).
 */
const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/client/dashboard", label: "Dashboard", icon: Home },
  { href: "/my-projects", label: "My Projects", icon: FolderKanban },
  { href: "/ai/builder", label: "AI Workspace", icon: Sparkles },
  { href: "/ai/billing", label: "Billing", icon: CreditCard },
  { href: "/profile", label: "Profile", icon: UserRound },
];

/** Shown in the sidebar before "View all". */
const SIDEBAR_PROJECTS = 8;

/** The dot beside a project in the sidebar: violet while its quotation waits, green once it is approved and beyond, grey for a request or a closed one. */
const dotOf = (stage: string) => (stage === "quoted" ? "bg-violet-400" : stage === "requirement" || stage === "lost" ? "bg-slate-500" : "bg-emerald-400");

export type Crumb = { label: string; href?: string };

export function ClientShell({ children, frame, crumbs }: { children: ReactNode; frame: ClientFrameData | null; /** Where this page is, shown at the left of the top bar (the last one is the page itself). */ crumbs?: Crumb[] }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);
  return (
    <div className="min-h-screen bg-[#0e1118] text-[#f5f6fb]" style={{ colorScheme: "dark" }} data-theme="dark">
      {/* Sidebar: fixed on a large screen, a drawer on a small one. */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-white/[.07] bg-[linear-gradient(180deg,#0b0e14_0%,#0d0f1b_55%,#1a1236_100%)] lg:block" aria-label="Client menu">
        <Sidebar frame={frame} path={path} />
      </aside>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-white/[.07] bg-[linear-gradient(180deg,#0b0e14_0%,#0d0f1b_55%,#1a1236_100%)] shadow-2xl">
            <button type="button" aria-label="Close menu" onClick={() => setOpen(false)} className="absolute right-3 top-4 rounded-lg p-2 text-slate-400 hover:bg-white/[.05]"><X size={18} /></button>
            <Sidebar frame={frame} path={path} />
          </aside>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 border-b border-white/[.07] bg-[#0e1118]/85 backdrop-blur-xl">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
            <button type="button" className="rounded-lg p-2 text-slate-300 hover:bg-white/[.05] lg:hidden" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}><Menu size={18} /></button>
            <Link href="/client/dashboard" className="flex items-center gap-2 lg:hidden" aria-label="SILPI AI">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[#a89bff] to-[#6c5ce7] text-[#11131b]"><Command size={16} /></span>
              <span className="text-sm font-semibold tracking-[.12em]">SILPI<span className="text-violet-300"> AI</span></span>
            </Link>
            {crumbs && crumbs.length > 0 && (
              <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-2 text-sm sm:flex" data-testid="breadcrumb">
                {crumbs.map((c, i) => (
                  <span key={i} className="flex min-w-0 items-center gap-2">
                    {i > 0 && <ChevronRight size={14} className="shrink-0 text-slate-600" />}
                    {c.href && i < crumbs.length - 1 ? <Link href={c.href} className="truncate text-slate-400 hover:text-slate-200">{c.label}</Link> : <span aria-current={i === crumbs.length - 1 ? "page" : undefined} className="truncate font-medium text-slate-100">{c.label}</span>}
                  </span>
                ))}
              </nav>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Link href="/clients/new" className="inline-flex items-center gap-1.5 rounded-lg bg-violet-500 px-3 py-2 text-xs font-semibold text-white transition hover:bg-violet-400"><Plus size={14} /> <span className="hidden sm:inline">New project</span></Link>
              <Link href="/notifications" aria-label="Updates" className="rounded-lg border border-white/10 p-2 text-slate-300 hover:bg-white/[.05]"><Bell size={17} /></Link>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">{children}</main>
      </div>
    </div>
  );
}

function Sidebar({ frame, path }: { frame: ClientFrameData | null; path: string }) {
  const projects = frame?.projects ?? [];
  const on = (href: string) => (href === "/my-projects" && path.startsWith("/q/")) || path === href || (href !== "/client/dashboard" && path.startsWith(`${href}/`));
  return (
    <div className="flex h-full flex-col">
      <Link href="/client/dashboard" className="flex h-16 shrink-0 items-center gap-3 border-b border-white/[.07] px-5" aria-label="SILPI AI">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#a89bff] to-[#6c5ce7] text-[#11131b] shadow-lg shadow-violet-500/20"><Command size={18} /></span>
        <span className="text-[15px] font-semibold tracking-[.12em]">SILPI<span className="text-violet-300"> AI</span></span>
      </Link>

      {/* Links and projects scroll; the person (with the account menu) stays at the bottom. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        <nav aria-label="Main" className="space-y-0.5">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={on(n.href) ? "page" : undefined} className={cn("flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition", on(n.href) ? "bg-gradient-to-r from-violet-600 to-purple-500 font-medium text-white shadow-lg shadow-violet-900/40" : "text-slate-300 hover:bg-white/[.05] hover:text-white")}>
              <n.icon size={17} /> {n.label}
            </Link>
          ))}
        </nav>

        {frame && (
          <section className="mt-6" aria-label="Projects" data-testid="sidebar-projects">
            <div className="flex items-center justify-between px-3 pb-2">
              <h2 className="text-[10px] font-semibold uppercase tracking-[.16em] text-slate-500">Projects</h2>
              <span className="rounded-full bg-white/[.07] px-2 py-0.5 text-[10px] font-medium text-slate-300" data-testid="sidebar-project-count">{projects.length}</span>
            </div>
            {projects.length === 0 ? (
              <Link href="/clients/new" className="mx-3 block rounded-lg border border-dashed border-white/10 px-3 py-3 text-xs text-slate-500 hover:border-violet-400/40 hover:text-slate-300">No projects yet. Start one</Link>
            ) : (
              <ul className="space-y-0.5">
                {projects.slice(0, SIDEBAR_PROJECTS).map((p) => {
                  const href = `/my-projects/${p.id}`;
                  return (
                    <li key={p.id}>
                      <Link href={href} title={p.title} aria-current={path === href ? "page" : undefined} className={cn("block rounded-lg px-3 py-2 transition", path === href ? "bg-white/[.06] text-white" : "text-slate-400 hover:bg-white/[.04] hover:text-slate-100")}>
                        <span className="flex items-center gap-2.5"><span className={cn("h-2 w-2 shrink-0 rounded-full", dotOf(p.stage))} /><span className="truncate text-[13px]">{p.title}</span></span>
                        <span className="mt-0.5 flex items-center gap-1.5 pl-[18px] text-[10px] text-slate-500"><span className={cn("h-1.5 w-1.5 shrink-0 rounded-full opacity-70", dotOf(p.stage))} /><span className="truncate">{p.stageLabel}</span></span>
                      </Link>
                    </li>
                  );
                })}
                {projects.length > SIDEBAR_PROJECTS && <li><Link href="/my-projects" className="block px-3 py-2 text-xs text-violet-300 hover:text-violet-200">View all {projects.length}</Link></li>}
              </ul>
            )}
          </section>
        )}
      </div>

      <div className="shrink-0 border-t border-white/[.07] p-3" data-testid="sidebar-user">
        {frame ? (
          <ProfileMenu app="fixed" tone="dark" user={frame.user} projects={frame.projects} />
        ) : (
          <Link href="/sign-in" className="flex items-center justify-center gap-2 rounded-lg border border-white/10 px-3 py-2.5 text-sm text-slate-200 hover:bg-white/[.05]"><LogIn size={15} /> Sign in</Link>
        )}
      </div>
    </div>
  );
}

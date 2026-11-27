"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Activity, ArrowUpRight, Bell, CreditCard, Hammer, LayoutDashboard, LogIn, Menu, MessageSquare, X, type LucideIcon } from "lucide-react";

import { STATUS_LABEL } from "@/components/ai/build-status";
import { ProfileMenu } from "@/components/client/profile-menu";
import { SHOW_AI_BILLING_LINK, SHOW_AI_DASHBOARD_LINK } from "@/lib/feature-flags";
import { cn } from "@/lib/utils";
import type { ClientFrameData } from "@/server/client-page";
import { BrandLogo } from "./brand-logo";

/**
 * The AI workspace's own frame (light): a sidebar with the workspace's links (Build is its home, then Chat and Usage), its builds, and the signed-in person at the bottom
 * (their account menu holds Sign out). The AI workspace is a separate product from Fixed Price (which has its own dark frame): the home is the prompt, and the plan and credits are a balance in
 * the top bar, not a menu. Dashboard and Billing are in the list but switched off (src/lib/feature-flags.ts); nothing behind them is removed, and the Fixed Price
 * sidebar still has both.
 */
const NAV: { href: string; label: string; icon: LucideIcon; show: boolean; match?: (path: string) => boolean }[] = [
  { href: "/ai/dashboard", label: "Dashboard", icon: LayoutDashboard, show: SHOW_AI_DASHBOARD_LINK, match: (p) => p.startsWith("/ai/dashboard") },
  { href: "/ai/builder", label: "Build", icon: Hammer, show: true, match: (p) => p.startsWith("/ai/builder") },
  { href: "/ai", label: "Chat", icon: MessageSquare, show: true, match: (p) => p === "/ai" },
  { href: "/ai/usage", label: "Usage", icon: Activity, show: true },
  { href: "/ai/billing", label: "Billing", icon: CreditCard, show: SHOW_AI_BILLING_LINK },
];

type BuildLine = { id: string; title: string; status: string };

/** Shown in the sidebar before "View all". */
const SIDEBAR_BUILDS = 8;

export function AiFrame({ children, frame, headerExtra }: { children: ReactNode; frame: ClientFrameData | null; /** The credit balance, in the top bar. */ headerExtra?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900" style={{ colorScheme: "light" }} data-theme="light">
      {/* Sidebar: fixed on a large screen, a drawer on a small one. */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-slate-200 bg-white lg:block" aria-label="AI menu">
        <Sidebar frame={frame} path={path} />
      </aside>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-slate-200 bg-white shadow-2xl">
            <button type="button" aria-label="Close menu" onClick={() => setOpen(false)} className="absolute right-3 top-4 rounded-lg p-2 text-slate-500 hover:bg-slate-100"><X size={18} /></button>
            <Sidebar frame={frame} path={path} />
          </aside>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur-xl print:hidden">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
            <button type="button" className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}><Menu size={18} /></button>
            <Link href="/ai/builder" className="flex items-center lg:hidden" aria-label="SILPI AI home"><BrandLogo /></Link>
            <div className="ml-auto flex items-center gap-2">
              {headerExtra}
              <UpdatesBell signedIn={!!frame} path={path} />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">{children}</main>
      </div>
    </div>
  );
}

/** The bell: the AI workspace's own updates (builds, credits), with a dot while something needs the person. The Fixed Price application has its own bell and its own list. */
function UpdatesBell({ signedIn, path }: { signedIn: boolean; path: string }) {
  const [needs, setNeeds] = useState(0);
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    fetch("/api/workspace/updates", { cache: "no-store" })
      .then((r) => r.json())
      .then((r: { needsAction?: number }) => { if (live) setNeeds(r.needsAction ?? 0); })
      .catch(() => { if (live) setNeeds(0); });
    return () => { live = false; };
  }, [signedIn, path]);
  return (
    <Link href="/ai/updates" aria-label={needs > 0 ? `Updates: ${needs} need you` : "Updates"} title="Updates" className="relative rounded-lg p-2 text-slate-600 hover:bg-slate-100" data-testid="ai-bell">
      <Bell size={17} />
      {needs > 0 && <span className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-indigo-600 ring-2 ring-white" data-testid="ai-bell-dot" />}
    </Link>
  );
}

function Sidebar({ frame, path }: { frame: ClientFrameData | null; path: string }) {
  const links = NAV.filter((n) => n.show);
  const on = (n: { href: string; match?: (path: string) => boolean }) => (n.match ? n.match(path) : path === n.href || path.startsWith(`${n.href}/`));
  // The builds, read when the page changes so a new build appears in the list straight away.
  const [builds, setBuilds] = useState<BuildLine[] | null>(null);
  useEffect(() => {
    if (!frame) return;
    let live = true;
    fetch("/api/workspace/jobs", { cache: "no-store" })
      .then((r) => r.json())
      .then((r: { jobs?: BuildLine[] }) => { if (live) setBuilds(r.jobs ?? []); })
      .catch(() => { if (live) setBuilds([]); });
    return () => { live = false; };
  }, [frame, path]);
  return (
    <div className="flex h-full flex-col">
      <Link href="/ai/builder" className="flex h-16 shrink-0 items-center border-b border-slate-200 px-5" aria-label="SILPI AI home"><BrandLogo /></Link>

      {/* Links and builds scroll; the person (with the account menu) stays at the bottom. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        <nav aria-label="Main" className="space-y-0.5">
          {links.map((n) => (
            <Link key={n.href} href={n.href} aria-current={on(n) ? "page" : undefined} className={cn("flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition", on(n) ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900")}>
              <n.icon size={17} /> {n.label}
            </Link>
          ))}
        </nav>

        {frame && (
          <>
            <section className="mt-6" aria-label="Builds" data-testid="sidebar-builds">
              <div className="flex items-center justify-between px-3 pb-2">
                <h2 className="text-[10px] font-semibold uppercase tracking-[.16em] text-slate-400">Builds</h2>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600" data-testid="sidebar-build-count">{builds ? builds.length : "…"}</span>
              </div>
              {builds && builds.length === 0 ? (
                <Link href="/ai/builder" className="mx-3 block rounded-lg border border-dashed border-slate-300 px-3 py-3 text-xs text-slate-500 hover:border-indigo-300 hover:text-slate-700">No builds yet. Describe an idea</Link>
              ) : (
                <ul className="space-y-0.5">
                  {(builds ?? []).slice(0, SIDEBAR_BUILDS).map((b) => {
                    const href = `/ai/builder/${b.id}`;
                    return (
                      <li key={b.id}>
                        <Link href={href} title={b.title} aria-current={path === href ? "page" : undefined} className={cn("block rounded-lg px-3 py-2 transition", path === href ? "bg-slate-100 text-slate-900" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900")}>
                          <span className="block truncate text-[13px]">{b.title}</span>
                          <span className="block truncate text-[10px] text-slate-400">{STATUS_LABEL[b.status] ?? b.status}</span>
                        </Link>
                      </li>
                    );
                  })}
                  {builds && builds.length > SIDEBAR_BUILDS && <li><Link href="/ai/builder#builds-heading" className="block px-3 py-2 text-xs text-indigo-600 hover:text-indigo-800">View all {builds.length}</Link></li>}
                </ul>
              )}
            </section>
            {/* The way over to the other product: the client's fixed-price projects. */}
            <Link href="/my-projects" className="mt-6 flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2.5 text-xs text-slate-500 transition hover:border-slate-300 hover:text-slate-900" data-testid="to-fixed-price">
              <span>Fixed-price projects</span> <ArrowUpRight size={14} />
            </Link>
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-slate-200 p-3" data-testid="sidebar-user">
        {frame ? (
          <ProfileMenu app="ai" tone="light" user={frame.user} />
        ) : (
          <Link href="/sign-in" className="flex items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50"><LogIn size={15} /> Sign in</Link>
        )}
      </div>
    </div>
  );
}

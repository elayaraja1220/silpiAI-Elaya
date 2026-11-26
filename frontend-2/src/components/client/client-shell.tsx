"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Bell, Command, LogOut, Menu, Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The client's own frame: their pages only. Nothing in it names the studio, and no link in it leads to an administrator area. (What a client may open is decided on the
 * server for every page and request; this header is only what is shown.)
 */
const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/my-projects", label: "My Projects" },
  { href: "/ai/builder", label: "AI Workspace" },
  { href: "/ai/billing", label: "Billing" },
  { href: "/profile", label: "Profile" },
];

export function ClientShell({ children, user }: { children: ReactNode; user: { name: string; email: string } | null }) {
  const [open, setOpen] = useState(false);
  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/sign-in");
  };
  return (
    <div className="min-h-screen bg-[#0e1118] text-[#f5f6fb]">
      <header className="sticky top-0 z-30 border-b border-white/[.07] bg-[#0e1118]/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link href="/dashboard" className="flex items-center gap-3" aria-label="SILPI AI">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#a89bff] to-[#6c5ce7] text-[#11131b] shadow-lg shadow-violet-500/20"><Command size={18} /></span>
            <span className="text-[15px] font-semibold tracking-[.12em]">SILPI<span className="text-violet-300"> AI</span></span>
          </Link>
          <nav className="ml-4 hidden items-center gap-1 md:flex" aria-label="Main">
            {NAV.map((n) => <Link key={n.href} href={n.href} className="rounded-lg px-3 py-2 text-sm text-slate-300 transition hover:bg-white/[.05] hover:text-white">{n.label}</Link>)}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <Link href="/clients/new" className="hidden items-center gap-1.5 rounded-lg bg-violet-500 px-3 py-2 text-xs font-semibold text-white transition hover:bg-violet-400 sm:inline-flex"><Plus size={14} /> New project</Link>
            <Link href="/notifications" aria-label="Updates" className="rounded-lg p-2 text-slate-300 hover:bg-white/[.05]"><Bell size={17} /></Link>
            {user && <span className="hidden text-right text-xs leading-4 sm:block"><span className="block font-medium text-slate-200">{user.name}</span><span className="block text-slate-500">{user.email}</span></span>}
            {user && <button type="button" onClick={() => void signOut()} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-300 transition hover:bg-white/[.05]"><LogOut size={14} /> Sign out</button>}
            <button type="button" className="rounded-lg p-2 text-slate-300 hover:bg-white/[.05] md:hidden" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? <X size={18} /> : <Menu size={18} />}</button>
          </div>
        </div>
        <nav className={cn("border-t border-white/[.07] px-4 py-2 md:hidden", open ? "block" : "hidden")} aria-label="Main (mobile)">
          {NAV.map((n) => <Link key={n.href} href={n.href} onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2.5 text-sm text-slate-300 hover:bg-white/[.05]">{n.label}</Link>)}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">{children}</main>
    </div>
  );
}

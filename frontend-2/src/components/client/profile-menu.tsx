"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Activity, Bell, Check, ChevronsUpDown, CreditCard, FileText, FolderKanban, Hammer, LogOut, Shield, Sparkles, UserRound, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ClientFrameData } from "@/server/client-page";

/**
 * The menu that slides up from the person at the bottom of each sidebar, in both applications (Fixed Price, dark; the AI workspace, light). It follows what the AI builders
 * put under the account: who you are, your plan and balance, the account's pages, a switch between applications, and the legal pages. Sign out is the last item.
 */
type Tone = "dark" | "light";
type App = "fixed" | "ai";

const T = {
  dark: {
    trigger: "border-white/[.08] bg-white/[.03] hover:bg-white/[.06]",
    avatar: "bg-gradient-to-br from-violet-500 to-purple-700 text-white",
    name: "text-slate-100", sub: "text-slate-500", chevron: "text-slate-500",
    menu: "border-white/10 bg-[#141826] shadow-2xl shadow-black/60",
    item: "text-slate-200 hover:bg-white/[.06]", icon: "text-slate-400", hint: "text-slate-500", head: "text-slate-500", rule: "border-white/[.08]",
    card: "border-violet-400/25 bg-violet-500/10", cardText: "text-slate-100", cardSub: "text-slate-400",
    cta: "bg-violet-500 text-white hover:bg-violet-400", current: "bg-white/[.05]", tick: "text-violet-300", danger: "text-rose-300 hover:bg-rose-500/10",
    scrim: "bg-transparent",
  },
  light: {
    trigger: "border-slate-200 bg-white hover:bg-slate-50",
    avatar: "bg-indigo-100 text-indigo-700",
    name: "text-slate-900", sub: "text-slate-500", chevron: "text-slate-400",
    menu: "border-slate-200 bg-white shadow-2xl shadow-slate-900/15",
    item: "text-slate-700 hover:bg-slate-50", icon: "text-slate-400", hint: "text-slate-400", head: "text-slate-400", rule: "border-slate-100",
    card: "border-indigo-100 bg-indigo-50", cardText: "text-slate-900", cardSub: "text-slate-500",
    cta: "bg-indigo-600 text-white hover:bg-indigo-500", current: "bg-slate-50", tick: "text-indigo-600", danger: "text-rose-600 hover:bg-rose-50",
    scrim: "bg-transparent",
  },
} as const;

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
const creditsOf = (units: number) => (units / 1000).toLocaleString("en-IN", { maximumFractionDigits: 3 });

export function ProfileMenu({ app, tone, user, projects = [] }: { app: App; tone: Tone; user: { name: string; email: string }; projects?: ClientFrameData["projects"] }) {
  const t = T[tone];
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<{ name: string | null; units: number } | null>(null);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  // The plan and balance are read when the menu opens, so they are current.
  useEffect(() => {
    if (!open || app !== "ai") return;
    let live = true;
    fetch("/api/workspace/billing", { cache: "no-store" })
      .then((r) => r.json())
      .then((r: { billing?: { plan?: { name: string } | null; wallet?: { availableUnits: number } } }) => { if (live && r.billing) setPlan({ name: r.billing.plan?.name ?? null, units: r.billing.wallet?.availableUnits ?? 0 }); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [open, app]);

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/sign-in");
  };
  const waiting = projects.filter((p) => ["quoted", "approved", "demo_ready"].includes(p.stage)).length;

  const Row = ({ href, icon: Icon, label, hint, external = false }: { href: string; icon: LucideIcon; label: string; hint?: string; external?: boolean }) => (
    <Link href={href} role="menuitem" {...(external ? { target: "_blank", rel: "noopener" } : {})} className={cn("flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition", t.item)}>
      <Icon size={16} className={t.icon} /> <span className="flex-1">{label}</span>{hint && <span className={cn("text-[11px]", t.hint)}>{hint}</span>}
    </Link>
  );
  const Heading = ({ children }: { children: string }) => <p className={cn("px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[.14em]", t.head)}>{children}</p>;
  const App = ({ href, icon: Icon, label, current }: { href: string; icon: LucideIcon; label: string; current: boolean }) => (
    <Link href={href} role="menuitemradio" aria-checked={current} className={cn("flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition", current ? t.current : t.item)}>
      <Icon size={16} className={t.icon} /> <span className="flex-1">{label}</span>{current && <Check size={15} className={t.tick} />}
    </Link>
  );

  return (
    <div className="relative">
      {open && <button type="button" aria-label="Close menu" tabIndex={-1} className={cn("fixed inset-0 z-40 cursor-default", t.scrim)} onClick={() => setOpen(false)} />}
      {open && (
        <div role="menu" aria-label="Account" className={cn("silpi-slide-up absolute bottom-full left-0 right-0 z-50 mb-2 max-h-[70vh] overflow-y-auto rounded-2xl border p-1.5", t.menu)} data-testid="profile-menu">
          <div className={cn("flex items-center gap-3 px-3 py-2.5")}>
            <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold", t.avatar)}>{initials(user.name)}</span>
            <span className="min-w-0 leading-4"><span className={cn("block truncate text-sm font-semibold", t.name)}>{user.name}</span><span className={cn("block truncate text-[11px]", t.sub)}>{user.email}</span></span>
          </div>

          {app === "ai" ? (
            <div className={cn("mx-1.5 mb-1.5 mt-1 rounded-xl border p-3", t.card)} data-testid="menu-plan">
              <p className={cn("text-[11px]", t.cardSub)}>{plan ? (plan.name ? `${plan.name} plan` : "No plan yet") : "Your plan"}</p>
              <p className={cn("mt-0.5 text-lg font-semibold tabular-nums", t.cardText)}>{plan ? creditsOf(plan.units) : "…"} <span className={cn("text-xs font-normal", t.cardSub)}>credits</span></p>
              <Link href="/ai/billing" role="menuitem" className={cn("mt-2 block rounded-lg px-3 py-1.5 text-center text-xs font-semibold transition", t.cta)}>Plans and credits</Link>
            </div>
          ) : (
            <div className={cn("mx-1.5 mb-1.5 mt-1 rounded-xl border p-3", t.card)} data-testid="menu-projects">
              <p className={cn("text-[11px]", t.cardSub)}>Your fixed-price projects</p>
              <p className={cn("mt-0.5 text-sm", t.cardText)}><b className="text-lg font-semibold tabular-nums">{projects.length}</b> {projects.length === 1 ? "project" : "projects"}{waiting > 0 && <span className={t.cardSub}> · {waiting} waiting for you</span>}</p>
            </div>
          )}

          <Row href="/profile" icon={UserRound} label="Profile" hint="Details, password" />
          {app === "ai" ? (
            <>
              <Row href="/ai/updates" icon={Bell} label="Updates" />
              <Row href="/ai/usage" icon={Activity} label="Usage" />
              <Row href="/ai/billing" icon={CreditCard} label="Billing and invoices" />
            </>
          ) : (
            <>
              <Row href="/notifications" icon={Bell} label="Updates" />
              <Row href="/my-projects" icon={FolderKanban} label="My projects" />
            </>
          )}

          <div className={cn("my-1.5 border-t", t.rule)} />
          <Heading>Applications</Heading>
          <App href="/client/dashboard" icon={Hammer} label="Fixed Price" current={app === "fixed"} />
          <App href="/ai/builder" icon={Sparkles} label="AI Workspace" current={app === "ai"} />

          <div className={cn("my-1.5 border-t", t.rule)} />
          <Row href="/terms" icon={FileText} label="Terms of Service" external />
          <Row href="/privacy" icon={Shield} label="Privacy Policy" external />

          <div className={cn("my-1.5 border-t", t.rule)} />
          <button type="button" role="menuitem" onClick={() => void signOut()} className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition", t.danger)} data-testid="sign-out">
            <LogOut size={16} /> Sign out
          </button>
        </div>
      )}
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} className={cn("flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition", t.trigger)} data-testid="profile-menu-trigger">
        <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold", t.avatar)}>{initials(user.name)}</span>
        <span className="min-w-0 flex-1 leading-4"><span className={cn("block truncate text-sm font-medium", t.name)}>{user.name}</span><span className={cn("block truncate text-[11px]", t.sub)}>{user.email}</span></span>
        <ChevronsUpDown size={15} className={t.chevron} />
      </button>
    </div>
  );
}

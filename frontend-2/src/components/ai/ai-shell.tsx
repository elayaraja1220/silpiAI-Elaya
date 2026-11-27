"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Coins, Loader2, LogOut } from "lucide-react";

import { AiFrame } from "@/components/ai/ai-frame";
import { SHOW_AI_BILLING_LINK, SHOW_AI_CREDITS_CHIP, SHOW_AI_DASHBOARD_LINK } from "@/lib/feature-flags";
import { cn } from "@/lib/utils";
import type { ClientFrameData } from "@/server/client-page";
import { BrandLogo } from "./brand-logo";
import { api, Card, credits } from "./light";
import { Landing } from "./landing";

type Me = { user: { name: string; email: string }; organization: { id: string; name: string }; role: string };
const MeContext = createContext<Me | null>(null);
/** The signed-in member. Only available inside a page that requires sign-in. */
export const useMe = () => useContext(MeContext)!;

/** Pages announce "my credits changed" with this, so the balance in the header updates without a reload. */
export const WALLET_CHANGED = "silpi:ai-wallet-changed";

/** The links of the light layout's header (the printable invoice). Dashboard and Billing are switched off like in the sidebar (src/lib/feature-flags.ts). */
const TABS: { href: string; label: string; show: boolean }[] = [
  { href: "/ai/dashboard", label: "Dashboard", show: SHOW_AI_DASHBOARD_LINK },
  { href: "/ai", label: "Chat", show: true },
  { href: "/ai/builder", label: "Project builder", show: true },
  { href: "/ai/usage", label: "Usage", show: true },
  { href: "/ai/billing", label: "Billing", show: SHOW_AI_BILLING_LINK },
];

/**
 * The AI workspace's frame. Signed in, it is the AI workspace's own light frame (src/components/ai/ai-frame.tsx): a sidebar with the workspace's links (Build, Chat,
 * Usage), its builds and the person, and the credit balance in the top bar (it opens the plans and credits page). The Fixed Price side is a different product with its
 * own dark frame. The administrator console and the printable invoice keep a plain light layout with a top bar (the console is the team's).
 */
export function AiShell({ children, frame = null }: { children: ReactNode; frame?: ClientFrameData | null }) {
  const pathname = usePathname();
  const admin = pathname.startsWith("/ai/admin");
  const printable = pathname.startsWith("/ai/billing/document");
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  const [available, setAvailable] = useState<number | null>(null);

  const loadMe = useCallback(() => {
    api<Me & { success: true }>("/api/auth/me").then(setMe).catch(() => setMe(null)).finally(() => setChecking(false));
  }, []);
  useEffect(loadMe, [loadMe]);

  const loadWallet = useCallback(() => {
    api<{ wallet: { availableUnits: number } }>("/api/workspace/ai/models").then((r) => setAvailable(r.wallet.availableUnits)).catch(() => setAvailable(null));
  }, []);
  useEffect(() => { if (me) loadWallet(); else setAvailable(null); }, [me, pathname, loadWallet]);
  useEffect(() => {
    window.addEventListener(WALLET_CHANGED, loadWallet);
    return () => window.removeEventListener(WALLET_CHANGED, loadWallet);
  }, [loadWallet]);

  const signOut = async () => {
    await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => {});
    setMe(null);
  };

  // Anyone not signed in who opens a page inside the AI workspace is taken to the one sign-in page and brought back here afterwards.
  useEffect(() => {
    if (!checking && !me && !admin && pathname !== "/ai") window.location.assign(`/sign-in?next=${encodeURIComponent(pathname)}`);
  }, [checking, me, admin, pathname]);

  // Anyone not signed in who opens the front address sees the public landing page, with its own header and footer.
  // (While the sign-in check runs, the server's own answer decides, so a visitor never sees the signed-in frame flash by.)
  if (pathname === "/ai" && (checking ? !frame : !me)) return <Landing />;

  const waiting = (text: string) => <Card className="mx-auto flex max-w-sm items-center justify-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> {text}</Card>;

  if (!admin && !printable) {
    const chip = SHOW_AI_CREDITS_CHIP && me && available !== null ? (
      <Link href="/ai/billing" title="Credits available" className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 hover:border-slate-300" data-testid="credit-chip">
        <Coins size={14} className="text-indigo-600" /><span className="font-semibold tabular-nums">{credits(available)}</span><span className="hidden text-slate-500 sm:inline">credits</span>
      </Link>
    ) : null;
    return (
      <AiFrame frame={frame} headerExtra={chip}>
        <div data-testid="ai-section">
          {checking ? waiting("Checking your sign-in...") : me ? <MeContext.Provider value={me}>{children}</MeContext.Provider> : waiting("Taking you to sign in...")}
          <p className="mt-12 text-center text-xs text-slate-400">You are charged the real cost of each request, and failed requests are free.</p>
        </div>
      </AiFrame>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900" style={{ colorScheme: "light" }} data-theme="light" data-testid="ai-section">
      <header className="sticky top-0 z-10 print:hidden border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-2.5 sm:px-6">
          <Link href={admin ? "/ai/admin" : "/ai"} className="flex shrink-0 items-center" aria-label="SILPI AI home"><BrandLogo /></Link>
          <nav className="-mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1" aria-label="SILPI AI sections">
            {!admin && TABS.filter((t) => t.show).map((t) => {
              const active = t.href === "/ai" ? pathname === "/ai" : pathname.startsWith(t.href);
              return <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined} className={cn("shrink-0 rounded-lg px-3 py-1.5 text-sm transition", active ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600 hover:bg-slate-100")}>{t.label}</Link>;
            })}
          </nav>
          <div className="flex shrink-0 items-center gap-2 text-sm">
            {me && !admin && (
              <button onClick={signOut} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800" title={`${me.user.email} · ${me.organization.name}`}><LogOut size={15} /><span className="hidden md:inline">Sign out</span></button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        {admin ? children : checking ? waiting("Checking your sign-in...") : me ? <MeContext.Provider value={me}>{children}</MeContext.Provider> : waiting("Taking you to sign in...")}
      </main>

      <footer className="print:hidden border-t border-slate-200 py-4 text-center text-xs text-slate-400">SILPI AI · you are charged the real cost of each request, and failed requests are free</footer>
    </div>
  );
}

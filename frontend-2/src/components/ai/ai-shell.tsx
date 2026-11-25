"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, Coins, Loader2, LogOut } from "lucide-react";

import { cn } from "@/lib/utils";
import { BrandLogo } from "./brand-logo";
import { api, Card, credits } from "./light";
import { Landing } from "./landing";
import { SignIn } from "./sign-in";

type Me = { user: { name: string; email: string }; organization: { id: string; name: string }; role: string };
const MeContext = createContext<Me | null>(null);
/** The signed-in member. Only available inside a page that requires sign-in. */
export const useMe = () => useContext(MeContext)!;

/** Pages announce "my credits changed" with this, so the balance in the header updates without a reload. */
export const WALLET_CHANGED = "silpi:ai-wallet-changed";

const TABS = [
  { href: "/ai", label: "Chat" },
  { href: "/ai/builder", label: "Project builder" },
  { href: "/ai/usage", label: "Usage" },
  { href: "/ai/billing", label: "Billing" },
  { href: "/ai/admin", label: "Admin" },
];

/**
 * The AI Gateway section's own light frame, sign-in included. It lives outside the dark workspace layout on purpose: nothing in the
 * existing screens changes, and "Workspace" returns to them. The Admin tab uses the administrator token, not a member sign-in.
 */
export function AiShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const admin = pathname.startsWith("/ai/admin");
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

  // Anyone not signed in who opens the front address sees the public landing page, with its own header and footer.
  if (!checking && !me && pathname === "/ai") return <Landing />;

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900" style={{ colorScheme: "light" }} data-theme="light" data-testid="ai-section">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-2.5 sm:px-6">
          <Link href="/ai" className="flex shrink-0 items-center" aria-label="SILPI AI home"><BrandLogo /></Link>
          <nav className="-mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1" aria-label="SILPI AI sections">
            {TABS.map((t) => {
              const active = t.href === "/ai" ? pathname === "/ai" : pathname.startsWith(t.href);
              return <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined} className={cn("shrink-0 rounded-lg px-3 py-1.5 text-sm transition", active ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600 hover:bg-slate-100")}>{t.label}</Link>;
            })}
          </nav>
          <div className="flex shrink-0 items-center gap-2 text-sm">
            {me && !admin && available !== null && (
              <Link href="/ai/billing" title="Credits available" className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-700 hover:border-slate-300" data-testid="credit-chip"><Coins size={14} className="text-indigo-600" /><span className="font-medium tabular-nums">{credits(available)}</span><span className="hidden text-slate-500 sm:inline">credits</span></Link>
            )}
            {me && !admin && (
              <button onClick={signOut} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800" title={`${me.user.email} · ${me.organization.name}`}><LogOut size={15} /><span className="hidden md:inline">Sign out</span></button>
            )}
            <Link href="/" className="hidden items-center gap-1 rounded-lg px-2 py-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 md:inline-flex"><ArrowLeft size={14} /> Workspace</Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        {admin ? children : checking ? (
          <Card className="mx-auto flex max-w-sm items-center justify-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Checking your sign-in...</Card>
        ) : me ? (
          <MeContext.Provider value={me}>{children}</MeContext.Provider>
        ) : (
          <SignIn onDone={loadMe} />
        )}
      </main>

      <footer className="border-t border-slate-200 py-4 text-center text-xs text-slate-400">SILPI AI · you are charged the real cost of each request, and failed requests are free</footer>
    </div>
  );
}

"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { api, Button, Card } from "./light";

type Me = { user: { name: string; email: string }; organization: { id: string; name: string }; role: string };
const MeContext = createContext<Me | null>(null);
/** The signed-in member. Only available inside a page that requires sign-in. */
export const useMe = () => useContext(MeContext)!;

const TABS = [
  { href: "/ai", label: "Playground", needsAdmin: false },
  { href: "/ai/usage", label: "Usage", needsAdmin: false },
  { href: "/ai/admin", label: "Admin", needsAdmin: true },
];

/**
 * The AI Gateway section's own light frame. It lives outside the dark workspace layout on purpose: nothing in the existing
 * screens changes, and "Back to workspace" returns to them. The Admin tab uses the administrator token, not a member sign-in.
 */
export function AiShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const admin = pathname.startsWith("/ai/admin");
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);

  const load = useCallback(() => {
    api<Me & { success: true }>("/api/auth/me").then(setMe).catch(() => setMe(null)).finally(() => setChecking(false));
  }, []);
  useEffect(load, [load]);

  const signOut = async () => {
    await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => {});
    setMe(null);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900" style={{ colorScheme: "light" }} data-theme="light" data-testid="ai-section">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft size={15} /> Back to workspace</Link>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white"><Sparkles size={16} /></span>
            <span className="text-[15px] font-semibold tracking-tight">AI Gateway</span>
          </div>
          <nav className="flex gap-1" aria-label="AI Gateway sections">
            {TABS.map((t) => {
              const active = t.href === "/ai" ? pathname === "/ai" : pathname.startsWith(t.href);
              return <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined} className={cn("rounded-lg px-3 py-1.5 text-sm transition", active ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600 hover:bg-slate-100")}>{t.label}</Link>;
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-slate-600">
            {me && !admin && (<><span className="hidden sm:inline">{me.organization.name} · <span className="capitalize">{me.role}</span></span><button onClick={signOut} className="text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline">Sign out</button></>)}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {admin ? children : checking ? (
          <Card className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Checking your sign-in...</Card>
        ) : me ? (
          <MeContext.Provider value={me}>{children}</MeContext.Provider>
        ) : (
          <Card className="mx-auto max-w-md space-y-3 text-center">
            <h2 className="text-lg font-semibold">Sign in to use the AI Gateway</h2>
            <p className="text-sm text-slate-600">The gateway spends your organization&apos;s credits, so it needs a member account. Accounts are created by the administrator.</p>
            <div className="flex justify-center gap-2">
              <Link href="/login"><Button>Sign in</Button></Link>
              <Button variant="ghost" onClick={load}>I have signed in</Button>
            </div>
          </Card>
        )}
      </main>
    </div>
  );
}

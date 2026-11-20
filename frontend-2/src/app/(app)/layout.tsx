import { AppShell } from "@/components/layout/app-shell";

/** Everything with the sidebar. The public client link (/q/...) is outside this group. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}

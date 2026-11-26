import { TeamChatWidget } from "@/components/business/team-chat-widget";
import { AppShell } from "@/components/layout/app-shell";
import { SHOW_TEAM_LIVE_CHAT } from "@/lib/feature-flags";

/** Everything with the sidebar. The public client link (/q/...) is outside this group. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      {children}
      {/* The team's live chat: a bar at the bottom-right of every page. Hidden for now (see src/lib/feature-flags.ts); nothing is removed. */}
      {SHOW_TEAM_LIVE_CHAT && <TeamChatWidget />}
    </AppShell>
  );
}

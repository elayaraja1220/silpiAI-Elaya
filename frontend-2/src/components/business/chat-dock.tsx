"use client";

import { ChevronUp, MessageCircle } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The "Live chat" bar fixed to the bottom-right of the screen. Clicking the bar slides the conversation up; clicking again
 * slides it down. The content stays mounted when closed (so new messages are still counted) but cannot be reached.
 */
export function ChatDock({
  title,
  badge = 0,
  open,
  onToggle,
  theme,
  children,
}: {
  title: string;
  badge?: number;
  open: boolean;
  onToggle: () => void;
  theme: "dark" | "light";
  children: React.ReactNode;
}) {
  const dark = theme === "dark";
  return (
    <div className="no-print fixed bottom-0 right-3 z-50 w-[22rem] max-w-[calc(100vw-1.5rem)] sm:right-5" data-testid="chat-dock">
      <div className={cn("overflow-hidden rounded-t-xl border border-b-0 shadow-2xl", dark ? "border-white/10 bg-[#141927]" : "border-slate-200 bg-white")}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls="chat-dock-body"
          data-testid="chat-header"
          className="flex w-full items-center gap-2 bg-violet-600 px-4 py-3 text-left text-sm font-semibold text-white hover:bg-violet-500"
        >
          <MessageCircle size={16} />
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {badge > 0 && <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-bold text-violet-700" data-testid="chat-badge">{badge > 99 ? "99+" : badge}</span>}
          <ChevronUp size={16} className={cn("shrink-0 transition-transform duration-300", open && "rotate-180")} />
        </button>
        <div
          id="chat-dock-body"
          aria-hidden={!open}
          // `inert` keeps a closed chat out of reach of the keyboard and screen readers.
          {...(!open ? { inert: true } : {})}
          className={cn("overflow-hidden transition-[max-height] duration-300 ease-out", open ? "max-h-[34rem]" : "max-h-0")}
          data-testid="chat-body"
        >
          <div className="p-3">{children}</div>
        </div>
      </div>
    </div>
  );
}

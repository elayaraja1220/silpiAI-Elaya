"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";

import type { Conversation } from "@/lib/business/chat";

import { ChatBox } from "./chat-box";
import { ChatDock } from "./chat-dock";

const LIST_MS = 8000;

/** "2 min ago" style, short and plain. */
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

/**
 * The team's live chat, on every page of the app: a bar at the bottom-right. Click it to slide the chat up, pick a client,
 * and talk. The number on the bar is how many client messages are waiting.
 */
export function TeamChatWidget() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Conversation[]>([]);
  const [unread, setUnread] = useState(0);
  const [leadId, setLeadId] = useState<string | null>(null);
  const [fresh, setFresh] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = (await (await fetch("/api/business/chat", { cache: "no-store" })).json()) as { success?: boolean; conversations?: Conversation[]; unread?: number };
      if (r.success && r.conversations) { setList(r.conversations); setUnread(r.unread ?? 0); }
    } catch { /* the next check tries again */ }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, LIST_MS);
    return () => clearInterval(timer);
  }, [load]);

  const current = list.find((c) => c.leadId === leadId) ?? null;
  // The open conversation is being read, so its own messages do not count as waiting.
  const waiting = unread - (open && current ? current.unread : 0);

  return (
    <ChatDock title="Live chat" badge={Math.max(0, waiting)} open={open} onToggle={() => { setOpen((o) => !o); void load(); }} theme="dark">
      {!current ? (
        <div data-testid="chat-conversations">
          {list.length === 0 ? (
            <p className="py-10 text-center text-xs text-slate-500">No conversations yet. Share a quotation link with a client and their chat will appear here.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-white/[.06] overflow-y-auto">
              {list.map((c) => (
                <li key={c.leadId}>
                  <button type="button" onClick={() => { setLeadId(c.leadId); setFresh((n) => n + 1); }} className="flex w-full items-start gap-2 px-1 py-2.5 text-left hover:bg-white/[.04]" data-testid="chat-conversation">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-100">{c.client}</span>
                      <span className="block truncate text-[11px] text-slate-500">{c.title}</span>
                      <span className="mt-0.5 block truncate text-xs text-slate-400">{c.lastText ? `${c.lastSender === "team" ? "You: " : ""}${c.lastText}` : "No messages yet"}</span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-[10px] text-slate-500">{c.lastText ? ago(c.lastAt) : ""}</span>
                      {c.unread > 0 && <span className="rounded-full bg-violet-500 px-1.5 text-[10px] font-bold text-white">{c.unread}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div>
          <button type="button" onClick={() => { setLeadId(null); void load(); }} className="mb-2 flex items-center gap-1.5 text-xs text-slate-400 hover:text-white">
            <ArrowLeft size={13} /> All chats · <span className="font-medium text-slate-200">{current.client}</span>
          </button>
          <ChatBox
            key={`${current.leadId}:${fresh}`}
            endpoint={`/api/business/leads/${current.leadId}/chat`}
            side="team"
            theme="dark"
            visible={open}
            placeholder="Reply to the client..."
            emptyText="No messages yet. Write first, or wait for the client."
            listClass="h-72"
          />
        </div>
      )}
    </ChatDock>
  );
}

"use client";

import { useState } from "react";

import { ChatBox } from "./chat-box";
import { ChatDock } from "./chat-dock";

/**
 * The client's live chat, on their quotation page: a bar at the bottom-right. Click it to slide the chat up and write to the team.
 * It stays mounted while closed, so a reply from the team still shows as a number on the bar.
 */
export function ClientChatWidget({ token, businessName }: { token: string; businessName: string }) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  return (
    <ChatDock title={`Live chat · ${businessName}`} badge={unread} open={open} onToggle={() => setOpen((o) => !o)} theme="light">
      <p className="mb-2 text-[11px] text-slate-500">Ask us anything about your quotation. Chat does not change your quotation or price; use the buttons on the page to approve or ask for changes.</p>
      <ChatBox endpoint={`/api/client/${encodeURIComponent(token)}/chat`} side="client" theme="light" visible={open} onUnread={setUnread} emptyText="No messages yet. Ask us anything." listClass="h-64" />
    </ChatDock>
  );
}

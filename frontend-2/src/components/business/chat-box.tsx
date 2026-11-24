"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";

import type { ChatMessage, ChatSide } from "@/lib/business/chat";
import { mergeMessages } from "@/lib/business/chat-merge";
import { cn } from "@/lib/utils";

const POLL_MS = 4000;
const MAX = 2000;

/**
 * The chat with the other side, for one project. It looks for new messages every few seconds while the page is open
 * (no extra service needed). When `visible` is false (another tab is showing) it only counts what is new and reports it
 * through `onUnread`, without marking anything as seen.
 */
export function ChatBox({
  endpoint,
  side,
  theme,
  visible = true,
  onUnread,
  placeholder = "Type your message...",
  emptyText = "No messages yet. Say hello!",
  listClass = "h-80 sm:h-96",
}: {
  endpoint: string;
  side: ChatSide;
  theme: "dark" | "light";
  visible?: boolean;
  onUnread?: (count: number) => void;
  placeholder?: string;
  emptyText?: string;
  /** Height of the message list. */
  listClass?: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const lastId = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const dark = theme === "dark";

  // Messages from the other side that arrived while this chat was not on screen.
  const unseen = useRef(0);

  const fetchNew = useCallback(async () => {
    try {
      const url = `${endpoint}?after=${lastId.current}${visible ? "" : "&peek=1"}`;
      const r = (await (await fetch(url, { cache: "no-store" })).json()) as { success?: boolean; messages?: ChatMessage[]; error?: string };
      if (!r.success || !r.messages) throw new Error(r.error || "Could not load the chat.");
      if (r.messages.length) {
        lastId.current = Math.max(lastId.current, ...r.messages.map((m) => m.id));
        setMessages((have) => mergeMessages(have, r.messages!));
        if (!visible) {
          unseen.current += r.messages.filter((m) => m.sender !== side && !m.read).length;
          onUnread?.(unseen.current);
        }
      }
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [endpoint, visible, onUnread, side]);

  // Coming back to the chat: everything is seen, and the server is told by the normal (non-peek) read.
  useEffect(() => {
    if (!visible) return;
    unseen.current = 0;
    onUnread?.(0);
    void fetchNew();
  }, [visible, onUnread, fetchNew]);

  useEffect(() => {
    fetchNew();
    const timer = setInterval(() => { if (!document.hidden) fetchNew(); }, POLL_MS);
    const wake = () => { if (!document.hidden) fetchNew(); };
    document.addEventListener("visibilitychange", wake);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", wake); };
  }, [fetchNew]);

  // Keep the newest message in view, unless the reader scrolled up to read.
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, visible]);

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      const r = (await (await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: value }) })).json()) as { success?: boolean; message?: ChatMessage; error?: string };
      if (!r.success || !r.message) throw new Error(r.error || "Could not send. Please try again.");
      lastId.current = Math.max(lastId.current, r.message.id);
      setMessages((have) => mergeMessages(have, [r.message!]));
      stick.current = true;
      setText("");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  let lastDay = "";
  return (
    <div className="flex flex-col" data-testid="chat-box">
      <div
        ref={list}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
        className={cn("space-y-2 overflow-y-auto rounded-xl border p-3", listClass, dark ? "border-white/[.07] bg-white/[.02]" : "border-slate-200 bg-slate-50")}
        role="log"
        aria-live="polite"
        aria-label="Messages"
      >
        {!loaded && <p className="flex items-center gap-2 text-xs text-slate-500"><Loader2 size={13} className="animate-spin" /> Loading...</p>}
        {loaded && messages.length === 0 && <p className={cn("py-10 text-center text-xs", dark ? "text-slate-500" : "text-slate-400")} data-testid="chat-empty">{emptyText}</p>}
        {messages.map((m) => {
          const mine = m.sender === side;
          const day = new Date(m.at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
          const header = day !== lastDay;
          lastDay = day;
          return (
            <div key={m.id}>
              {header && <p className={cn("my-2 text-center text-[10px] uppercase tracking-wider", dark ? "text-slate-600" : "text-slate-400")}>{day}</p>}
              <div className={cn("flex", mine ? "justify-end" : "justify-start")} data-testid={mine ? "chat-mine" : "chat-theirs"}>
                <div
                  className={cn(
                    "max-w-[85%] rounded-2xl px-3 py-2 text-sm",
                    mine ? "rounded-br-sm bg-violet-600 text-white" : dark ? "rounded-bl-sm bg-white/10 text-slate-100" : "rounded-bl-sm border border-slate-200 bg-white text-slate-800",
                  )}
                >
                  {!mine && m.name && <p className={cn("mb-0.5 text-[10px] font-semibold", dark ? "text-violet-300" : "text-violet-600")}>{m.name}</p>}
                  <p className="whitespace-pre-wrap break-words">{m.text}</p>
                  <p className={cn("mt-1 text-right text-[10px]", mine ? "text-violet-200" : dark ? "text-slate-500" : "text-slate-400")}>
                    {new Date(m.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                    {mine && m.read && " · seen"}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {error && <p className={cn("mt-2 rounded-md px-2.5 py-1.5 text-xs", dark ? "border border-rose-400/20 bg-rose-500/10 text-rose-200" : "bg-rose-50 text-rose-700")} role="alert">{error}</p>}

      <form
        className="mt-2 flex items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); void send(); }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          maxLength={MAX}
          rows={2}
          placeholder={placeholder}
          aria-label="Your message"
          className={cn("min-w-0 flex-1 resize-none rounded-lg border px-3 py-2 text-sm outline-none focus:border-violet-500", dark ? "border-white/10 bg-white/[.03] text-slate-100 placeholder:text-slate-600" : "border-slate-300 bg-white text-slate-900")}
        />
        <button
          type="submit"
          disabled={sending || !text.trim()}
          aria-label="Send message"
          className="flex h-10 items-center gap-1.5 rounded-lg bg-violet-600 px-4 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Send
        </button>
      </form>
      <p className={cn("mt-1 text-[10px]", dark ? "text-slate-600" : "text-slate-400")}>Enter sends, Shift+Enter adds a new line.</p>
    </div>
  );
}

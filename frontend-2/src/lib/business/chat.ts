import { getDb } from "./db";
import { ValidationError } from "./validate";

/**
 * The chat between a client (on their private quotation link) and the team. Messages belong to one project and are kept for good.
 * It never changes a quotation: prices and approvals only change through their own, checked steps.
 */

export type ChatSide = "client" | "team";

export type ChatMessage = { id: number; sender: ChatSide; name: string; text: string; at: string; read: boolean };

export const CHAT_MAX_LENGTH = 2000;

type Row = { id: number; sender: string; name: string; text: string; at: string; read: number };

const toMessage = (r: Row): ChatMessage => ({ id: r.id, sender: r.sender === "team" ? "team" : "client", name: r.name, text: r.text, at: r.at, read: r.read === 1 });

/** Cleans what someone typed: no control characters, tidy line breaks, and between 1 and 2000 characters. */
export function cleanChatText(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("Type a message first.");
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new ValidationError("Type a message first.");
  if (text.length > CHAT_MAX_LENGTH) throw new ValidationError(`A message can be up to ${CHAT_MAX_LENGTH} characters.`);
  return text;
}

export function addChatMessage(leadId: string, sender: ChatSide, name: string, value: unknown): ChatMessage {
  const text = cleanChatText(value);
  const at = new Date().toISOString();
  const label = name.trim().slice(0, 120);
  const result = getDb().prepare("INSERT INTO chat_messages (lead_id, sender, name, text, at, read) VALUES (?, ?, ?, ?, ?, 0)").run(leadId, sender, label, text, at);
  return { id: Number(result.lastInsertRowid), sender, name: label, text, at, read: false };
}

/**
 * The messages of a project, oldest first. Pass `after` (the id of the last message already shown) to get only the new ones.
 * Reading as one side marks the other side's messages as seen, unless `markSeen` is false (a quiet look to count what is new).
 */
export function readChat(leadId: string, viewer: ChatSide, after = 0, markSeen = true): ChatMessage[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM chat_messages WHERE lead_id = ? AND id > ? ORDER BY id LIMIT 500").all(leadId, Math.max(0, Math.floor(after) || 0)) as Row[];
  const other: ChatSide = viewer === "team" ? "client" : "team";
  // Even with nothing new to show, opening the chat marks what arrived while it was closed.
  if (markSeen) db.prepare("UPDATE chat_messages SET read = 1 WHERE lead_id = ? AND sender = ? AND read = 0").run(leadId, other);
  return rows.map(toMessage).map((m) => (markSeen && m.sender === other ? { ...m, read: true } : m));
}

/** How many messages from the client the team has not seen yet. */
export function unreadFromClient(leadId: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE lead_id = ? AND sender = 'client' AND read = 0").get(leadId) as { n: number }).n;
}

/** Messages the team sent that the client has not seen yet. */
export function unreadFromTeam(leadId: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE lead_id = ? AND sender = 'team' AND read = 0").get(leadId) as { n: number }).n;
}

/** Unread client messages for every project at once (for the lists), keyed by project id. */
export function unreadByLead(): Record<string, number> {
  const rows = getDb().prepare("SELECT lead_id, COUNT(*) AS n FROM chat_messages WHERE sender = 'client' AND read = 0 GROUP BY lead_id").all() as { lead_id: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.lead_id, r.n]));
}

export type Conversation = { leadId: string; client: string; title: string; lastText: string; lastSender: ChatSide | null; lastAt: string; unread: number };

/** Every project the team can chat about (it has a client link or messages): newest talk first, with what is unread. */
export function conversations(): Conversation[] {
  const db = getDb();
  const leads = db.prepare("SELECT id, client, requirement, updated_at FROM leads WHERE share_token IS NOT NULL OR id IN (SELECT lead_id FROM chat_messages)").all() as { id: string; client: string; requirement: string; updated_at: string }[];
  const last = new Map((db.prepare("SELECT m.lead_id, m.sender, m.text, m.at FROM chat_messages m JOIN (SELECT lead_id, MAX(id) AS mid FROM chat_messages GROUP BY lead_id) x ON m.id = x.mid").all() as { lead_id: string; sender: string; text: string; at: string }[]).map((r) => [r.lead_id, r]));
  const unread = unreadByLead();
  const parse = (json: string): Record<string, unknown> => { try { return JSON.parse(json) as Record<string, unknown>; } catch { return {}; } };
  return leads
    .map((l) => {
      const c = parse(l.client);
      const m = last.get(l.id);
      return {
        leadId: l.id,
        client: String(c.company || c.name || "Client"),
        title: String(parse(l.requirement).title ?? ""),
        lastText: m?.text.slice(0, 120) ?? "",
        lastSender: m ? (m.sender === "team" ? "team" : "client") : null,
        lastAt: m?.at ?? l.updated_at,
        unread: unread[l.id] ?? 0,
      } as Conversation;
    })
    .sort((a, b) => (a.lastText ? 0 : 1) - (b.lastText ? 0 : 1) || b.lastAt.localeCompare(a.lastAt));
}

import type { ChatMessage } from "./chat";

/** Adds new messages to the list, once each, in order. Returns the same list when there is nothing new. */
export function mergeMessages(have: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return have;
  const byId = new Map(have.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

import { conversations } from "@/lib/business/chat";
import { handle } from "@/lib/business/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/business/chat - every conversation with a client, newest first, and how many messages are unread in all. */
export async function GET() {
  return handle("CHAT LIST", () => {
    const list = conversations();
    return { conversations: list, unread: list.reduce((n, c) => n + c.unread, 0) };
  });
}

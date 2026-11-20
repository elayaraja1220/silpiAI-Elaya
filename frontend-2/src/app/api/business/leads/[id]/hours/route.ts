import { NextRequest } from "next/server";

import { handle, notFound } from "@/lib/business/http";
import { addWorkEntry, deleteWorkEntry, getLead, stageHistory } from "@/lib/business/store";
import { ValidationError } from "@/lib/business/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** POST /api/business/leads/:id/hours - { item, hours, note?, loggedOn }: log time actually spent. */
export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("HOURS ADD", async () => {
    const b = (await request.json()) as Record<string, unknown>;
    const hours = Math.round(Number(b.hours) * 4) / 4;
    const loggedOn = typeof b.loggedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.loggedOn) ? b.loggedOn : "";
    const item = typeof b.item === "string" ? b.item.trim().slice(0, 160) : "";
    const note = typeof b.note === "string" ? b.note.trim().slice(0, 200) : "";
    if (!Number.isFinite(hours) || hours <= 0 || hours > 100) throw new ValidationError("Enter the hours worked (up to 100 at a time).");
    if (!loggedOn || new Date(loggedOn).getTime() > Date.now() + 86_400_000) throw new ValidationError("Enter the date you worked.");
    if (!item) throw new ValidationError("Choose what the time was spent on.");
    return { lead: addWorkEntry(id, { item, hours, note, loggedOn }), history: stageHistory(id) };
  });
}

/** DELETE /api/business/leads/:id/hours?entry=... - remove a wrong entry. */
export async function DELETE(request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!getLead(id)) return notFound();
  return handle("HOURS DELETE", () => {
    const entry = request.nextUrl.searchParams.get("entry") ?? "";
    return { lead: deleteWorkEntry(id, entry), history: stageHistory(id) };
  });
}

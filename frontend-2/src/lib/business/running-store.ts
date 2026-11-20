import { getDb } from "./db";
import { parseRunningServices, publicRunningServices, type PublicRunningServices, type RunningService } from "./running-services";

/** Server only. The admin's running-service arrangements for a lead. No row = nothing configured (the safe default). */
export function getRunningServices(leadId: string): RunningService[] | null {
  const row = getDb().prepare("SELECT data FROM running_services WHERE lead_id = ?").get(leadId) as { data: string } | undefined;
  if (!row) return null;
  try {
    // Re-validated on the way out: a damaged or hand-edited row never reaches a screen or a client.
    return parseRunningServices(JSON.parse(row.data));
  } catch {
    return null;
  }
}

export function saveRunningServices(leadId: string, items: RunningService[]): RunningService[] {
  getDb()
    .prepare("INSERT INTO running_services (lead_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(lead_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
    .run(leadId, JSON.stringify(items), new Date().toISOString());
  return items;
}

/** What the client may see for this lead, or null. The only route from the stored data to a public response. */
export function publicRunningFor(leadId: string): PublicRunningServices | null {
  return publicRunningServices(getRunningServices(leadId));
}

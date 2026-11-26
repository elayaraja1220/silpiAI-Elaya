// Which development model a client chose (server only). A record, never a setting: choosing again adds a row.
import { getDb } from "@/lib/business/db";

export type DevelopmentModel = "fixed_price" | "saas";

export function recordModelChoice(session: { user: { id: string }; orgId: string }, model: DevelopmentModel): void {
  getDb().prepare("INSERT INTO model_selections (user_id, org_id, model, chosen_at) VALUES (?, ?, ?, ?)").run(session.user.id, session.orgId, model, new Date().toISOString());
}

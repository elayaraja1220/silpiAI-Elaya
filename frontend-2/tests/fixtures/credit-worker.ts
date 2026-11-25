// A separate process that tries to reserve credits from the same database file. Used by credits.test.ts to prove the
// lock works ACROSS processes, not just inside one. Prints how many reservations it got.
import { reserveCredits } from "@/server/credits";

const [orgId, unitsText, attemptsText, tag] = process.argv.slice(2);
let won = 0;
for (let i = 0; i < Number(attemptsText); i++) {
  try {
    reserveCredits({ orgId, units: Number(unitsText), idempotencyKey: `${tag}-attempt-${i}` });
    won++;
  } catch (error) {
    if ((error as { code?: string }).code !== "insufficient") throw error;
  }
}
console.log(`WON:${won}`);

/** Renewals, past-due handling and credit expiry run on a timer (in production by default). See src/server/billing-cycle.ts. */
export async function startBillingTimer(): Promise<void> {
  try {
    const { startBillingScheduler } = await import("@/server/billing-cycle");
    startBillingScheduler();
  } catch (error) {
    console.error("SILPI billing timer was not started:", (error as Error).message);
  }
}

/** A restart must not end a client's demo: if demos are live, the gateway comes back with the server. */
export async function startDemoGatewayIfNeeded(): Promise<void> {
  try {
    const { ensureGatewayIfNeeded } = await import("@/lib/demo/gateway");
    await ensureGatewayIfNeeded();
  } catch (error) {
    console.error("SILPI demo gateway was not started:", (error as Error).message);
  }
}

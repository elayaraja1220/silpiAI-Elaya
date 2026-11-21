/** A restart must not end a client's demo: if demos are live, the gateway comes back with the server. */
export async function startDemoGatewayIfNeeded(): Promise<void> {
  try {
    const { ensureGatewayIfNeeded } = await import("@/lib/demo/gateway");
    await ensureGatewayIfNeeded();
  } catch (error) {
    console.error("SILPI demo gateway was not started:", (error as Error).message);
  }
}

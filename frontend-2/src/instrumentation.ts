/** Runs once when the server starts. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startDemoGatewayIfNeeded, startBillingTimer } = await import("./instrumentation-node");
    await startDemoGatewayIfNeeded();
    await startBillingTimer();
  }
}

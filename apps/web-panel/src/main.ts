/**
 * @sbr/app-web-panel entrypoint — starts the OAuth + JSON API server over the
 * panel composition. Set PANEL_DRAIN_MS to auto-stop after N ms (verification).
 */
import { createPanelApp } from "./composition.js";
import { startPanelServer } from "./server.js";

async function main(): Promise<void> {
  const app = createPanelApp();
  const server = await startPanelServer(app);
  app.log.info("web-panel listening", { port: app.config.web.port });

  const shutdown = async (): Promise<void> => {
    app.log.info("web-panel shutting down");
    await server.close();
    await app.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const drainMs = Number(process.env.PANEL_DRAIN_MS ?? 0);
  if (drainMs > 0) setTimeout(() => void shutdown(), drainMs);
}

main().catch((error: unknown) => {
  process.stderr.write(`web-panel failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});

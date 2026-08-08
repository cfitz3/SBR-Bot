/**
 * @sbr/app-web-panel entrypoint — starts the OAuth + JSON API server over the
 * panel composition. Set PANEL_DRAIN_MS to auto-stop after N ms (verification).
 */
import { installLifecycle } from "@sbr/observability";
import { closeRedis } from "@sbr/redis";
import { createPanelApp } from "./composition.js";
import { startPanelServer } from "./server.js";

async function main(): Promise<void> {
  const app = await createPanelApp();
  const server = await startPanelServer(app);
  app.log.info("web-panel listening", { port: app.config.web.port });

  installLifecycle({
    logger: app.log,
    drainMs: Number(process.env.PANEL_DRAIN_MS ?? 0),
    async shutdown() {
      await server.close();
      await app.shutdown();
      // The panel opens Redis for sessions but never closed it, so the process
      // relied on exit() to reap the socket rather than quitting cleanly.
      await closeRedis();
    },
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`web-panel failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});

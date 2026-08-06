/**
 * @sbr/app-admin-bot entrypoint. Composes the staff dispatcher and, when a token
 * is present, starts the discord.js gateway (registers slash commands + routes
 * interactions to dispatch). Without a token it boots the composition and exits
 * (boot-ready) so it can be verified without credentials.
 */
import { createAdminApp } from "./composition.js";
import { startAdminGateway } from "./transport.js";

async function main(): Promise<void> {
  const app = await createAdminApp();
  const token = app.config.discord.adminToken;

  if (!token) {
    app.log.warn("DISCORD_ADMIN_TOKEN not set — composed but gateway not started");
    await app.shutdown();
    process.exit(0);
  }

  const client = await startAdminGateway(app, token, app.config.discord.clientId);
  app.log.info("admin-bot serving");

  const shutdown = async (): Promise<void> => {
    await client.destroy();
    await app.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`admin-bot failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});

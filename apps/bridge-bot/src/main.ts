/**
 * @sbr/app-bridge-bot entrypoint. Composes the member dispatcher + relay
 * pipeline; with a Discord token it starts the gateway (and, with MC creds, the
 * Mineflayer connector). Without a token it boots the composition and exits
 * (boot-ready) so it can be verified without credentials.
 */
import { installLifecycle } from "@sbr/observability";
import { createBridgeApp } from "./composition.js";
import { startBridge } from "./transport.js";

async function main(): Promise<void> {
  const app = await createBridgeApp();
  const token = app.config.discord.bridgeToken;

  if (!token) {
    app.log.warn("DISCORD_BRIDGE_TOKEN not set — composed but gateway not started");
    await app.shutdown();
    process.exit(0);
  }

  const mc = app.config.minecraft.username
    ? {
        host: app.config.minecraft.host,
        port: app.config.minecraft.port,
        username: app.config.minecraft.username,
        version: app.config.minecraft.version,
      }
    : null;
  if (!mc) app.log.warn("MC_USERNAME not set — Discord side only, no in-game bridge");

  const handles = await startBridge(app, {
    discordToken: token,
    discordGuildId: process.env.DISCORD_GUILD_ID,
    mc,
  });
  // Only meaningful with an in-game session; without one `/online` should keep
  // saying "no bridge here" rather than waiting out a request that can't be sent.
  if (mc) app.setRosterSource(handles.roster);
  app.setStatusSource(() => ({ ...handles.status() }));
  app.log.info("bridge-bot serving");

  installLifecycle({
    logger: app.log,
    async shutdown() {
      await handles.destroy();
      await app.shutdown();
    },
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`bridge-bot failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});

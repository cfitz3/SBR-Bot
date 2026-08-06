/**
 * @sbr/app-bridge-bot entrypoint. Composes the member dispatcher + relay
 * pipeline; with a Discord token it starts the gateway (and, with MC creds, the
 * Mineflayer connector). Without a token it boots the composition and exits
 * (boot-ready) so it can be verified without credentials.
 */
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
    ? { host: app.config.minecraft.host, port: app.config.minecraft.port, username: app.config.minecraft.username }
    : null;
  if (!mc) app.log.warn("MC_USERNAME not set — Discord side only, no in-game bridge");

  const handles = await startBridge(app, {
    discordToken: token,
    clientId: app.config.discord.clientId,
    discordGuildId: process.env.DISCORD_GUILD_ID,
    bridgeChannelId: process.env.BRIDGE_CHANNEL_ID,
    mc,
  });
  app.log.info("bridge-bot serving");

  const shutdown = async (): Promise<void> => {
    await handles.destroy();
    await app.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`bridge-bot failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});

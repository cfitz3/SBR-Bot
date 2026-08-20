/**
 * @sbr/app-bridge-bot entrypoint. Composes the member dispatcher + relay
 * pipeline; with a Discord token it starts the gateway (and, with MC creds, the
 * Mineflayer connector). Without a token it boots the composition and exits
 * (boot-ready) so it can be verified without credentials.
 */
import { installLifecycle } from "@sbr/observability";
import { guildRepository } from "@sbr/db";
import { createBridgeApp } from "./composition.js";
import { BridgeApi } from "./internal-api.js";
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

  // The ticket control API. Started here rather than inside `startBridge`
  // because it is the panel's and the admin bot's way in, and it should exist
  // whether or not there is a Mineflayer session behind it. The gateway is read
  // per request: it is built during `startBridge`, and a request arriving in
  // that window answers "still connecting" instead of failing.
  const bridgeApi = app.config.internalApi.token
    ? new BridgeApi({
        tickets: () => app.tickets,
        eventBoard: () => app.eventBoard,
        roleMenus: () => app.roleMenus,
        toDiscordGuildId: guildRepository.resolveDiscordId,
        token: app.config.internalApi.token,
        port: app.config.internalApi.bridgePort,
        logger: app.log,
      })
    : null;
  if (bridgeApi) {
    await bridgeApi.start();
  } else {
    app.log.warn("INTERNAL_API_TOKEN not set — panel ticket publishing and /tickets close are unavailable");
  }

  app.log.info("bridge-bot serving");

  installLifecycle({
    logger: app.log,
    async shutdown() {
      await bridgeApi?.stop();
      await handles.destroy();
      await app.shutdown();
    },
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`bridge-bot failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});

/**
 * @sbr/app-admin-bot entrypoint. Composes the staff dispatcher and, when a token
 * is present, starts the discord.js gateway (registers slash commands + routes
 * interactions to dispatch). Without a token it boots the composition and exits
 * (boot-ready) so it can be verified without credentials.
 */
import { installLifecycle } from "@sbr/observability";
import { guildRepository } from "@sbr/db";
import { containerMessage } from "@sbr/discord-kit";
import type { EmbedView } from "@sbr/shared-types";
import { createAdminApp } from "./composition.js";
import { startInternalApi } from "./internal-api.js";
import { startPunishmentSweep } from "./punishment-sweep.js";
import { startSafetySweep } from "./safety-sweep.js";
import { startAdminGateway } from "./transport.js";
import { startWatchtower } from "./watchtower.js";

async function main(): Promise<void> {
  const app = await createAdminApp();
  const token = app.config.discord.adminToken;

  if (!token) {
    app.log.warn("DISCORD_ADMIN_TOKEN not set — composed but gateway not started");
    await app.shutdown();
    process.exit(0);
  }

  const { client } = await startAdminGateway(app, token, process.env.DISCORD_GUILD_ID);
  // Started only once the gateway is up: an expired lockdown can't be lifted
  // without a client, and a sweep that "succeeded" without unlocking anything
  // would leave the record cleared and the channels shut.
  const stopSweep = startSafetySweep({ lock: app.lock, sweep: app.sweepSafety, logger: app.log });
  // Same reasoning: lifting an expired ban is a gateway call, so it waits for
  // one. Without this loop a temp ban is a permanent ban with a tidy audit row.
  const stopPunishmentSweep = startPunishmentSweep({
    lock: app.lock,
    sweep: app.sweepPunishments,
    logger: app.log,
  });
  app.setStatusSource(() => {
    // discord.js reports -1 until the first gateway heartbeat lands; forwarding
    // that verbatim would render as a negative latency on the Health page.
    const ping = client.ws.ping;
    return {
      discordReady: client.isReady(),
      gatewayPingMs: Number.isFinite(ping) && ping >= 0 ? Math.round(ping) : null,
    };
  });
  // Started after ready for the same reason as the sweep: the API's whole job is
  // answering from the gateway cache, and a cache that hasn't filled yet would
  // report an empty server as though it really were empty.
  const internalApi = app.config.internalApi.token
    ? await startInternalApi({
        client,
        toDiscordGuildId: guildRepository.resolveDiscordId,
        token: app.config.internalApi.token,
        port: app.config.internalApi.port,
        logger: app.log,
      })
    : null;
  if (!internalApi) {
    app.log.warn("INTERNAL_API_TOKEN not set — the panel will fall back to raw-ID entry");
  }

  // The one way ops messages reach Discord. Deliberately plain text with every
  // mention parsed off: an alert that pings @everyone because a log line
  // happened to contain "@here" would be its own incident.
  const postOps = async (channelId: string, text: string): Promise<boolean> => {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return false;
    const sent = await channel
      .send({ content: text.slice(0, 2000), allowedMentions: { parse: [] } })
      .catch(() => null);
    return sent !== null;
  };
  app.setOpsPoster(postOps);

  // The moderation log. A card rather than a line, rendered through the same
  // container every other card in the platform goes through, so the house style
  // applies here too. Mentions are parsed off for a reason particular to this
  // channel: the card names the member it is about, and a mod log that pings
  // somebody every time they are warned is a mod log staff mute.
  const postModLog = async (channelId: string, embed: EmbedView): Promise<boolean> => {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return false;
    const sent = await channel
      .send({ ...containerMessage(embed), allowedMentions: { parse: [] } })
      .catch(() => null);
    return sent !== null;
  };
  app.setModLogPoster(postModLog);
  if (!app.config.ops.errorChannelId) {
    app.log.warn("OPS_ERROR_CHANNEL_ID not set — errors stay in the process log only");
  }

  // The watchtower reports on a fleet that includes this process, so it can only
  // speak to an outage it survives. That is the common case — a worker wedged, a
  // database unreachable, the panel gone — and the case it cannot cover (this bot
  // itself dead) is the one the *other* services' own beats would show.
  const watchtower = startWatchtower({
    listBeats: () => app.listBeats(),
    health: () => app.health.run(),
    channelId: () => app.config.ops.alertChannelId ?? null,
    post: postOps,
    log: app.log,
  });
  if (!app.config.ops.alertChannelId) {
    app.log.warn("OPS_ALERT_CHANNEL_ID not set — fleet alerts are computed but not posted");
  }

  app.log.info("admin-bot serving");

  installLifecycle({
    logger: app.log,
    async shutdown() {
      stopSweep();
      stopPunishmentSweep();
      watchtower.stop();
      await internalApi?.stop();
      // `app.shutdown()` flushes the last log batch, so the gateway has to stay
      // up until after it. Destroying the client first would drop exactly the
      // errors that explain why we are shutting down.
      await app.shutdown();
      await client.destroy();
    },
  });
}

/** Turn the opaque Discord API codes we can actually diagnose into advice. */
function explain(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 20012) {
    return "DISCORD_ADMIN_TOKEN does not belong to an application this bot may modify. Check that the token in .env is the admin bot's own token, copied from its Discord application.";
  }
  if (code === "TokenInvalid" || code === 401) {
    return "DISCORD_ADMIN_TOKEN was rejected by Discord. Regenerate it in the Discord developer portal and update .env.";
  }
  return undefined;
}

main().catch((error: unknown) => {
  process.stderr.write(`admin-bot failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  const hint = explain(error);
  if (hint) process.stderr.write(`admin-bot hint: ${hint}\n`);
  process.exit(1);
});

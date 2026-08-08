/**
 * @sbr/app-admin-bot entrypoint. Composes the staff dispatcher and, when a token
 * is present, starts the discord.js gateway (registers slash commands + routes
 * interactions to dispatch). Without a token it boots the composition and exits
 * (boot-ready) so it can be verified without credentials.
 */
import { installLifecycle } from "@sbr/observability";
import { createAdminApp } from "./composition.js";
import { startSafetySweep } from "./safety-sweep.js";
import { startAdminGateway } from "./transport.js";

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
  app.setStatusSource(() => {
    // discord.js reports -1 until the first gateway heartbeat lands; forwarding
    // that verbatim would render as a negative latency on the Health page.
    const ping = client.ws.ping;
    return {
      discordReady: client.isReady(),
      gatewayPingMs: Number.isFinite(ping) && ping >= 0 ? Math.round(ping) : null,
    };
  });
  app.log.info("admin-bot serving");

  installLifecycle({
    logger: app.log,
    async shutdown() {
      stopSweep();
      await client.destroy();
      await app.shutdown();
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

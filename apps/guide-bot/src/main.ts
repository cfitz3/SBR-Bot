/**
 * @sbr/app-guide-bot entrypoint — SBR-Guide, the progression advisor.
 *
 * Without a token it boots the composition and exits (boot-ready), so the wiring
 * can be verified without credentials. With one it will start the gateway; that
 * transport arrives with the command surface in a later slice, and until then
 * this says so rather than sitting on an idle gateway pretending to serve.
 */
import { installLifecycle } from "@sbr/observability";
import { createGuideApp } from "./composition.js";

async function main(): Promise<void> {
  const app = await createGuideApp();
  const token = app.config.discord.guideToken;

  if (!token) {
    app.log.warn("DISCORD_GUIDE_TOKEN not set — composed but gateway not started");
    await app.shutdown();
    process.exit(0);
  }

  app.log.warn("guide-bot composed; no command surface yet — nothing to serve, exiting");
  await app.shutdown();

  installLifecycle({
    logger: app.log,
    async shutdown() {
      await app.shutdown();
    },
  });
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`guide-bot failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});

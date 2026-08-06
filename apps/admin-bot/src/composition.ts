/**
 * Admin-bot composition root — wires the staff command dispatcher to the shared
 * moderation core over the real Prisma repo + Redis enforcement mirror. The
 * discord.js command adapter is the remaining runtime piece (needs a token +
 * the real bot-permission check to replace the BotCapabilities stub).
 */
import { loadConfig, type AppConfig } from "@sbr/config";
import { disconnectDb, guildRepository, moderationRepository, rankResolver } from "@sbr/db";
import { ModerationServiceImpl } from "@sbr/moderation";
import { AdminDispatcher, buildAdminRegistry } from "@sbr/commands-admin";
import { createLogger, type Logger } from "@sbr/observability";
import { closeRedis, createRedisAdapters, getRedis } from "@sbr/redis";

export interface AdminApp {
  readonly config: AppConfig;
  readonly log: Logger;
  readonly dispatcher: AdminDispatcher;
  resolveGuild(discordGuildId: string): Promise<string | null>;
  shutdown(): Promise<void>;
}

export async function createAdminApp(): Promise<AdminApp> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, name: "admin-bot" });
  const redis = await getRedis();
  const adapters = createRedisAdapters(redis);

  const moderation = new ModerationServiceImpl({
    repo: moderationRepository,
    ranks: rankResolver,
    enforcement: adapters.enforcement,
    // Until the discord.js permission check exists, assume the bot can enforce.
    botCaps: { async canPerform() { return true; } },
    logger: log,
  });

  const dispatcher = new AdminDispatcher({
    registry: buildAdminRegistry(),
    roles: rankResolver,
    handlerDeps: { moderation, logger: log },
    logger: log,
  });

  return {
    config,
    log,
    dispatcher,
    resolveGuild: guildRepository.resolveInternalId,
    async shutdown() {
      await Promise.allSettled([closeRedis(), disconnectDb()]);
    },
  };
}

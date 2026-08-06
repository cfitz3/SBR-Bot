/**
 * Web-panel composition root — wires PanelService to the shared services over
 * the real Prisma repos. The Next.js routes + Discord OAuth callback are the
 * remaining runtime piece; they call these methods with a resolved PanelSession.
 */
import { loadConfig, type AppConfig } from "@sbr/config";
import { communityRepository, disconnectDb, guildRepository, moderationRepository, rankResolver } from "@sbr/db";
import { CommunityServiceImpl } from "@sbr/community";
import { ModerationServiceImpl } from "@sbr/moderation";
import { PanelService } from "@sbr/panel-core";
import { createLogger, type Logger } from "@sbr/observability";

export interface PanelApp {
  readonly config: AppConfig;
  readonly log: Logger;
  readonly panel: PanelService;
  resolveGuild(discordGuildId: string): Promise<string | null>;
  shutdown(): Promise<void>;
}

export function createPanelApp(): PanelApp {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, name: "web-panel" });

  const community = new CommunityServiceImpl({ repo: communityRepository, logger: log });
  const moderation = new ModerationServiceImpl({
    repo: moderationRepository,
    ranks: rankResolver,
    // Panel enforcement/permission collaborators are only needed for write paths;
    // the read view models below don't invoke applyAction.
    enforcement: { async apply() {} },
    botCaps: { async canPerform() { return true; } },
    logger: log,
  });

  const panel = new PanelService({ roles: rankResolver, community, moderation, logger: log });

  return {
    config,
    log,
    panel,
    resolveGuild: guildRepository.resolveInternalId,
    async shutdown() {
      await disconnectDb();
    },
  };
}

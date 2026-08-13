/**
 * Admin-bot composition root — wires the staff command dispatcher to the shared
 * moderation core over the real Prisma repo + Redis enforcement mirror. The
 * discord.js command adapter is the remaining runtime piece (needs a token +
 * the real bot-permission check to replace the BotCapabilities stub).
 */
import { loadConfig, type AppConfig } from "@sbr/config";
import {
  communityRepository,
  assertDatabaseReady,
  disconnectDb,
  guildConfigRepository,
  guildRepository,
  identityRepository,
  moderationRepository,
  rankResolver,
  rolePolicyReader,
  wordlistRepository,
} from "@sbr/db";
import {
  ESCALATION_SETTING_KEY,
  ModerationServiceImpl,
  RELAY_SYNC_SETTING_KEY,
  SafetyServiceImpl,
  WordlistServiceImpl,
} from "@sbr/moderation";
import { IdentityServiceImpl } from "@sbr/identity";
import { HypixelClient } from "@sbr/hypixel";
import { CommunityServiceImpl } from "@sbr/community";
import { GuildConfigServiceImpl } from "@sbr/guild-config";
import { AnalyticsServiceImpl, createDomainMetrics } from "@sbr/analytics";
import { AdminDispatcher, buildAdminRegistry } from "@sbr/commands-admin";
import { createLogger, type Logger } from "@sbr/observability";
import { closeRedis, createRedisAdapters, getRedis, startHeartbeat } from "@sbr/redis";
import { randomUUID } from "node:crypto";
import { DiscordGuildEffects } from "./effects.js";

/** Per-boot identity in the heartbeat keyspace; see the panel's copy for why. */
const INSTANCE_ID = randomUUID().slice(0, 8);

export interface AdminApp {
  readonly config: AppConfig;
  readonly log: Logger;
  readonly dispatcher: AdminDispatcher;
  /**
   * Handed the gateway client once it is ready, so `/kick`, `/purge` and
   * `/lockdown` can reach Discord. Until then those effects fail cleanly.
   */
  readonly effects: DiscordGuildEffects;
  /** Lifts every lockdown or anti-raid posture whose `expiresAt` has passed. */
  sweepSafety(): Promise<number>;
  /** Redis lock, so a second admin-bot instance doesn't double-run the sweep. */
  readonly lock: ReturnType<typeof createRedisAdapters>["lock"];
  resolveGuild(discordGuildId: string): Promise<string | null>;
  /**
   * Late-bound live gateway state for the heartbeat, set once the transport
   * exists. Unset simply means "up, not connected yet", which is what the
   * Health page should show during a slow start.
   */
  setStatusSource(source: (() => AdminStatusDetails) | null): void;
  shutdown(): Promise<void>;
}

/** Whatever the transport can say about itself; forwarded verbatim to Redis. */
export type AdminStatusDetails = Readonly<Record<string, string | number | boolean | null>>;

export async function createAdminApp(): Promise<AdminApp> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, name: "admin-bot" });

  // Prisma connects lazily, so a wrong or absent Postgres would otherwise only
  // show up later as an endless drip of failing queries. Check once, up front.
  await assertDatabaseReady();
  const redis = await getRedis();
  const adapters = createRedisAdapters(redis);

  // Built before the gateway exists; `attach()` supplies the client at ready.
  const effects = new DiscordGuildEffects({
    toDiscordGuildId: guildRepository.resolveDiscordId,
    logger: log,
  });

  // Constructed before the services that feed it, so every emitter can be
  // handed the same buffer rather than a second one.
  const analytics = new AnalyticsServiceImpl({ buffer: adapters.analyticsBuffer, logger: log });
  const metrics = createDomainMetrics({ analytics, surface: "ADMIN_BOT", logger: log });

  const moderation = new ModerationServiceImpl({
    repo: moderationRepository,
    ranks: rankResolver,
    enforcement: adapters.enforcement,
    metrics,
    // Until the discord.js permission check exists, assume the bot can enforce.
    botCaps: { async canPerform() { return true; } },
    // Warnings escalate on a ladder the guild can edit; the policy lives in the
    // settings KV, read fresh on each warning so an edit takes effect on the
    // next one rather than at the next restart.
    escalation: { readPolicy: (guildId) => guildConfigRepository.getSetting(guildId, ESCALATION_SETTING_KEY) },
    // Punishment sync into guild chat. The command is published, not typed:
    // only the bridge process holds a Minecraft session, and only it knows how
    // fast Hypixel will let that account speak.
    gameCommands: { send: (guildId, command) => adapters.modBus.publish({ guildId, kind: "GAME_COMMAND", command, correlationId: randomUUID() }) },
    igns: {
      async ignFor(_guildId, discordId) {
        // Guild-agnostic on purpose: a link is to a person, not to a server, and
        // the same account carries across every guild on the platform.
        const link = await identityRepository.findPrimaryLinkByDiscordId(discordId).catch(() => null);
        return link?.ign ?? null;
      },
    },
    relaySync: { readRelaySync: (guildId) => guildConfigRepository.getSetting(guildId, RELAY_SYNC_SETTING_KEY) },
    logger: log,
  });

  // Staff commands reach beyond moderation — `/set-channel` and `/feature-toggle`
  // write guild config, `/accept-member` touches community, and every invocation
  // is captured for the audit surface.
  const hypixel = new HypixelClient({
    ...(config.hypixel.apiKey ? { apiKey: config.hypixel.apiKey } : {}),
    cache: adapters.hypixelCache,
    rateGate: adapters.rateGate,
    logger: log,
  });
  const identity = new IdentityServiceImpl({
    repo: identityRepository,
    social: hypixel,
    roles: rankResolver,
    // Capability floors are the guild's to set on the panel; without this the
    // service falls back to its own compiled-in defaults.
    floors: rolePolicyReader,
    logger: log,
  });
  const community = new CommunityServiceImpl({ repo: communityRepository, logger: log });
  // Publishes so a `/set-channel` here reaches the bridge and the panel, and
  // subscribes (below) so their writes reach this process.
  const guildConfig = new GuildConfigServiceImpl({
    repo: guildConfigRepository,
    broadcast: adapters.configBus,
    logger: log,
  });
  const safety = new SafetyServiceImpl({ store: adapters.safety, effects, logger: log });
  const wordlist = new WordlistServiceImpl({ repo: wordlistRepository, logger: log });

  const dispatcher = new AdminDispatcher({
    registry: buildAdminRegistry(),
    roles: rankResolver,
    policies: rolePolicyReader,
    handlerDeps: {
      moderation,
      identity,
      community,
      config: guildConfig,
      safety,
      wordlist,
      effects,
      analytics,
      logger: log,
    },
    logger: log,
  });

  const unsubscribe = await adapters.configBus.subscribe((guildId) => {
    guildConfig.invalidate(guildId);
    log.debug("guild config invalidated by broadcast", { guildId });
  });

  let liveStatus: (() => AdminStatusDetails) | null = null;
  const stopHeartbeat = startHeartbeat(adapters.heartbeat, () => ({
    service: "admin-bot",
    instance: INSTANCE_ID,
    details: liveStatus?.() ?? { connected: false },
  }));

  return {
    config,
    log,
    dispatcher,
    effects,
    sweepSafety: () => safety.sweepExpired(),
    lock: adapters.lock,
    resolveGuild: guildRepository.resolveInternalId,
    setStatusSource(source) {
      liveStatus = source;
    },
    async shutdown() {
      stopHeartbeat();
      await unsubscribe().catch(() => undefined);
      await Promise.allSettled([closeRedis(), disconnectDb()]);
    },
  };
}

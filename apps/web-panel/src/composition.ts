/**
 * Web-panel composition root — wires PanelService (reads) and PanelMutations
 * (writes) to the shared services over the real Prisma repos and Redis adapters.
 * `server.ts` calls these with a PanelSession resolved from the Redis-backed
 * session cookie, and serves the browser UI that reads them.
 */
import { loadConfig, type AppConfig } from "@sbr/config";
import {
  communityRepository,
  assertDatabaseReady,
  disconnectDb,
  guildConfigRepository,
  guildRepository,
  identityRepository,
  milestoneDefinitionRepository,
  ticketConfigRepository,
  moderationRepository,
  panelRepository,
  rankResolver,
  wordlistRepository,
  activitySink,
  xpRepository,
} from "@sbr/db";
import { AnalyticsServiceImpl } from "@sbr/analytics";
import { CommunityServiceImpl } from "@sbr/community";
import { GuildConfigServiceImpl } from "@sbr/guild-config";
import { HypixelClient } from "@sbr/hypixel";
import { IdentityServiceImpl } from "@sbr/identity";
import { ESCALATION_SETTING_KEY, ModerationServiceImpl, WordlistServiceImpl } from "@sbr/moderation";
import { PanelMutations, PanelService, type ConfigAuditSink } from "@sbr/panel-core";
import { XpService } from "@sbr/xp";
import { createLogger, type Logger } from "@sbr/observability";
import { createRedisAdapters, getRedis, startHeartbeat } from "@sbr/redis";
import { randomUUID } from "node:crypto";

/**
 * This process's identity in the heartbeat keyspace.
 *
 * A random id per boot rather than a hostname: two panels behind a load balancer
 * on the same host would otherwise overwrite each other's key, and the Health
 * page would report one replica while two were serving.
 */
const INSTANCE_ID = randomUUID().slice(0, 8);

export interface PanelApp {
  readonly config: AppConfig;
  readonly log: Logger;
  readonly panel: PanelService;
  readonly mutations: PanelMutations;
  resolveGuild(discordGuildId: string): Promise<string | null>;
  shutdown(): Promise<void>;
}

/**
 * Async now that writes exist: the enforcement mirror, the rate limiter and the
 * analytics buffer are all Redis-backed, and a panel that mutated config without
 * them would leave the bots enforcing a stale picture.
 */
export async function createPanelApp(): Promise<PanelApp> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, name: "web-panel" });

  // Prisma connects lazily, so a wrong or absent Postgres would otherwise only
  // show up later as an endless drip of failing queries. Check once, up front.
  await assertDatabaseReady();
  const redis = await getRedis();
  const adapters = createRedisAdapters(redis);

  const analytics = new AnalyticsServiceImpl({ buffer: adapters.analyticsBuffer, logger: log });
  const community = new CommunityServiceImpl({ repo: communityRepository, logger: log });
  // Every config write announces itself, so a bot picks the change up in the
  // second it lands instead of after its own cache TTL. This is the panel's half
  // of "the panel commands, it doesn't bypass": the write goes through the same
  // service the bots use, and so does the notification.
  const guildConfig = new GuildConfigServiceImpl({
    repo: guildConfigRepository,
    broadcast: adapters.configBus,
    logger: log,
  });

  const moderation = new ModerationServiceImpl({
    repo: moderationRepository,
    ranks: rankResolver,
    // The real Redis mirror, same object the admin bot uses: a mute issued from
    // the panel has to be visible to the bridge immediately, and a no-op stub
    // would have written the audit row while enforcing nothing.
    enforcement: adapters.enforcement,
    // Still assumed, exactly as in the admin bot: proving the bot holds a
    // Discord permission needs a gateway connection, which this process does not
    // have. Wiring a `false` here would block every action instead.
    botCaps: { async canPerform() { return true; } },
    // Warnings escalate on a ladder the guild can edit; the policy lives in the
    // settings KV, read fresh on each warning so an edit takes effect on the
    // next one rather than at the next restart.
    escalation: { readPolicy: (guildId) => guildConfigRepository.getSetting(guildId, ESCALATION_SETTING_KEY) },
    logger: log,
  });

  /**
   * One Hypixel client, shared by the identity service and by guild linking.
   *
   * Shared rather than built twice so both go through the same cache and the
   * same rate gate — two clients would each hold their own budget against a
   * per-key limit that is not divisible.
   */
  const hypixel = new HypixelClient({
    ...(config.hypixel.apiKey ? { apiKey: config.hypixel.apiKey } : {}),
    cache: adapters.hypixelCache,
    rateGate: adapters.rateGate,
    logger: log,
  });

  /**
   * The real identity service, not a repo shim.
   *
   * It takes a Hypixel client, which this process would otherwise have little
   * use for — but the panel's rule is that it commands the same services the
   * bots do. A panel-local shortcut to `identityRepository.unlink` would work
   * today and quietly skip whatever the service does about it tomorrow. The
   * client is inert until something calls it, and nothing on the read paths does.
   */
  const identity = new IdentityServiceImpl({
    repo: identityRepository,
    social: hypixel,
    roles: rankResolver,
    logger: log,
  });

  /**
   * XP, for the admin config page and for hand-written adjustments.
   *
   * The cooldown gate is the same Redis adapter the bots pass, and for the same
   * reason the identity service gets a live Hypixel client: the panel commands
   * the service, it does not reimplement a slimmer one. Nothing the panel calls
   * consults the gate today — configuration and adjustment are not rate-limited
   * activity — but a service built with a stub would start lying the moment one
   * of them did.
   */
  const xp = new XpService({
    repo: xpRepository,
    activity: activitySink,
    cooldowns: adapters.cooldowns,
    logger: log,
  });

  /**
   * The chat filter, over the same repository the admin bot's `/wordlist-*`
   * commands use. Nothing about a rule is panel-specific: the bridge compiles
   * whatever this writes, so an edit here and an edit from Discord are the same
   * edit made through the same validation.
   */
  const wordlist = new WordlistServiceImpl({ repo: wordlistRepository, logger: log });

  const panel = new PanelService({
    roles: rankResolver,
    xp,
    community,
    moderation,
    reads: panelRepository,
    config: guildConfig,
    milestones: milestoneDefinitionRepository,
    tickets: ticketConfigRepository,
    wordlist,
    heartbeats: adapters.heartbeat,
    logger: log,
  });

  /**
   * Config changes have no ModerationAction to live in (that enum describes
   * actions on people), so they go to the analytics stream as a typed event.
   * That is queryable today and is the shape a durable ConfigAudit table would
   * be filled from later — the port is what keeps that a wiring change.
   */
  const audit: ConfigAuditSink = {
    async record(entry) {
      await analytics.emit({
        type: `panel.${entry.mutation}`,
        guildId: entry.guildId,
        surface: "WEB_PANEL",
        ts: entry.at,
        props: { actorDiscordId: entry.actorDiscordId, ...entry.change },
      });
    },
  };

  const mutations = new PanelMutations({
    roles: rankResolver,
    config: guildConfig,
    // The same service objects the reads use, and the same ones the bots hold:
    // a panel kick and a `/kick` are one code path with two front doors.
    moderation,
    community,
    identity,
    xp,
    milestones: milestoneDefinitionRepository,
    tickets: ticketConfigRepository,
    wordlist,
    hypixel,
    limiter: adapters.cooldowns,
    audit,
    analytics,
    logger: log,
  });

  // The panel subscribes as well as publishes: an admin-bot `/set-channel` has
  // to clear this process's cache too, or the page that just showed the old
  // value would keep showing it for the rest of the TTL.
  const unsubscribe = await adapters.configBus.subscribe((guildId) => {
    guildConfig.invalidate(guildId);
    log.debug("guild config invalidated by broadcast", { guildId });
  });

  const stopHeartbeat = startHeartbeat(adapters.heartbeat, () => ({
    service: "web-panel",
    instance: INSTANCE_ID,
    details: { port: config.web.port },
  }));

  return {
    config,
    log,
    panel,
    mutations,
    resolveGuild: guildRepository.resolveInternalId,
    async shutdown() {
      stopHeartbeat();
      await unsubscribe().catch(() => undefined);
      await disconnectDb();
    },
  };
}

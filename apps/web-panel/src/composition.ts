/**
 * Web-panel composition root — wires PanelService (reads) and PanelMutations
 * (writes) to the shared services over the real Prisma repos and Redis adapters.
 * `server.ts` calls these with a PanelSession resolved from the Redis-backed
 * session cookie, and serves the browser UI that reads them.
 */
import { loadConfig, type AppConfig } from "@sbr/config";
import {
  bridgePermissionRepository,
  communityRepository,
  assertDatabaseReady,
  disconnectDb,
  guildConfigRepository,
  guildRepository,
  memberRoleDirtyMarker,
  identityRepository,
  milestoneDefinitionRepository,
  ticketConfigRepository,
  moderationRepository,
  panelRepository,
  rankResolver,
  rolePolicyReader,
  wordlistRepository,
  activitySink,
  xpRepository,
} from "@sbr/db";
import { AnalyticsServiceImpl, createDomainMetrics } from "@sbr/analytics";
import { buildAdminRegistry } from "@sbr/commands-admin";
import { CommunityServiceImpl } from "@sbr/community";
import { GuildConfigServiceImpl } from "@sbr/guild-config";
import { HypixelClient } from "@sbr/hypixel";
import { IdentityServiceImpl } from "@sbr/identity";
import { ESCALATION_SETTING_KEY, ModerationServiceImpl, RELAY_SYNC_SETTING_KEY, WordlistServiceImpl } from "@sbr/moderation";
import { PanelMutations, PanelService, type ConfigAuditSink } from "@sbr/panel-core";
import { XpService } from "@sbr/xp";
import { createLogger, type Logger } from "@sbr/observability";
import { createRedisAdapters, getRedis, RUNNABLE_JOBS, startHeartbeat } from "@sbr/redis";
import { randomUUID } from "node:crypto";
import { createRolesInsight } from "./roles-insight.js";
import { createBotDirectory, createDiscordEnforcer, MAX_TIMEOUT_SECONDS, type EnforceRequest } from "./directory.js";
import { createTicketEffects } from "./ticket-effects.js";
import { createEventEffects } from "./event-effects.js";
import type { ModerationActionDTO } from "@sbr/shared-types";

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
  const metrics = createDomainMetrics({ analytics, surface: "WEB_PANEL", logger: log });
  const community = new CommunityServiceImpl({
    repo: communityRepository,
    rolesDirty: adapters.rolesDirty,
    logger: log,
  });
  // Every config write announces itself, so a bot picks the change up in the
  // second it lands instead of after its own cache TTL. This is the panel's half
  // of "the panel commands, it doesn't bypass": the write goes through the same
  // service the bots use, and so does the notification.
  const guildConfig = new GuildConfigServiceImpl({
    repo: guildConfigRepository,
    broadcast: adapters.configBus,
    logger: log,
  });

  /**
   * The bot's enforcement arm, and the panel's half of a punishment.
   *
   * Constructed before the moderation service because the service's enforcement
   * port wraps it: recording an action and not carrying it out is the bug this
   * closes, so the two are deliberately the same call.
   */
  const enforcer = createDiscordEnforcer({
    baseUrl: config.internalApi.baseUrl,
    token: config.internalApi.token,
    logger: log,
  });

  const moderation = new ModerationServiceImpl({
    repo: moderationRepository,
    ranks: rankResolver,
    metrics,
    // The real Redis mirror, same object the admin bot uses: a mute issued from
    // the panel has to be visible to the bridge immediately, and a no-op stub
    // would have written the audit row while enforcing nothing.
    enforcement: {
      async apply(action) {
        // Mirror first. The mirror is what the bridge and the dispatchers read
        // to decide whether someone is muted, and it must land even if Discord
        // refuses — otherwise a failed timeout would also leave the person
        // un-muted everywhere else.
        await adapters.enforcement.apply(action);
        const request = discordEnforcementFor(action);
        if (request === null) return;
        const outcome = await enforcer.enforce(action.guildId, request);
        if (!outcome.ok) {
          // Logged, not thrown: the audit row is already written and the mirror
          // already holds, so failing the whole action here would leave the
          // panel reporting an error against work that partly succeeded. The
          // Health page is where a persistently unreachable bot shows up.
          log.warn("discord enforcement did not apply", {
            guildId: action.guildId,
            type: action.type,
            target: action.targetDiscordId,
            error: outcome.error,
          });
        }
      },
    },
    // Still assumed, exactly as in the admin bot: proving the bot holds a
    // Discord permission needs a gateway connection, which this process does not
    // have. Wiring a `false` here would block every action instead.
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
    floors: rolePolicyReader,
    // Auto-roles hear about links and completed events promptly rather than
    // waiting for the reconciler's daily sweep to notice.
    rolesDirty: memberRoleDirtyMarker(adapters.rolesDirty),
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

  const rolesInsight = createRolesInsight({ dirty: adapters.rolesDirty, refusals: adapters.roleRefusals });

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
    permissionExceptions: bridgePermissionRepository,
    // The roster the dry run resolves against, and the reconciler's own
    // diagnostics. Constructed unconditionally: both halves degrade to an
    // empty answer rather than throwing, and a Roles page that cannot show a
    // preview is still a Roles page.
    rolesInsight,
    // The command table on the Permissions page is the admin bot's own
    // registry, read for its metadata only — the panel never dispatches these.
    // Building it here rather than hardcoding a list is what stops the page
    // from quietly going stale when a command is added or its floor changes.
    commands: {
      list() {
        return [...buildAdminRegistry().values()].map((spec) => ({
          name: spec.name,
          description: spec.description,
          minRole: spec.minRole,
        }));
      },
    },
    // The channel/role/member source behind every picker. Constructed
    // unconditionally — it reports itself unavailable when no token is set,
    // which is the same answer it gives when the bot is simply down, and the
    // pages handle that one case rather than two.
    directory: createBotDirectory({
      baseUrl: config.internalApi.baseUrl,
      token: config.internalApi.token,
      logger: log,
    }),
    runnableJobs: RUNNABLE_JOBS,
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
    // The same store the read side lists from, so an exception written here is
    // the row the resolver consults on the relay's next message.
    permissionExceptions: bridgePermissionRepository,
    // The same object the read side holds, so a dry run and the page that
    // triggered it are looking at exactly one roster.
    rolesInsight,
    // "Run now" on the Health page. The panel publishes a request and the
    // worker fleet queues it, so `bullmq` stays out of this process entirely
    // and exactly one writer owns the queue.
    jobs: {
      runnable: RUNNABLE_JOBS,
      async trigger(request) {
        await adapters.jobTriggers.publish({ ...request, at: new Date().toISOString() });
      },
    },
    // The Discord side of "Publish" and "Re-send transcript". Ticket channels
    // live where the *bridge* bot is, so this dials that process rather than
    // the admin one the pickers use.
    ticketEffects: createTicketEffects({
      baseUrl: config.internalApi.bridgeBaseUrl,
      token: config.internalApi.token,
      logger: log,
    }),
    // Same bridge, same token: the tracker board lives in a guild channel the
    // bridge bot is in, and redrawing it is one REST call there.
    eventEffects: createEventEffects({
      baseUrl: config.internalApi.bridgeBaseUrl,
      token: config.internalApi.token,
      logger: log,
    }),
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

/**
 * Which Discord action, if any, a recorded moderation action implies.
 *
 * `null` for WARN and NOTE on purpose: those are records, not removals, and
 * inventing a Discord effect for them would punish twice for one action — the
 * warning already escalates on its own ladder, and the ladder's rungs come back
 * through here as MUTE or BAN when they are reached.
 *
 * MUTE becomes a Discord *timeout* because that is the only server-wide silence
 * Discord offers; a mute role would have to be configured, maintained and
 * re-applied per channel, and the mirror already covers the surfaces we own.
 */
function discordEnforcementFor(action: ModerationActionDTO): EnforceRequest | null {
  if (action.targetDiscordId === null) return null;
  const base = {
    userId: action.targetDiscordId,
    reason: action.reason ?? "No reason given",
    durationSeconds: action.durationSeconds,
  };
  switch (action.type) {
    case "MUTE":
      // An unbounded mute has no timeout to express, and clamping it to 28 days
      // would quietly convert a permanent punishment into a temporary one. The
      // mirror still holds it everywhere the platform controls.
      if (action.durationSeconds === null || action.durationSeconds <= 0) return null;
      return { ...base, type: "TIMEOUT", durationSeconds: Math.min(action.durationSeconds, MAX_TIMEOUT_SECONDS) };
    case "UNMUTE":
      return { ...base, type: "UNTIMEOUT" };
    case "KICK":
      return { ...base, type: "KICK" };
    case "BAN":
      return { ...base, type: "BAN" };
    case "UNBAN":
      return { ...base, type: "UNBAN" };
    default:
      return null;
  }
}

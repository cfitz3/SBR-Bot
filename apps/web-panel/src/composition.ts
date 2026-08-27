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
  leaderboardSource,
} from "@sbr/db";
import { AnalyticsServiceImpl, createDomainMetrics } from "@sbr/analytics";
import { createClientIngestService, type ClientIngestService } from "@sbr/client-ingest";
import { buildAdminRegistry } from "@sbr/commands-admin";
import { CommunityServiceImpl } from "@sbr/community";
import { LeaderboardService } from "@sbr/leaderboards";
import { GuildConfigServiceImpl } from "@sbr/guild-config";
import { HypixelClient } from "@sbr/hypixel";
import { IdentityServiceImpl } from "@sbr/identity";
import {
  createGameCommandBus,
  ESCALATION_SETTING_KEY,
  ModerationServiceImpl,
  RELAY_SYNC_SETTING_KEY,
  WordlistServiceImpl,
  type ModLogSink,
  type StaffAlertSink,
} from "@sbr/moderation";
import type { EmbedView } from "@sbr/shared-types";
import { PanelMutations, PanelService, type ConfigAuditSink } from "@sbr/panel-core";
import { XpService } from "@sbr/xp";
import { createLogger, type Logger } from "@sbr/observability";
import { createRedisAdapters, getRedis, RUNNABLE_JOBS, startHeartbeat } from "@sbr/redis";
import { randomUUID } from "node:crypto";
import { createRolesInsight } from "./roles-insight.js";
import {
  createBotDirectory,
  createChannelPoster,
  createDiscordEnforcer,
  MAX_TIMEOUT_SECONDS,
  type EnforceRequest,
} from "./directory.js";
import { createTicketEffects } from "./ticket-effects.js";
import { createEventEffects } from "./event-effects.js";
import { createRoleMenuEffects } from "./role-menu-effects.js";
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
  /** The ctjs client telemetry endpoint, mounted on this process's HTTP server. */
  readonly ingest: ClientIngestService;
  resolveGuild(discordGuildId: string): Promise<string | null>;
  /**
   * Whether a signed-in Discord user may read the ingest debug buffer.
   *
   * Lives here rather than in the server because the answer needs the identity
   * service and the guild resolver, and because it is an authorization decision
   * that deserves to sit next to the others rather than inline in a route.
   */
  canReadIngestDebug(discordId: string, manageableGuildIds: readonly string[]): Promise<boolean>;
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
  const adapters = createRedisAdapters(redis, { playerWindowMs: config.hypixel.playerWindowMs });

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

  /**
   * The same bus, for punishments, with a verdict attached.
   *
   * `guildCommands` above answers "was it handed over", which is the right
   * question for a staffer pressing Accept and the wrong one for a ban: a
   * `/g kick` Hypixel refuses is handed over just as successfully as one it
   * honours. This waits for the bridge to say what became of the line, so the
   * case records the guild's answer instead of Redis's.
   */
  const punishmentCommands = createGameCommandBus({
    publish: (message) => adapters.modBus.publish(message),
    subscribeAcks: (onAck) => adapters.modBus.subscribeAcks(onAck),
    live: async (guildId) => {
      const live = await adapters.heartbeat.list().catch(() => []);
      const up = live.some((r) => r.service === "bridge-bot" && r.details["mcSpawned"] === true);
      if (!up) log.warn("guild command not sent: no bridge is in-game", { guildId });
      return up;
    },
    logger: log,
  });

  /**
   * The guild's moderation log and its staff alerts, over the loopback hop.
   *
   * Same contract and same slot order as the two bots': the log tries `modlog`
   * and falls back to `staff`, the alert tries `staff` and falls back to
   * `modlog`, ordered in each case by who needs to read it. What differs is
   * only how the send happens — this process has no gateway, so it asks the
   * admin bot, which is where privileged Discord writes belong anyway.
   *
   * Wiring these is the fix for a mod log that appeared to work intermittently.
   * The panel is the surface most staff moderation now goes through, and it was
   * the one process constructing a `ModerationServiceImpl` without a sink: the
   * service dutifully called nothing after settling every action, and a guild
   * saw automod's cards and the admin bot's and none of its own staff's. A
   * missing wire reads exactly like a flaky one from the outside, which is why
   * it survived so long.
   *
   * Both are best-effort, as everywhere: the punishment has already happened,
   * and an unreachable bot is not a reason to un-take it.
   */
  const postToChannel = createChannelPoster({
    baseUrl: config.internalApi.baseUrl,
    token: config.internalApi.token,
    logger: log,
  });

  async function postToFirstSlot(
    guildId: string,
    slots: readonly ("modlog" | "staff")[],
    embed: EmbedView,
  ): Promise<void> {
    const row = await guildConfigRepository.get(guildId).catch(() => null);
    for (const slot of slots) {
      const channelId = row?.channels[slot] ?? null;
      if (channelId !== null && (await postToChannel(guildId, channelId, embed))) return;
    }
  }

  const modLog: ModLogSink = {
    post: (guildId, embed) => postToFirstSlot(guildId, ["modlog", "staff"], embed),
  };

  const staffAlerts: StaffAlertSink = {
    alert: (guildId, text) =>
      postToFirstSlot(guildId, ["staff", "modlog"], { description: text, color: "WARNING" }),
  };

  const moderation = new ModerationServiceImpl({
    repo: moderationRepository,
    ranks: rankResolver,
    // A punishment changes what auto-roles the target should hold, and waiting
    // for the reconciler's next full sweep to notice made a ban land on one
    // surface now and another later.
    rolesDirty: adapters.rolesDirty,
    modLog,
    staffAlerts,
    metrics,
    // The real Redis mirror, same object the admin bot uses: a mute issued from
    // the panel has to be visible to the bridge immediately, and a no-op stub
    // would have written the audit row while enforcing nothing.
    // The mirror, and only the mirror. It is what the bridge and the dispatchers
    // read to decide whether someone is muted, and it must land even if Discord
    // refuses - otherwise a failed timeout would also leave the person un-muted
    // everywhere else.
    //
    // The real Discord call used to be hidden in here too, with its failure
    // reduced to a `log.warn`. That is how the panel could report a completed
    // ban against a member who was never banned: the mirror is a cache, and a
    // cache entry is not a removal. It is now the `discord` port below, whose
    // failure marks the case `enforcement_failed` and tells staff.
    enforcement: adapters.enforcement,
    discord: {
      async enforce(action) {
        const request = discordEnforcementFor(action);
        // Nothing to ask Discord for is not a failure: a WARN has no Discord
        // effect, and an unbounded mute has no timeout to express.
        if (request === null) {
          return { ok: true, skipped: true, reason: "no Discord effect for this action" };
        }
        const outcome = await enforcer.enforce(action.guildId, request);
        return outcome.ok ? { ok: true } : { ok: false, reason: outcome.error };
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
    //
    // The heartbeat check is what makes the publish honest, and the ack wait is
    // what makes the *answer* honest. Redis pub/sub has no store-and-forward,
    // so publishing to a channel with no subscriber succeeds and drops the
    // message; and a bridge that types a line Hypixel refuses has still typed
    // it. A ban issued from the panel used to report its `/g kick` sent in both
    // of those cases.
    gameCommands: punishmentCommands,
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
    // The self-imposed per-player floor. Absent in production mode, where the
    // cache TTL is the only floor and the client falls back to `unlimitedPlayers`.
    ...(adapters.playerLimiter ? { playerLimiter: adapters.playerLimiter } : {}),
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
    // The same service, over the same source, that `/leaderboard` reads. One
    // ranking implementation is the point: a member who is 3rd in Discord must
    // not be 4th on the page, and two implementations would eventually differ.
    leaderboards: new LeaderboardService(leaderboardSource),
    tickets: ticketConfigRepository,
    wordlist,
    heartbeats: adapters.heartbeat,
    relayLog: adapters.relayLog,
    permissionExceptions: bridgePermissionRepository,
    // The roster the dry run resolves against, and the reconciler's own
    // diagnostics. Constructed unconditionally: both halves degrade to an
    // empty answer rather than throwing, and a Roles page that cannot show a
    // preview is still a Roles page.
    rolesInsight,
    // Whether Publish on a role menu can promise anything. The token is what
    // decides it: without one the effects client refuses at press time, and the
    // page should say so up front rather than offering a button that cannot work.
    roleMenuPublisher: config.internalApi.token !== undefined,
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
    // And again for self-service role menus: the message members press lives in
    // the community server, so the member-facing bot posts it.
    roleMenuEffects: createRoleMenuEffects({
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

  /**
   * The client telemetry endpoint.
   *
   * The resolver is composed rather than imported: `@sbr/client-ingest` asks
   * only for "turn this IGN into a member", and the answer here is the IGN
   * index plus the real identity service, so a connection is accepted on the
   * same evidence a `/link` produced. An account nobody has linked resolves to
   * null and the socket is closed — which is the point of checking at all.
   */
  const ingest = createClientIngestService({
    log: log.child({ component: "client-ingest" }),
    resolver: {
      async resolveByIgn(ign) {
        const discordId = await identityRepository.findDiscordIdByIgn(ign).catch(() => null);
        if (discordId === null) return null;
        const link = await identity.resolveByDiscordId(discordId);
        // A row in the IGN index is not on its own a live link — it can be a
        // stale or unverified one. The service is what says the link stands.
        if (!link.ok || link.value === null) return null;
        return { memberId: discordId, ign: link.value.ign };
      },
    },
  });

  /**
   * ADMIN in any guild the viewer can manage. Reading another member's raw
   * client events is a staff action, so it takes the capability that gates the
   * other staff surfaces rather than a bare signed-in session.
   */
  async function canReadIngestDebug(discordId: string, manageableGuildIds: readonly string[]): Promise<boolean> {
    for (const discordGuildId of manageableGuildIds.slice(0, 25)) {
      const internalId = await guildRepository.resolveInternalId(discordGuildId).catch(() => null);
      if (internalId === null) continue;
      if (await identity.hasCapability(internalId, discordId, "ADMIN").catch(() => false)) return true;
    }
    return false;
  }

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
    ingest,
    resolveGuild: guildRepository.resolveInternalId,
    canReadIngestDebug,
    async shutdown() {
      ingest.shutdown();
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

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
  screeningRepository,
  disconnectDb,
  guildConfigRepository,
  guildRepository,
  memberRoleDirtyMarker,
  identityRepository,
  moderationRepository,
  pingDb,
  rankResolver,
  rolePolicyReader,
  wordlistRepository,
} from "@sbr/db";
import {
  createGameCommandBus,
  ESCALATION_SETTING_KEY,
  ANTIRAID_SETTING_KEY,
  ModerationServiceImpl,
  parseAntiRaid,
  RELAY_SYNC_SETTING_KEY,
  SafetyServiceImpl,
  WordlistServiceImpl,
  type DiscordActionInput,
  parsePackSelection,
  MAX_ENFORCEMENT_ATTEMPTS,
  STALE_GRACE_MS,
  WORDLIST_PACKS_SETTING_KEY,
  type DiscordEnforcer,
  type ModLogSink,
  type AntiRaidRules,
  type StaffAlertSink,
} from "@sbr/moderation";
import type { EmbedView } from "@sbr/shared-types";
import { IdentityServiceImpl } from "@sbr/identity";
import { createGuildRankProbe } from "@sbr/jobs";
import { JoinQueueService, ScreeningService, type GuildCommandSender } from "@sbr/screening";
import { HypixelClient } from "@sbr/hypixel";
import { CommunityServiceImpl } from "@sbr/community";
import { GuildConfigServiceImpl } from "@sbr/guild-config";
import { AnalyticsServiceImpl, createDomainMetrics } from "@sbr/analytics";
import { AdminDispatcher, buildAdminRegistry, renderEffectError } from "@sbr/commands-admin";
import {
  createLogger,
  createLogShipper,
  HealthRegistry,
  pingCheck,
  type Logger,
} from "@sbr/observability";
import { closeRedis, createRedisAdapters, getRedis, pingRedis, startHeartbeat } from "@sbr/redis";
import { randomUUID } from "node:crypto";
import { DiscordGuildEffects } from "./effects.js";
import { RAID_GATE_ACTOR, type RaidGateDeps } from "./raid-gate.js";
import { createTicketBridge } from "./ticket-bridge.js";
import { createRoleMenuBridge } from "./role-menu-bridge.js";
import { createStickyBridge } from "./sticky-bridge.js";

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
  /**
   * Lift punishments whose clock has run out, on both surfaces, and clear their
   * flags. Returns how many were lifted.
   */
  sweepPunishments(): Promise<number>;
  /** Redis lock, so a second admin-bot instance doesn't double-run the sweep. */
  readonly lock: ReturnType<typeof createRedisAdapters>["lock"];
  /**
   * Members arriving and leaving, published for whoever greets them. This
   * process observes because it holds the intent; SBR Bot does the talking.
   */
  readonly memberBus: ReturnType<typeof createRedisAdapters>["memberBus"];
  readonly rolesDirty: ReturnType<typeof createRedisAdapters>["rolesDirty"];
  resolveGuild(discordGuildId: string): Promise<string | null>;
  /**
   * Adopt a punishment somebody carried out in Discord's own interface.
   *
   * On the app rather than reached through the dispatcher because its caller is
   * a gateway listener, not a command: nobody typed anything, and there is no
   * interaction to reply to.
   */
  recordDiscordAction(input: DiscordActionInput): Promise<void>;
  /**
   * Late-bound live gateway state for the heartbeat, set once the transport
   * exists. Unset simply means "up, not connected yet", which is what the
   * Health page should show during a slow start.
   */
  setStatusSource(source: (() => AdminStatusDetails) | null): void;
  /**
   * How ops messages reach Discord. Late-bound for the same reason the status
   * source is: this process reports on a fleet that includes its own gateway,
   * so the reporting has to exist before the connection does. Until it is set —
   * and while it is null again during shutdown — batches are dropped rather
   * than queued: a stale alert about a minute that has already passed is worse
   * than no alert.
   */
  setOpsPoster(post: ((channelId: string, text: string) => Promise<boolean>) | null): void;
  /**
   * Where moderation-log cards go. Separate from the ops poster because this one
   * sends an embed rather than a line of plain text, and because the two have
   * different audiences: ops alerts are for whoever runs the platform, the mod
   * log is for the guild's own staff.
   */
  setModLogPoster(post: ((channelId: string, embed: EmbedView) => Promise<boolean>) | null): void;
  /**
   * What the transport hands `attachRaidGate`. On the app rather than built in
   * the transport because every one of its effects is a service this file owns.
   */
  readonly raidGate: RaidGateDeps;
  /** The infrastructure probes, for the watchtower's own reading. */
  readonly health: HealthRegistry;
  /** Live heartbeats across the fleet. */
  listBeats(): Promise<readonly { service: string; instance: string; at: string }[]>;
  shutdown(): Promise<void>;
}

/** Whatever the transport can say about itself; forwarded verbatim to Redis. */
export type AdminStatusDetails = Readonly<Record<string, string | number | boolean | null>>;

export async function createAdminApp(): Promise<AdminApp> {
  const config = loadConfig();

  // The ops poster is set by the transport at ready; everything built before
  // then closes over this rather than over a client that does not exist yet.
  let opsPost: ((channelId: string, text: string) => Promise<boolean>) | null = null;
  let modLogPost: ((channelId: string, embed: EmbedView) => Promise<boolean>) | null = null;
  const errorChannelId = config.ops.errorChannelId ?? null;
  const shipper =
    errorChannelId === null
      ? null
      : createLogShipper({
          service: "admin-bot",
          async post(text) {
            if (opsPost === null) return;
            await opsPost(errorChannelId, text);
          },
        });

  const log = createLogger({
    level: config.logLevel,
    name: "admin-bot",
    ...(shipper ? { sink: shipper.sink } : {}),
  });

  // Prisma connects lazily, so a wrong or absent Postgres would otherwise only
  // show up later as an endless drip of failing queries. Check once, up front.
  await assertDatabaseReady();
  const redis = await getRedis();
  const adapters = createRedisAdapters(redis, { playerWindowMs: config.hypixel.playerWindowMs });

  // Built before the gateway exists; `attach()` supplies the client at ready.
  const effects = new DiscordGuildEffects({
    toDiscordGuildId: guildRepository.resolveDiscordId,
    logger: log,
  });

  // Constructed before the services that feed it, so every emitter can be
  // handed the same buffer rather than a second one.
  const analytics = new AnalyticsServiceImpl({ buffer: adapters.analyticsBuffer, logger: log });
  const metrics = createDomainMetrics({ analytics, surface: "ADMIN_BOT", logger: log });

  /**
   * Guild commands from staff and from punishments, over one bus.
   *
   * The liveness check is not decoration. Redis pub/sub has no store-and-forward:
   * publishing to a channel nobody is subscribed to succeeds and the message is
   * gone. Without this, `/join-accept` would answer "sent" whenever the bridge
   * happened to be down, and staff would come back to an applicant still waiting
   * with the platform insisting they had been admitted. A bridge that is up but
   * not spawned in-game is equally no use, so `mcSpawned` is what is checked
   * rather than mere presence.
   *
   * The moderation service is wired to this same sender rather than to a bare
   * publish. It used to have its own, publishing blind and returning void, which
   * is how a `/ban` could report success while the `/g kick` that should have
   * removed the same person from the Hypixel guild evaporated into a channel
   * with no subscriber.
   */
  const guildCommands: GuildCommandSender = {
    async send(guildId, command) {
      const live = await adapters.heartbeat.list().catch(() => []);
      const bridge = live.find((r) => r.service === "bridge-bot" && r.details["mcSpawned"] === true);
      if (!bridge) {
        log.warn("guild command not sent: no bridge is in-game", { guildId });
        return false;
      }
      try {
        await adapters.modBus.publish({ guildId, kind: "GAME_COMMAND", command, correlationId: randomUUID() });
        return true;
      } catch (error) {
        log.error("guild command could not be published", { guildId, error: String(error) });
        return false;
      }
    },
  };

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
   * The Discord half of enforcement, over the same `GuildEffects` the commands
   * use. This is the port whose absence was the bug: the service was handed the
   * Redis mirror as its only "enforcement", the mirror is a cache, and so
   * nothing in this process ever asked Discord to remove anybody.
   *
   * Reversal types are mapped as carefully as the punitive ones. An UNBAN that
   * quietly did nothing would be the same failure wearing the opposite sign.
   */
  const discordEnforcer: DiscordEnforcer = {
    async enforce(action) {
      const target = action.targetDiscordId;
      if (target === null) return { ok: true, skipped: true, reason: "no Discord target" };
      const reason = `case ${action.id}: ${action.reason}`;

      const outcome = await (async () => {
        switch (action.type) {
          case "BAN":
            return effects.ban(action.guildId, target, reason);
          case "UNBAN":
            return effects.unban(action.guildId, target, reason);
          case "KICK":
            return effects.kick(action.guildId, target, reason);
          case "MUTE":
            // Guarded by the service, which refuses an unbounded MUTE outright;
            // the fallback keeps this total rather than relying on that.
            return effects.timeout(action.guildId, target, action.durationSeconds ?? 0, reason);
          case "UNMUTE":
            return effects.untimeout(action.guildId, target, reason);
          default:
            return null;
        }
      })();

      if (outcome === null) return { ok: true, skipped: true, reason: "no Discord counterpart" };
      if (outcome.ok) return { ok: true };
      return { ok: false, reason: renderEffectError(outcome.error) };
    },
  };

  /**
   * Where a failed enforcement is announced.
   *
   * The staff channel first, the moderation log second, the ops error channel
   * last. Ordered by who needs to act: a punishment that did not land needs a
   * human to finish it, and the people who can are in `staff`. The ops channel
   * is the floor rather than the target — it catches guilds that have configured
   * neither, which are exactly the guilds most likely to have this go wrong.
   */
  const staffAlerts: StaffAlertSink = {
    async alert(guildId, text) {
      if (opsPost === null) return;
      // Read straight from the repository rather than through the cached
      // config service: this runs a handful of times a month, and the service
      // is built further down the file anyway.
      const row = await guildConfigRepository.get(guildId).catch(() => null);
      for (const slot of ["staff", "modlog"] as const) {
        const channelId = row?.channels[slot] ?? null;
        if (channelId !== null && (await opsPost(channelId, text))) return;
      }
      if (errorChannelId !== null) await opsPost(errorChannelId, text);
    },
  };

  /**
   * The guild's moderation log.
   *
   * The `modlog` channel slot has been offered in the panel all along and
   * nothing has ever written to it — a guild could bind it, see it bound, and
   * receive nothing. Every action now lands here, including the ones nobody
   * typed: an automod mute and an expired ban lifting itself are exactly the
   * events staff cannot otherwise see happen.
   *
   * Falls back to `staff` rather than going quiet, and gives up rather than
   * escalating to the ops channel: an unbound mod log is a configuration
   * preference, not an incident, and filling the platform's error channel with
   * one guild's warnings would bury the alerts that are.
   */
  const modLog: ModLogSink = {
    async post(guildId, embed) {
      if (modLogPost === null) return;
      const row = await guildConfigRepository.get(guildId).catch(() => null);
      for (const slot of ["modlog", "staff"] as const) {
        const channelId = row?.channels[slot] ?? null;
        if (channelId !== null && (await modLogPost(channelId, embed))) return;
      }
    },
  };

  const moderation = new ModerationServiceImpl({
    repo: moderationRepository,
    ranks: rankResolver,
    // A punishment changes what auto-roles the target should hold, and waiting
    // for the reconciler's next full sweep to notice made a ban land on one
    // surface now and another later.
    rolesDirty: adapters.rolesDirty,
    // The Redis mirror: a cache the bridge and the dispatchers read, and
    // nothing more. Kept separate from `discord` now that the two are no longer
    // confused for one another.
    enforcement: adapters.enforcement,
    discord: discordEnforcer,
    staffAlerts,
    modLog,
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

  // Staff commands reach beyond moderation — `/set-channel` and `/feature-toggle`
  // write guild config, `/accept-member` touches community, and every invocation
  // is captured for the audit surface.
  const hypixel = new HypixelClient({
    ...(config.hypixel.apiKey ? { apiKey: config.hypixel.apiKey } : {}),
    cache: adapters.hypixelCache,
    // The self-imposed per-player floor. Absent in production mode, where the
    // cache TTL is the only floor and the client falls back to `unlimitedPlayers`.
    ...(adapters.playerLimiter ? { playerLimiter: adapters.playerLimiter } : {}),
    rateGate: adapters.rateGate,
    logger: log,
  });
  // The immediate half of `/link`: settle Hypixel guild membership on the
  // request itself, so a member who links a minute after joining the guild gets
  // their guild role now rather than at the next roster scan. `LINK_GUILD_PROBE=0`
  // turns it off and returns the marker to the roster-cache behaviour it had
  // before, which is the whole reason it is a flag.
  const linkGuildProbe = (process.env.LINK_GUILD_PROBE ?? "1") !== "0";
  const roleDirty = memberRoleDirtyMarker(adapters.rolesDirty, {
    ...(linkGuildProbe ? { probe: createGuildRankProbe(hypixel) } : {}),
    retryMs: Number(process.env.LINK_GUILD_PROBE_RETRY_MS ?? 45_000),
    log,
  });

  const identity = new IdentityServiceImpl({
    repo: identityRepository,
    social: hypixel,
    roles: rankResolver,
    // Capability floors are the guild's to set on the panel; without this the
    // service falls back to its own compiled-in defaults.
    floors: rolePolicyReader,
    // Auto-roles hear about links and completed events promptly rather than
    // waiting for the reconciler's daily sweep to notice.
    rolesDirty: roleDirty,
    logger: log,
  });
  const community = new CommunityServiceImpl({
    repo: communityRepository,
    rolesDirty: adapters.rolesDirty,
    logger: log,
  });
  // Publishes so a `/set-channel` here reaches the bridge and the panel, and
  // subscribes (below) so their writes reach this process.
  const guildConfig = new GuildConfigServiceImpl({
    repo: guildConfigRepository,
    broadcast: adapters.configBus,
    logger: log,
  });
  const safety = new SafetyServiceImpl({ store: adapters.safety, effects, logger: log });
  // Packaged lists are a setting, so the source is the config repository the
  // rest of the app already reads settings through.
  const wordlistPacks = {
    async selection(guildId: string) {
      return parsePackSelection(await guildConfigRepository.getSetting(guildId, WORDLIST_PACKS_SETTING_KEY));
    },
  };
  const wordlist = new WordlistServiceImpl({ repo: wordlistRepository, packs: wordlistPacks, logger: log });

  /**
   * What the raid gate is allowed to do, assembled from the services that
   * already exist rather than given its own reach into the database.
   *
   * `engage` and `punish` both go through a service so an automatic decision
   * leaves the same trail a typed one does: an engage is the same posture
   * `/antiraid on` sets and the same one the sweep lifts, and a removal is a
   * case with an actor, a reason and a reversal path.
   */
  const raidGate: RaidGateDeps = {
    resolveGuild: (discordGuildId) => guildRepository.resolveInternalId(discordGuildId),
    async rules(guildId): Promise<AntiRaidRules> {
      const stored = await guildConfigRepository
        .getSetting(guildId, ANTIRAID_SETTING_KEY)
        .catch(() => null);
      return parseAntiRaid(stored);
    },
    async postureActive(guildId) {
      const status = await safety.status(guildId).catch(() => null);
      return status !== null && status.ok && status.value.antiRaid !== null;
    },
    async engage(guildId, rules) {
      await safety
        .enableAntiRaid({
          guildId,
          actorDiscordId: RAID_GATE_ACTOR,
          // The stored rules are the configuration; sensitivity is only the
          // preset they started from, and MEDIUM is what the posture records
          // for an engage nobody chose a sensitivity for.
          sensitivity: "MEDIUM",
          durationSeconds: rules.autoLiftMinutes === null ? null : rules.autoLiftMinutes * 60,
        })
        .catch(() => null);
      if (rules.lockdownOnEngage) {
        await safety
          .lockdown({
            guildId,
            actorDiscordId: RAID_GATE_ACTOR,
            scope: "SERVER",
            reason: "Anti-raid engaged",
            durationSeconds: rules.autoLiftMinutes === null ? null : rules.autoLiftMinutes * 60,
          })
          .catch(() => null);
      }
    },
    async punish({ guildId, discordId, action, reason }) {
      await moderation
        .applyAction({
          guildId,
          type: action,
          actorDiscordId: RAID_GATE_ACTOR,
          targetDiscordId: discordId,
          reason,
          durationSeconds: null,
        })
        .catch(() => null);
    },
    async flag({ guildId, discordId, reasons }) {
      await staffAlerts
        .alert(guildId, `Anti-raid flagged <@${discordId}> — ${reasons.join("; ")}`)
        .catch(() => undefined);
    },
    logger: log,
  };

  /**
   * The in-game join queue: `/join-queue`, `/join-accept`, `/join-deny`,
   * `/guild-invite`.
   *
   * Only the repository half of screening is wired here. This process never
   * *screens* anybody — that happens on the bridge, where the chat line arrives
   * — so the scammer list, the stat reader and the policy source would be dead
   * weight. What staff need from here is the queue those screenings left behind
   * and a way to answer one.
   */
  const screening = new ScreeningService({ repo: screeningRepository, logger: log });

  const joinQueue = new JoinQueueService({
    screening,
    commands: guildCommands,
    // Mojang's casing, and the uuid that matches a typed name back to its row.
    players: {
      async resolveIgn(ign) {
        const found = await hypixel.resolveUuid(ign);
        return found === null ? null : { uuid: found.uuid, ign: found.name };
      },
    },
    logger: log,
  });

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
      joinQueue,
      // `/tickets close` and `/tickets transcript` belong to the bridge bot,
      // which is the client in the server the ticket channels live in.
      ticketBridge: createTicketBridge({
        baseUrl: config.internalApi.bridgeBaseUrl,
        token: config.internalApi.token,
        logger: log,
      }),
      // Same split for `/rolemenu`: the menus are read from this database, and
      // the message they are published as belongs to the member-facing bot.
      roleMenuBridge: createRoleMenuBridge({
        baseUrl: config.internalApi.bridgeBaseUrl,
        token: config.internalApi.token,
        config: guildConfig,
        logger: log,
      }),
      // And again for `/sticky`: the document is settings this process owns,
      // the message at the bottom of the channel is the other bot's.
      stickyBridge: createStickyBridge({
        baseUrl: config.internalApi.bridgeBaseUrl,
        token: config.internalApi.token,
        config: guildConfig,
        logger: log,
      }),
      logger: log,
    },
    logger: log,
  });

  const unsubscribe = await adapters.configBus.subscribe((guildId) => {
    guildConfig.invalidate(guildId);
    log.debug("guild config invalidated by broadcast", { guildId });
  });

  const health = new HealthRegistry();
  health.register(pingCheck("postgres", pingDb));
  health.register(pingCheck("redis", pingRedis));

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
    raidGate,
    sweepSafety: () => safety.sweepExpired(),
    async sweepPunishments() {
      // Two jobs on one cadence. Reversal lifts what has expired; the second
      // call settles what was never answered for, so a `/g kick` the guild
      // ignored ends up as a FAILED case with an alert rather than a row that
      // reads "pending" until somebody happens to open it.
      // Both knobs are here rather than in the service so a deployment whose
      // bridge is slower than ours can widen the grace without a release. The
      // grace has to outlast the bridge's outbound queue (ten minutes today);
      // the attempt cap is what stops a case reading "pending" forever.
      const graceMs = Number(process.env.ENFORCEMENT_RETRY_GRACE_MS ?? STALE_GRACE_MS);
      const maxAttempts = Number(process.env.ENFORCEMENT_MAX_ATTEMPTS ?? MAX_ENFORCEMENT_ATTEMPTS);
      await moderation.settleStalePending(graceMs, 50, maxAttempts).catch((error: unknown) => {
        log.error("could not settle unconfirmed punishments", { error: String(error) });
      });
      const r = await moderation.reverseExpired();
      return r.ok ? r.value : 0;
    },
    lock: adapters.lock,
    memberBus: adapters.memberBus,
    rolesDirty: adapters.rolesDirty,
    resolveGuild: guildRepository.resolveInternalId,
    async recordDiscordAction(input) {
      const recorded = await moderation.recordDiscordAction(input);
      if (!recorded.ok) {
        log.error("could not adopt a Discord moderation action", {
          guildId: input.guildId,
          type: input.type,
          target: input.targetDiscordId,
        });
      }
    },
    setStatusSource(source) {
      liveStatus = source;
    },
    setModLogPoster(post) {
      modLogPost = post;
    },
    setOpsPoster(post) {
      opsPost = post;
    },
    health,
    listBeats: () => adapters.heartbeat.list(),
    async shutdown() {
      stopHeartbeat();
      // One last flush while the gateway is still up: the errors that explain a
      // crash are the ones logged in the seconds before it.
      if (shipper) {
        await shipper.flush().catch(() => false);
        shipper.stop();
      }
      opsPost = null;
      await unsubscribe().catch(() => undefined);
      await Promise.allSettled([closeRedis(), disconnectDb()]);
    },
  };
}

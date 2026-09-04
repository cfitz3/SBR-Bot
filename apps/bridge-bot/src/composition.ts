/**
 * Bridge-bot composition root — wires the member-command dispatcher to the real
 * adapters. The discord.js gateway + Mineflayer connector call `dispatch(...)`
 * and relay through @sbr/bridge; those transports are the remaining runtime piece
 * (need the libs + a bot token).
 */
import { loadConfig, type AppConfig } from "@sbr/config";
import {
  communityRepository,
  assertDatabaseReady,
  disconnectDb,
  guildConfigRepository,
  guildMemberDirectory,
  guildRepository,
  memberRoleDirtyMarker,
  identityRepository,
  leaderboardSource,
  linkDirectory,
  memberProgressSource,
  milestoneAnnouncementRepository,
  reminderRepository,
  ticketConfigRepository,
  xpLevelUpAnnouncementRepository,
  roleSyncRepository,
  permRepository,
  milestoneDefinitionRepository,
  moderationRepository,
  progressionRepository,
  goalRepository,
  rankResolver,
  rolePolicyReader,
  wordlistRepository,
  screeningHistorySource,
  screeningPolicySource,
  screeningRepository,
  xpRepository,
  activitySink,
  podiumRepository,
  pingDb,
  playSessionSink,
  serverActivityRepository,
} from "@sbr/db";
import { createGuildRankProbe } from "@sbr/jobs";
import { IdentityServiceImpl } from "@sbr/identity";
import { fetchHttp, HypixelClient, hypixelCheck, type SkyblockProfileDTO } from "@sbr/hypixel";
import { SkykingsClient } from "@sbr/skykings";
import { ScreeningService } from "@sbr/screening";
import { CommunityServiceImpl, memberPodiumSource } from "@sbr/community";
import { PermServiceImpl } from "@sbr/perms";
import { XpService } from "@sbr/xp";
import { LeaderboardService } from "@sbr/leaderboards";
import {
  GuildConfigServiceImpl,
  COOLDOWN_SETTING_KEY,
  meetsFloor,
  parseCooldowns,
  resolveCommandCooldownMs,
} from "@sbr/guild-config";
import {
  AutomodRunner,
  createGameCommandBus,
  AUTOMOD_SETTING_KEY,
  ESCALATION_SETTING_KEY,
  memberRecordSource,
  ModerationServiceImpl,
  RELAY_SYNC_SETTING_KEY,
  type ModLogSink,
  type StaffAlertSink,
} from "@sbr/moderation";
import {
  ItemCatalog,
  CoflnetHistory,
  MarketHistoryServiceImpl,
  MarketServiceImpl,
  NetworthServiceImpl,
  PricingServiceImpl,
  summariseNetworth,
  type NetworthEngine,
} from "@sbr/pricing";
import { ProgressionServiceImpl, type ProfileProvider, type SkyblockProfileData } from "@sbr/progression";
import { AnalyticsServiceImpl, createDomainMetrics } from "@sbr/analytics";
import {
  CommandDispatcher,
  InGameDispatcher,
  buildBridgeRegistry,
  type CapabilityChecker,
  type HandlerDeps,
  type LfgAnnouncer,
  type UsageSink,
} from "@sbr/commands-bridge";
import { BridgeService } from "@sbr/bridge";
import {
  createCallMeter,
  createLogger,
  curateStatus,
  HealthRegistry,
  installMeterLog,
  pingCheck,
  type CallMeter,
  type Logger,
} from "@sbr/observability";
import {
  closeRedis,
  createRedisAdapters,
  getRedis,
  pingRedis,
  startHeartbeat,
  type EventReminderMessage,
  type ModAckMessage,
  type ModBusMessage,
} from "@sbr/redis";
import { randomUUID } from "node:crypto";
import {
  err,
  MemberRole,
  ok,
  type DiscordDirectory,
  type GoalRepository,
  type GuildRosterSource,
  type PlaytimeSource,
  type LevelUpAnnouncerPort,
  type MilestoneAnnouncerPort,
  type ReminderPort,
  type FiringLedger,
  type TicketConfigService,
  type PlayerLookup,
  type ProgressMetric,
  type TextScreen,
  type EmbedView,
} from "@sbr/shared-types";
import { ProfileNetworthCalculator } from "skyhelper-networth";
import { BridgeGuardImpl, FloodControlImpl, WordlistFilterImpl } from "./adapters.js";
import { applicantStatsSource, skykingsScammerLookup } from "./screening.js";
import { createBridgeEnforcer } from "./enforcement-effector.js";
import type { PlaySessionSink } from "@sbr/playtime";
import type { TicketGateway } from "./tickets.js";
import type { RoleMenuGateway } from "./role-menus.js";
import type { StickyKeeper } from "./sticky.js";
import type { TriggerRunner } from "./triggers.js";
import type { EventBoardGateway } from "./event-board.js";
import type { LeaderboardDigest } from "./leaderboard-digest.js";
import type { WelcomeProfile } from "./welcome.js";

export interface BridgeApp {
  readonly config: AppConfig;
  readonly log: Logger;
  /** Upstream call counts, latencies and rate-limit hits. See `createCallMeter`. */
  readonly meter: CallMeter;
  readonly dispatcher: CommandDispatcher;
  /**
   * The same services the slash handlers get. Exposed because persistent
   * buttons (RSVP, run sign-up) bypass the dispatcher — there is no command
   * name to look up — but must reach identical code paths.
   */
  readonly handlerDeps: HandlerDeps;
  /**
   * Guild-chat `!` commands. A separate object from `dispatcher` because the
   * in-game surface is an allow-listed, per-IGN-cooled, one-line-output subset
   * of it — not another caller of the same entry point.
   */
  readonly inGame: InGameDispatcher;
  /** The relay pipeline used by the Discord/in-game transport adapters. */
  readonly bridge: BridgeService;
  /**
   * Automod, for the Discord side.
   *
   * The relay carries its own gate for guild chat; this is the same runner
   * exposed so the transport can judge every message in the server, not only
   * the ones headed for the bridge channel. One instance, one policy, two
   * choke-points.
   */
  readonly automod: AutomodRunner;
  /**
   * Join-request screening. Held by the app rather than the transport because
   * the Mineflayer session is rebuilt on every reconnect and the screening
   * service holds no session state — only clients and policy.
   */
  readonly screening: ScreeningService;
  /**
   * The announcement queue. Exposed on the app rather than reached for in the
   * transport so the sweeper can be handed a fake in tests without a database.
   */
  readonly milestones: MilestoneAnnouncerPort;
  /** The level-up queue, exposed for the same reason as `milestones`. */
  readonly levelUps: LevelUpAnnouncerPort;
  /**
   * Where closed play sessions go. Optional so a deployment without a database
   * still measures playtime for `/online` — the tracker is in memory and the
   * live card needs nothing else; only the history is lost.
   */
  readonly playSessions?: PlaySessionSink;
  /** The reminder store, exposed so the sweeper can be handed a fake. */
  readonly reminders: ReminderPort;
  /** The goal store, exposed so the watcher can be handed a fake. */
  readonly goals: Pick<GoalRepository, "listUnachieved" | "markAchieved">;
  /** The freshest snapshot reading of one metric — what the watcher compares against. */
  goalValue(minecraftUuid: string, metric: ProgressMetric): Promise<number | null>;
  /** A linked member's IGN, for the card the watcher posts. */
  ignForDiscordId(discordId: string): Promise<string | null>;
  /** The guild's canned replies, for `/tag` and the autoresponder. */
  readonly tags: Pick<TicketConfigService, "listTags">;
  /**
   * "Has this trigger already fired?", asked atomically.
   *
   * Exposed on the app rather than reached for inside the transport because the
   * transport should be handed its ports, and because a starboard that reposts
   * once is the single property of this feature worth being able to fake in a
   * test.
   */
  readonly firings: FiringLedger;
  /**
   * The trigger runner, late-bound like the sticky keeper: it acts on messages
   * in the community server, so it cannot exist before the client does. Bound
   * back so a config broadcast can drop its cached rules — otherwise a rule
   * switched off in the panel keeps firing for up to a minute.
   */
  setTriggers(runner: TriggerRunner | null): void;
  readonly triggers: TriggerRunner | null;
  /** Resolve a Discord guild snowflake to the internal Guild.id used by services. */
  resolveGuild(discordGuildId: string): Promise<string | null>;
  /**
   * IGN → uuid. Exposed because the join notice's Accept button has only a name
   * to work with — the message that carried it may be minutes old and the
   * screening row it belongs to is looked up by whatever Mojang says now.
   */
  readonly players: PlayerLookup;
  /**
   * May this Discord member work the guild door and roster from a button?
   *
   * Deliberately the *same* answer as `/join-accept`: it reads the floor the
   * guild set for that command on the Permissions card, defaulting to MODERATOR.
   * One setting for both surfaces, because a guild that lowers the command and
   * then finds the buttons still refuse has been lied to about what it
   * configured.
   */
  canManageRoster(guildId: string, discordId: string): Promise<boolean>;
  /**
   * Count a Discord message towards XP. Separate from the relay so a message
   * anywhere in the server counts, not only one in the bridge channel.
   */
  creditDiscordMessage(guildId: string, discordId: string, text: string): Promise<void>;
  /**
   * Count a guild-chat line towards XP, resolving the speaker's IGN to a linked
   * account first. An unlinked IGN earns nothing: XP is attributed to a platform
   * member and a chat line alone cannot name one.
   */
  creditGuildChat(guildId: string, ign: string, text: string): Promise<void>;
  /**
   * Hand the composition the live `/g online` reader once the Mineflayer
   * session exists.
   *
   * Late-bound because the dependency runs backwards from everything else here:
   * the transport is built *from* the app, so it cannot be a constructor
   * argument. Until it is set — and whenever the bridge is down — `/online`
   * reports that honestly rather than showing an empty guild.
   */
  setRosterSource(source: GuildRosterSource | null): void;
  /**
   * Hand the composition the live playtime tracker, once the Mineflayer session
   * exists.
   *
   * Late-bound like the roster, and unset means nobody is playing rather than a
   * frozen list: a card that keeps counting up through an outage is a lie the
   * reader has no way to catch.
   */
  setPlaytimeSource(source: PlaytimeSource | null): void;
  /**
   * Hand the composition a live view of the two sockets, for the heartbeat.
   *
   * Late-bound for the same reason as the roster: the transport is built from
   * the app. Until it is set the heartbeat still fires — a process that is up
   * but not yet connected is exactly what the Health page should show, and
   * withholding the beat until ready would render that as DOWN.
   */
  setStatusSource(source: (() => BridgeStatusDetails) | null): void;
  /**
   * The ticket gateway, once the client exists.
   *
   * Late-bound like the board, and readable afterwards because two things
   * outside the transport need it: the panel, which asks for a ticket panel to
   * be published and wants a real answer rather than a hopeful one, and the
   * sweep, which asks what to do with a ticket nobody has answered.
   */
  setTickets(gateway: TicketGateway | null): void;
  readonly tickets: TicketGateway | null;
  /**
   * The event tracker board, handed over by the transport for the same reason
   * as the ticket gateway: every one of its side effects is a message in the
   * community server, and the workers' board pass reaches it over the loopback
   * API rather than through Discord.
   */
  setEventBoard(gateway: EventBoardGateway | null): void;
  readonly eventBoard: EventBoardGateway | null;
  setLeaderboardDigest(digest: LeaderboardDigest | null): void;
  readonly leaderboardDigest: LeaderboardDigest | null;
  /**
   * Self-service role menus, late-bound for the same reason: publishing one is
   * a message in the community server, and the panel asks for it over the
   * loopback API rather than through Discord.
   */
  setRoleMenus(gateway: RoleMenuGateway | null): void;
  readonly roleMenus: RoleMenuGateway | null;
  /**
   * Sticky messages, late-bound for the same reason: reposting one is a message
   * in the community server, and `/sticky` on the staff bot reaches it over the
   * loopback API rather than through Discord.
   */
  setSticky(keeper: StickyKeeper | null): void;
  readonly sticky: StickyKeeper | null;
  /**
   * What the bot can see of the Discord server, for `/whois` and
   * `/serverinfo`. Late-bound like the rest; until it is set both commands
   * report that they cannot answer rather than answering emptily.
   */
  setDiscordDirectory(directory: DiscordDirectory | null): void;
  /**
   * Where a `/lfg` request is sent, once the client exists.
   *
   * Late-bound like the directory: the request itself is offline code that has
   * already decided the channel, the ping role and the card, and this is the
   * one step that needs a socket. Until it is set a post fails rather than
   * silently succeeding, and the member is told so.
   */
  setLfgAnnouncer(announcer: LfgAnnouncer | null): void;
  /**
   * Arrivals and departures, published by the admin bot. This process greets
   * them: a member is addressed by the bot they interact with.
   */
  readonly memberBus: ReturnType<typeof createRedisAdapters>["memberBus"];
  /**
   * The facts a welcome template can ask for beyond what Discord sends.
   *
   * Only called when a template actually uses `{ign}`, `{guildRank}` or
   * `{level}` — the greeter checks before asking, so an ordinary welcome costs
   * no queries at all.
   */
  welcomeProfile(guildId: string, discordId: string): Promise<WelcomeProfile | null>;
  /**
   * IGN → the Discord account that verified it, or null when nobody has.
   *
   * Guild-agnostic, like every other read of a link: a link is to a person,
   * not to a server.
   */
  linkedDiscordIdForIgn(ign: string): Promise<string | null>;
  /**
   * Hand the composition somewhere to put moderation commands arriving on the
   * bus.
   *
   * Late-bound like the roster, and for the same reason: the paced queue that
   * actually types these lives in the transport, which is built from the app.
   * The subscription itself is held here so Redis stays out of the transport
   * and so an unset sink is a no-op rather than a lost connection — commands
   * published before the bridge is up are dropped deliberately, since a
   * punishment that waits for a boot is one nobody is expecting any more.
   */
  /**
   * Where a moderation instruction goes once it reaches this process.
   *
   * Handed the whole message rather than `(guildId, command)`, because the
   * `correlationId` is what lets the transport answer for the command. It used
   * to be dropped here, which is why nothing anywhere could tell a `/g kick`
   * Hypixel ran from one it threw away.
   */
  setGameCommandSink(sink: ((message: ModBusMessage) => void) | null): void;
  /** Say what became of one instruction, for whoever is waiting on it. */
  ackGameCommand(ack: Omit<ModAckMessage, "kind">): Promise<void>;
  /**
   * Hand the composition somewhere to put event reminders arriving on the
   * bridge bus.
   *
   * Late-bound for the same reason the game-command sink is: posting needs the
   * Discord client, which is built from the app. An unset sink drops the
   * reminder with a log line, which is the honest outcome — the reminder is
   * about to be stale, and there is nothing to queue it into.
   */
  setEventReminderSink(sink: ((message: EventReminderMessage) => void) | null): void;
  /**
   * Where moderation-log cards go, once the client exists.
   *
   * Late-bound like every other poster here. This process is the one that runs
   * automod, so it is the one that issues the punishments nobody typed - and
   * those are precisely the moderation events staff have no other way to see
   * happen. An unset poster drops the card with a log line rather than failing
   * the punishment.
   */
  setModLogPoster(post: ((channelId: string, embed: EmbedView) => Promise<boolean>) | null): void;
  /**
   * Record a moderation action that happened in-game, as parsed from Hypixel's
   * own guild-chat notices.
   *
   * Routed through `ModerationService.recordExternalAction`, which records
   * rather than issues — the distinction that used to be kept by bypassing the
   * service entirely. Issuing it would relay the kick straight back into the
   * game the notice came from, a kick echoing into a second kick; recording it
   * writes the same row and then carries out the Discord half the game cannot
   * reach. That half is the point: without it, somebody kicked from the guild
   * in game kept their Discord membership, their roles and their access, and
   * the only trace was a row on a page nobody had reason to open.
   */
  recordInGameAction(guildId: string, notice: InGameModAction): Promise<void>;
  shutdown(): Promise<void>;
}

/** An action Hypixel announced in guild chat, ready to be recorded. */
export interface InGameModAction {
  readonly type: "KICK" | "MUTE" | "UNMUTE";
  /** The target's IGN. Linked or not — an unlinked member is still moderated. */
  readonly targetIgn: string;
  /** The staff member's IGN, when the notice named one. */
  readonly actorIgn: string | null;
  readonly durationSeconds: number | null;
}

/** Whatever the transport can say about itself; forwarded verbatim to Redis. */
export type BridgeStatusDetails = Readonly<Record<string, string | number | boolean | null>>;

export async function createBridgeApp(): Promise<BridgeApp> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, name: "bridge-bot" });

  // Prisma connects lazily, so a wrong or absent Postgres would otherwise only
  // show up later as an endless drip of failing queries. Check once, up front.
  await assertDatabaseReady();
  const redis = await getRedis();
  const adapters = createRedisAdapters(redis, { playerWindowMs: config.hypixel.playerWindowMs });

  /**
   * Counts and latencies for the two APIs we do not own.
   *
   * One per process, shared by everything that talks upstream, and reported once
   * a minute as `upstream throughput`. It exists to answer one question — is
   * there room to push harder — with a number instead of an opinion.
   */
  const meter = createCallMeter();
  installMeterLog(meter, log);

  const hypixel = new HypixelClient({
    ...(config.hypixel.apiKey ? { apiKey: config.hypixel.apiKey } : {}),
    meter,
    cache: adapters.hypixelCache,
    // The self-imposed per-player floor. Absent in production mode, where the
    // cache TTL is the only floor and the client falls back to `unlimitedPlayers`.
    ...(adapters.playerLimiter ? { playerLimiter: adapters.playerLimiter } : {}),
    rateGate: adapters.rateGate,
    logger: log,
  });

  // `floors` matters most here: this is the process that asks `hasCapability`
  // for every relayed message, so it is where a guild's configured floors have
  // to be in force rather than the defaults.
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
    floors: rolePolicyReader,
    // Auto-roles hear about links and completed events promptly rather than
    // waiting for the reconciler's daily sweep to notice.
    rolesDirty: roleDirty,
    logger: log,
  });

  // Real networth via skyhelper-networth (museum omitted here ⇒ honest estimate).
  const engine: NetworthEngine = {
    async compute({ profile, museum, bankBalance }) {
      const calc = new ProfileNetworthCalculator(
        profile as Record<string, unknown>,
        (museum ?? undefined) as Record<string, unknown> | undefined,
        bankBalance ?? 0,
      );
      return summariseNetworth(await calc.getNetworth());
    },
  };
  const networth = new NetworthServiceImpl({ engine, logger: log });

  // Profile provider over the real Skyblock profiles endpoint. Stats are not
  // computed here — the provider hands over the raw member blob and the
  // progression service derives skills/slayers/dungeons/weight from it.
  const toProfileData = (p: SkyblockProfileDTO): SkyblockProfileData => ({
    profileId: p.profileId,
    cuteName: p.cuteName,
    gameMode: p.gameMode,
    rawMember: p.member,
    networthEngineInput: { profile: p.member, bankBalance: p.bankBalance },
    readableSections: p.readableSections,
    // Museum isn't fetched here, so an exact valuation always requires it.
    requiredSections: [...p.readableSections, "museum"],
  });

  const profiles: ProfileProvider = {
    async getSelectedProfile(uuid, profileId) {
      const profile = await hypixel.getSkyblockProfile(uuid, profileId);
      if (!profile.ok) return err(profile.error);
      return ok({ ...profile.value, data: toProfileData(profile.value.data) });
    },
    async listProfiles(uuid) {
      const all = await hypixel.getSkyblockProfiles(uuid);
      if (!all.ok) return err(all.error);
      return ok({ ...all.value, data: all.value.data.map(toProfileData) });
    },
  };
  const progression = new ProgressionServiceImpl({
    profiles,
    networth,
    repo: progressionRepository,
    // `/goal` — targets a member set for themselves. Optional on the port; the
    // bridge is where they are set and read, so it is wired here.
    goals: goalRepository,
    // `/milestones` measures a member against what this guild recognises, so it
    // needs the definitions the panel edits — read-only here; the bots never
    // write configuration.
    definitions: milestoneDefinitionRepository,
    // Upgrade advice reads prices out of the sweep cache only. A cold cache
    // costs a price tag, not the advice — never a live auction call, which
    // would put a Hypixel round-trip behind every suggestion.
    prices: {
      async lowestBin(itemId) {
        return (await adapters.bins.get(itemId))?.price ?? null;
      },
    },
    logger: log,
  });

  // IGN → uuid, so `/stats <someone else>` works without a link on file.
  const players: PlayerLookup = {
    async resolveIgn(ign) {
      const found = await hypixel.resolveUuid(ign);
      // Mojang's casing wins over whatever the member typed.
      return found === null ? null : { uuid: found.uuid, ign: found.name };
    },
  };

  // Prices come only from the worker-populated cache — a bazaar sweep per
  // `/price` invocation would blow the Hypixel budget in minutes.
  const pricing = new PricingServiceImpl({ source: adapters.priceSource, logger: log });

  // The bazaar is one cached upstream call so it can be read live; BIN data
  // comes only from what the auction-sweep job left behind.
  const market = new MarketServiceImpl({
    bazaar: hypixel,
    bins: adapters.bins,
    auctions: hypixel,
    catalog: new ItemCatalog({ resources: hypixel }),
    logger: log,
  });
  // Price history is Coflnet's, not ours — a third party we do not run, wired
  // behind its own cache and breaker so its uptime cannot reach the prices
  // above it. `fetch` is adapted here rather than inside the client so the
  // client stays a pure function of its transport and its tests need no network.
  const history = new MarketHistoryServiceImpl({
    provider: new CoflnetHistory({
      logger: log,
      fetch: {
        async get(url, headers) {
          const res = await fetch(url, { headers: { accept: "application/json", ...headers } });
          // A body that is not JSON is a gateway page, not a series; the client
          // reads the status first and treats an unparseable body as no data.
          const json = await res.json().catch(() => null);
          return { status: res.status, json };
        },
      },
    }),
    logger: log,
  });

  const community = new CommunityServiceImpl({
    repo: communityRepository,
    rolesDirty: adapters.rolesDirty,
    logger: log,
  });
  // Roster enrichment reads the Phase 2 member cache and stored snapshots, never
  // Hypixel: `/perm info` on a five-stack would otherwise be five live calls.
  const perms = new PermServiceImpl({
    repo: permRepository,
    directory: guildMemberDirectory,
    progress: memberProgressSource,
    links: linkDirectory,
    logger: log,
  });
  // The bridge asks "am I suspended?" on every relayed line, so its config is
  // cached hard. Publishing and subscribing is what keeps that cache from being
  // the reason a panel toggle appears to do nothing for ten seconds.
  const guildConfig = new GuildConfigServiceImpl({
    repo: guildConfigRepository,
    broadcast: adapters.configBus,
    logger: log,
  });

  // Screening. Every dependency is optional at the domain boundary, so a
  // missing SkyKings key degrades to "every applicant is unchecked" — recorded
  // honestly and held for staff — rather than to an unguarded door.
  const skykings = new SkykingsClient({ apiKey: config.skykings.apiKey, fetch: fetchHttp, logger: log });
  const screening = new ScreeningService({
    repo: screeningRepository,
    scammer: skykingsScammerLookup(skykings),
    stats: applicantStatsSource({ hypixel, progression, skykings, logger: log }),
    history: screeningHistorySource,
    policy: screeningPolicySource,
    links: { discordIdForUuid: identityRepository.findMinecraftOwnerDiscordId },
    logger: log,
  });

  const analytics = new AnalyticsServiceImpl({ buffer: adapters.analyticsBuffer, logger: log });
  const metrics = createDomainMetrics({ analytics, surface: "BRIDGE_BOT", logger: log });
  // XP counts activity; it never awards inline. The cooldown gate is the same
  // Redis one the dispatcher uses, under its own `xp:` key space, so an XP
  // cooldown can never eat a command cooldown or vice versa.
  const xp = new XpService({ repo: xpRepository, activity: activitySink, cooldowns: adapters.cooldowns, logger: log });
  // Read-only over data the other services already maintain, so it needs no
  // cooldown gate of its own beyond the command cooldown.
  const leaderboards = new LeaderboardService(leaderboardSource);
  const capabilities: CapabilityChecker = { can: (g, u, c) => identity.hasCapability(g, u, c) };
  const usage: UsageSink = {
    async capture(u) {
      await analytics.capture(u);
      // Command XP hangs off the usage sink rather than the dispatcher so both
      // surfaces are covered by one hook — and only successful, attributed
      // invocations count, so a failed command cannot be farmed.
      if (u.success && u.guildId !== null && u.discordId !== null) await xp.recordCommand(u.guildId, u.discordId);
    },
  };

  // Indirection, not a mutable dep: the handlers hold this object for the life
  // of the process while the session behind it comes and goes with reconnects.
  let liveRoster: GuildRosterSource | null = null;
  const roster: GuildRosterSource = {
    async online() {
      return liveRoster === null ? null : liveRoster.online();
    },
  };

  // Same indirection as the roster, and for the same reason: the tracker lives
  // in the transport, which is built from this object. A bridge that is down
  // reports nobody playing rather than stale sessions.
  let livePlaytime: PlaytimeSource | null = null;
  const playtime: PlaytimeSource = {
    async playing() {
      return livePlaytime === null ? [] : livePlaytime.playing();
    },
  };

  let liveTickets: TicketGateway | null = null;
  let liveEventBoard: EventBoardGateway | null = null;
  let liveDigest: LeaderboardDigest | null = null;
  let liveRoleMenus: RoleMenuGateway | null = null;
  let liveSticky: StickyKeeper | null = null;
  let liveTriggers: TriggerRunner | null = null;
  let liveDirectory: DiscordDirectory | null = null;
  let liveAnnouncer: LfgAnnouncer | null = null;
  // False rather than a throw while unattached: the caller turns this into the
  // sentence the member reads, and "couldn't post that" is true either way.
  const lfgAnnouncer: LfgAnnouncer = {
    async announce(input) {
      return liveAnnouncer === null ? false : liveAnnouncer.announce(input);
    },
  };
  // A thrown error rather than a null answer while unattached — the window is
  // the few hundred ms between composition and login, and "Discord has no such
  // account" would be a claim about the world instead of about our own wiring.
  const discord: DiscordDirectory = {
    async lookupUser(guildId, userId) {
      if (liveDirectory === null) throw new Error("discord directory not attached yet");
      return liveDirectory.lookupUser(guildId, userId);
    },
    async guildInfo(guildId) {
      if (liveDirectory === null) throw new Error("discord directory not attached yet");
      return liveDirectory.guildInfo(guildId);
    },
  };
  // A member's own record, over the same audit tables the admin bot writes —
  // read-only, one member at a time, and no escalation policy needed beyond the
  // one the warning ladder already reads, so `/me` can say what the next warning
  // would cost.
  // The member's own event placings, over the same score rows the tracker
  // board is drawn from. Read-only and one member at a time, like `record`.
  const podiums = memberPodiumSource({ repo: podiumRepository });

  const record = memberRecordSource({
    repo: moderationRepository,
    escalation: { readPolicy: (guildId) => guildConfigRepository.getSetting(guildId, ESCALATION_SETTING_KEY) },
  });

  // The same compiled filter the relay uses, narrowed to a yes/no. Sharing the
  // instance rather than building a second one is the point: a quote the bot
  // says and a message a member relays are held to one set of rules, warmed by
  // one cache, and cannot drift apart on a stale copy.
  const wordlistFilter = new WordlistFilterImpl(undefined, metrics);
  const screen: TextScreen = {
    async isClean(guildId, text) {
      const verdict = await wordlistFilter.check(guildId, text);
      return verdict.action === "ALLOW";
    },
  };

  // The two sockets this process holds, read through the same late-bound source
  // the heartbeat uses. Declared here rather than beside the heartbeat because
  // `/health` needs it too, and one view of the transport is the point — a
  // second accessor would be a second thing to keep true.
  let liveStatus: (() => BridgeStatusDetails) | null = null;
  const flag = (key: string): boolean => liveStatus?.()[key] === true;

  /**
   * The member bot's own registry.
   *
   * Until now only the admin bot and the workers registered probes, because
   * only they had a Health page to feed. `/health` gives this process the same
   * obligation from the other end: a member asking "is it me or is it you" is
   * asking about the two sockets *this* process holds, and no other process can
   * answer that.
   *
   * Postgres and Redis are registered even though the card never names them.
   * `curateStatus` counts them, and that count is what stops `/health` saying
   * all clear during a database outage — the one failure the card exists to
   * prevent being wrong about.
   */
  const health = new HealthRegistry();
  health.register({
    name: "discord",
    // The gateway's own round-trip, which discord.js reports as -1 until the
    // first heartbeat lands. Reported as unknown rather than as zero latency.
    async check() {
      const ping = liveStatus?.()["gatewayPingMs"];
      const latencyMs = typeof ping === "number" && ping >= 0 ? ping : null;
      return { status: flag("discordReady") ? "ok" : "down", latencyMs };
    },
  });
  health.register({
    name: "bridge",
    // Spawned, not merely configured. A Mineflayer session mid-reconnect relays
    // nothing, and a card that called that "up" would send a member to staff to
    // report a bridge we already know is down.
    async check() {
      return { status: flag("mcSpawned") ? "ok" : "down", latencyMs: null };
    },
  });
  health.register(hypixelCheck(hypixel));
  health.register(pingCheck("postgres", pingDb));
  health.register(pingCheck("redis", pingRedis));

  const handlerDeps: HandlerDeps = {
    identity,
    progression,
    players,
    pricing,
    market,
    history,
    community,
    perms,
    roster,
    playtime,
    config: guildConfig,
    analytics,
    xp,
    leaderboards,
    record,
    podiums,
    screen,
    tallies: adapters.tallies,
    // Curated on the way out, not on the way to the card. The handler is handed
    // a shape with no field for a probe's detail, so no future edit to the
    // renderer can put a hostname or a Prisma error in front of a member.
    status: { status: async () => curateStatus(await health.run()) },
    discord,
    // The week behind `/serverinfo`. Read-only and guild-wide, so it needs
    // none of the ports the member-scoped sections above are narrowed from.
    serverActivity: serverActivityRepository,
    lfgAnnouncer,
    reminders: reminderRepository,
    tags: ticketConfigRepository,
    logger: log,
  };

  // One source shared by both dispatchers: a guild that shortened `/lfg` means
  // it in guild chat too, and two objects reading the same key would only be a
  // way for the two surfaces to disagree.
  const cooldownPolicy = {
    async resolveMs(guildId: string, command: string, specMs: number): Promise<number> {
      const policy = parseCooldowns(await guildConfigRepository.getSetting(guildId, COOLDOWN_SETTING_KEY));
      return resolveCommandCooldownMs(policy, command, specMs);
    },
  };

  const dispatcher = new CommandDispatcher({
    registry: buildBridgeRegistry(),
    cooldowns: adapters.cooldowns,
    cooldownPolicy,
    capabilities,
    handlerDeps,
    logger: log,
    usage,
  });

  // Guild chat gets its own dispatcher rather than sharing the Discord one,
  // because its authorization model is different: InGameDispatcher decides what
  // is reachable (the `inGame` allow-list) and who has to be linked, so the
  // capability gate underneath it is already satisfied by the time a command
  // gets here. Registry, handlers and services are the same objects.
  const inGame = new InGameDispatcher({
    dispatcher: new CommandDispatcher({
      registry: dispatcher.commands,
      cooldowns: adapters.cooldowns,
      cooldownPolicy,
      capabilities: { async can() { return true; } },
      handlerDeps,
      logger: log,
      usage,
    }),
    identity: { resolveDiscordIdByIgn: identityRepository.findDiscordIdByIgn },
    cooldowns: adapters.cooldowns,
    logger: log,
  });

  // Automod needs somewhere to send what it decides, and the answer has to be
  // the same service the admin bot uses — otherwise an automod mute would skip
  // escalation, the audit trail and the in-game relay sync, and a member would
  // have two histories depending on who muted them. Built here rather than
  // passed in because bridge-bot is the only process that sees guild chat.
  // Declared ahead of the moderation service because that service now asks
  // whether a guild command can actually be delivered before reporting a
  // punishment enforced. The sink is attached when the Minecraft session
  // spawns; until then a `/g kick` has nowhere to go, and saying so is the
  // whole point.
  let gameCommandSink: ((message: ModBusMessage) => void) | null = null;
  let modLogPost: ((channelId: string, embed: EmbedView) => Promise<boolean>) | null = null;

  /**
   * The command line behind each correlation id still awaiting a verdict.
   *
   * The ack carries the id and the outcome but not the command — the publisher
   * already knows what it sent — and the relay strip needs the text, since
   * "REFUSED_INGAME" beside nothing is not a monitor. Entries are dropped on the
   * first non-`TYPED` answer, and bounded so a bridge that somehow never hears
   * one cannot grow this without limit.
   */
  const outboundCommands = new Map<string, string>();
  const OUTBOUND_MEMORY = 200;

  /**
   * The answer half of the moderation bus.
   *
   * Best effort by design: a failed ack costs the publisher a timeout and a
   * PENDING row, which the sweep settles. Failing the command itself over it
   * would be worse — the kick may well have landed.
   */
  async function publishAck(ack: Omit<ModAckMessage, "kind">): Promise<void> {
    // Every answer passes through here, which makes it the one place the relay
    // strip can be written from without a second, subtly different notion of
    // what "settled" means.
    const command = outboundCommands.get(ack.correlationId);
    if (command !== undefined) {
      await adapters.relayLog.record(ack.guildId, {
        at: new Date().toISOString(),
        command,
        correlationId: ack.correlationId,
        outcome: ack.outcome,
        detail: ack.detail,
      });
      if (ack.outcome !== "TYPED") outboundCommands.delete(ack.correlationId);
    }
    try {
      await adapters.modBus.publishAck({ ...ack, kind: "GAME_COMMAND_ACK" });
    } catch (error) {
      log.warn("guild command ack could not be published", {
        guildId: ack.guildId,
        outcome: ack.outcome,
        error: String(error),
      });
    }
  }

  /**
   * The guild's moderation log, same contract as the admin bot's.
   *
   * Both processes write to it deliberately: a member is warned by a staffer on
   * one bot and muted by automod on the other, and a log that held only half of
   * that would be worse than none - it would look complete.
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

  /**
   * Where "this punishment did not land" goes.
   *
   * The admin bot has had one of these all along; this process has not, so an
   * automod mute that failed to enforce was a warning in a log file nobody
   * reads. It matters more now: the in-game kick mirror runs here, and every
   * case it declines to mirror is a member still sitting in Discord after being
   * kicked from the guild. Nobody typed anything, so nobody is waiting for a
   * reply — the alert is the only way anyone finds out.
   *
   * Staff first, moderation log second, ordered by who needs to act.
   */
  const staffAlerts: StaffAlertSink = {
    async alert(guildId, text) {
      if (modLogPost === null) return;
      const row = await guildConfigRepository.get(guildId).catch(() => null);
      for (const slot of ["staff", "modlog"] as const) {
        const channelId = row?.channels[slot] ?? null;
        if (channelId !== null && (await modLogPost(channelId, { description: text, color: "WARNING" }))) return;
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
    enforcement: adapters.enforcement,
    // The Discord half, over the loopback hop to the admin bot.
    //
    // Without this, every automod punishment issued here was a Redis mirror
    // entry and nothing else: the member kept talking in Discord, because the
    // mirror is a cache the relay reads and not a call that silences anybody.
    // The admin bot owns privileged writes to the member server, so this asks
    // it, the same way a role press and a ticket close do.
    modLog,
    staffAlerts,
    discord: createBridgeEnforcer({
      baseUrl: config.internalApi.baseUrl,
      token: config.internalApi.token,
      logger: log,
    }),
    botCaps: { async canPerform() { return true; } },
    metrics,
    escalation: { readPolicy: (guildId) => guildConfigRepository.getSetting(guildId, ESCALATION_SETTING_KEY) },
    // Automod's guild commands take the same round trip as the admin bot's,
    // even though the subscriber that types them is in this very process. The
    // alternative — calling the sink directly — would skip the ack channel, and
    // an automod kick would be the one punishment nobody could tell had landed.
    gameCommands: createGameCommandBus({
      publish: (message) => adapters.modBus.publish(message),
      subscribeAcks: (onAck) => adapters.modBus.subscribeAcks(onAck),
      live: async (guildId) => {
        if (gameCommandSink !== null) return true;
        log.warn("guild command not sent: no Minecraft session", { guildId });
        return false;
      },
      logger: log,
    }),
    igns: {
      async ignFor(_guildId, discordId) {
        const link = await identityRepository.findPrimaryLinkByDiscordId(discordId).catch(() => null);
        return link?.ign ?? null;
      },
    },
    relaySync: { readRelaySync: (guildId) => guildConfigRepository.getSetting(guildId, RELAY_SYNC_SETTING_KEY) },
    logger: log,
  });

  const automod = new AutomodRunner({
    policy: { readPolicy: (guildId) => guildConfigRepository.getSetting(guildId, AUTOMOD_SETTING_KEY) },
    counters: adapters.automodCounters,
    wordlist: wordlistRepository,
    moderation,
    metrics,
    logger: log,
  });

  const bridge = new BridgeService({
    guard: new BridgeGuardImpl(redis, identity, undefined, log),
    wordlist: wordlistFilter,
    flood: new FloodControlImpl(redis),
    metrics,
    // The guild-chat side.
    //
    // Only `GAME_TO_DISCORD` is judged here. A Discord message has already
    // passed the server-wide hook in the transport by the time it reaches the
    // relay, and running it twice would double its spam counters and could
    // punish it twice for one line.
    //
    // An in-game author is an IGN, so the punishable identity has to be looked
    // up. An unlinked member still has their message stopped and their match
    // logged; what the platform cannot do is punish an account it has no id
    // for, and the runner says so rather than silently doing nothing.
    automod: {
      async check(msg) {
        if (msg.direction !== "GAME_TO_DISCORD") return { blocked: false };
        const discordId = await identityRepository.findDiscordIdByIgn(msg.authorId).catch(() => null);
        // One capability, checked once. `BYPASS_FILTER` is the guild-chat
        // equivalent of a staff role — resolving all six for every relayed line
        // would put half a dozen lookups on the hot path to answer a question
        // most policies never ask.
        const bypass =
          discordId !== null && (await identity.hasCapability(msg.guildId, discordId, "BYPASS_FILTER").catch(() => false));
        return automod.run({
          guildId: msg.guildId,
          surface: "GUILD_CHAT",
          text: msg.content,
          // Guild chat has no structured mentions, so the count is zero rather
          // than a number guessed out of the text.
          mentionCount: 0,
          subject: {
            key: msg.authorId,
            discordId,
            roleIds: [],
            capabilities: bypass ? ["BYPASS_FILTER"] : [],
          },
        });
      },
    },
    logger: log,
  });

  const unsubscribe = await adapters.configBus.subscribe((guildId) => {
    guildConfig.invalidate(guildId);
    // Sticky messages are a settings document, so a panel edit or a `/sticky`
    // on the staff bot reaches this process the same way every other config
    // change does.
    liveSticky?.invalidate(guildId);
    // Trigger rules are a settings document too, and a starboard that keeps
    // running after staff disabled it is the complaint this line prevents.
    liveTriggers?.invalidate(guildId);
    log.debug("guild config invalidated by broadcast", { guildId });
  });

  const unsubscribeMod = await adapters.modBus.subscribe((message) => {
    // Remembered before anything else answers, so a command refused on the spot
    // still reaches the relay strip with the line it was refused for — which is
    // the row an operator most wants to find there.
    if (outboundCommands.size >= OUTBOUND_MEMORY) {
      const oldest = outboundCommands.keys().next();
      if (!oldest.done) outboundCommands.delete(oldest.value);
    }
    outboundCommands.set(message.correlationId, message.command);

    if (gameCommandSink === null) {
      log.warn("moderation command dropped: bridge not connected", { guildId: message.guildId });
      // Answered rather than merely logged. The publisher checked a heartbeat
      // up to 45 seconds old before sending this, so "the session went away in
      // between" is a real race, and silence would cost it a full timeout.
      void publishAck({
        guildId: message.guildId,
        correlationId: message.correlationId,
        outcome: "EXPIRED",
        detail: "the bridge has no Minecraft session",
      });
      return;
    }
    gameCommandSink(message);
  });

  let eventReminderSink: ((message: EventReminderMessage) => void) | null = null;
  const unsubscribeBridge = await adapters.bridgeBus.subscribe((message) => {
    if (eventReminderSink === null) {
      log.warn("event reminder dropped: bridge not connected", {
        guildId: message.guildId,
        eventId: message.eventId,
      });
      return;
    }
    eventReminderSink(message);
  });

  const stopHeartbeat = startHeartbeat(adapters.heartbeat, () => ({
    service: "bridge-bot",
    instance: INSTANCE_ID,
    details: liveStatus?.() ?? { connected: false },
  }));

  return {
    config,
    log,
    meter,
    dispatcher,
    handlerDeps,
    milestones: milestoneAnnouncementRepository,
    levelUps: xpLevelUpAnnouncementRepository,
    playSessions: playSessionSink,
    reminders: reminderRepository,
    goals: goalRepository,
    async goalValue(minecraftUuid: string, metric: ProgressMetric) {
      const latest = await progressionRepository.latestSnapshot(minecraftUuid).catch(() => null);
      return latest?.[metric] ?? null;
    },
    ignForDiscordId: (discordId: string) =>
      identityRepository
        .findPrimaryLinkByDiscordId(discordId)
        .then((link) => link?.ign ?? null)
        .catch(() => null),
    tags: ticketConfigRepository,
    firings: adapters.firings,
    memberBus: adapters.memberBus,
    linkedDiscordIdForIgn: (ign) => identityRepository.findDiscordIdByIgn(ign).catch(() => null),
    async welcomeProfile(guildId, discordId) {
      const [link, snapshots, standing] = await Promise.all([
        identityRepository.findPrimaryLinkByDiscordId(discordId).catch(() => null),
        roleSyncRepository.loadSnapshots(guildId, [discordId]).catch(() => []),
        xp.standing(guildId, discordId).catch(() => null),
      ]);
      // All three are optional on their own: an unlinked member still has a
      // level, and a linked one need not be in the Hypixel guild. The renderer
      // prints an absent token as nothing rather than as "undefined".
      return {
        ign: link?.ign ?? null,
        guildRank: snapshots[0]?.facts.guildRank ?? null,
        level: standing?.level ?? null,
      };
    },
    inGame,
    bridge,
    automod,
    screening,
    resolveGuild: guildRepository.resolveInternalId,
    players,
    async canManageRoster(guildId, discordId) {
      const [role, floor] = await Promise.all([
        rankResolver.getRole(guildId, discordId),
        rolePolicyReader.commandFloor(guildId, "join-accept", MemberRole.MODERATOR),
      ]);
      return meetsFloor(role, floor);
    },
    async creditDiscordMessage(guildId, discordId, text) {
      // Counted where it is credited, because these are the same event seen
      // twice: XP is what the member gets for talking, and the metric is the
      // guild seeing that somebody did. Fire-and-forget, like every metric.
      metrics.discordMessage(guildId);
      await xp.recordMessage(guildId, discordId, "DISCORD_MESSAGE", text);
    },
    async creditGuildChat(guildId, ign, text) {
      const discordId = await identityRepository.findDiscordIdByIgn(ign).catch(() => null);
      if (discordId === null) return;
      await xp.recordMessage(guildId, discordId, "GUILD_CHAT_MESSAGE", text);
    },
    setRosterSource(source) {
      liveRoster = source;
    },
    setPlaytimeSource(source) {
      livePlaytime = source;
    },
    setStatusSource(source) {
      liveStatus = source;
    },
    setTickets(gateway) {
      liveTickets = gateway;
    },
    get tickets() {
      return liveTickets;
    },
    setEventBoard(gateway) {
      liveEventBoard = gateway;
    },
    get eventBoard() {
      return liveEventBoard;
    },
    setLeaderboardDigest(digest) {
      liveDigest = digest;
    },
    get leaderboardDigest() {
      return liveDigest;
    },
    setRoleMenus(gateway) {
      liveRoleMenus = gateway;
    },
    setSticky(keeper) {
      liveSticky = keeper;
    },
    setTriggers(runner) {
      liveTriggers = runner;
    },
    get triggers() {
      return liveTriggers;
    },
    get sticky() {
      return liveSticky;
    },
    setDiscordDirectory(directory) {
      liveDirectory = directory;
    },
    setLfgAnnouncer(announcer) {
      liveAnnouncer = announcer;
    },
    get roleMenus() {
      return liveRoleMenus;
    },
    ackGameCommand: publishAck,
    setGameCommandSink(sink) {
      gameCommandSink = sink;
    },
    setEventReminderSink(sink) {
      eventReminderSink = sink;
    },
    setModLogPoster(post) {
      modLogPost = post;
    },
    async recordInGameAction(guildId, notice) {
      // Best-effort on both ends: the target may not be linked, and the actor is
      // an in-game name that need not correspond to a Discord account at all.
      // Neither absence is a reason to drop the record — an unlinked member's
      // kick is still the guild's history. What the target's link decides is
      // whether the Discord half can happen; the service says so on the row and
      // to staff either way.
      const targetDiscordId = await identityRepository.findDiscordIdByIgn(notice.targetIgn).catch(() => null);
      const actorDiscordId = notice.actorIgn === null
        ? null
        : await identityRepository.findDiscordIdByIgn(notice.actorIgn).catch(() => null);

      const recorded = await moderation.recordExternalAction({
        guildId,
        type: notice.type,
        targetDiscordId,
        targetIgn: notice.targetIgn,
        // The column is non-null, and there is no snowflake to put in it when
        // the action was taken by someone with no linked account. The IGN is
        // preserved in the reason, which is where the page reads it from.
        actorDiscordId: actorDiscordId ?? INGAME_ACTOR,
        actorIgn: notice.actorIgn,
        reason: notice.actorIgn === null
          ? `In-game ${notice.type.toLowerCase()} of ${notice.targetIgn}`
          : `In-game ${notice.type.toLowerCase()} of ${notice.targetIgn} by ${notice.actorIgn}`,
        durationSeconds: notice.durationSeconds,
      });
      if (!recorded.ok) {
        log.error("could not record in-game moderation action", {
          guildId,
          type: notice.type,
          target: notice.targetIgn,
        });
        return;
      }
      log.info("recorded in-game moderation action", {
        guildId,
        type: notice.type,
        target: notice.targetIgn,
        enforcement: recorded.value.enforcement,
      });
    },
    async shutdown() {
      stopHeartbeat();
      await unsubscribe().catch(() => undefined);
      await unsubscribeMod().catch(() => undefined);
      await unsubscribeBridge().catch(() => undefined);
      await Promise.allSettled([closeRedis(), disconnectDb()]);
    },
  };
}

/**
 * Stand-in actor for an in-game action Hypixel did not attribute, or whose
 * staff member has no linked Discord account.
 *
 * A sentinel rather than an empty string so the value is obviously not a
 * snowflake if it ever reaches a mention — an empty actor would render as a
 * broken ping, and a real-looking id would name the wrong person.
 */
const INGAME_ACTOR = "ingame";

/** Per-boot identity in the heartbeat keyspace; see the panel's copy for why. */
const INSTANCE_ID = randomUUID().slice(0, 8);

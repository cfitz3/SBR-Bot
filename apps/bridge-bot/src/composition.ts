/**
 * Bridge-bot composition root — wires the member-command dispatcher to the real
 * adapters. The discord.js gateway + Mineflayer connector call `dispatch(...)`
 * and relay through @sbr/bridge; those transports are the remaining runtime piece
 * (need the libs + a bot token).
 */
import { loadConfig, type AppConfig } from "@sbr/config";
import {
  communityRepository,
  disconnectDb,
  guildConfigRepository,
  guildMemberDirectory,
  guildRepository,
  identityRepository,
  leaderboardSource,
  linkDirectory,
  memberProgressSource,
  permRepository,
  progressionRepository,
  rankResolver,
  screeningHistorySource,
  screeningPolicySource,
  screeningRepository,
  xpRepository,
  activitySink,
} from "@sbr/db";
import { IdentityServiceImpl } from "@sbr/identity";
import { fetchHttp, HypixelClient, type SkyblockProfileDTO } from "@sbr/hypixel";
import { SkykingsClient } from "@sbr/skykings";
import { ScreeningService } from "@sbr/screening";
import { CommunityServiceImpl } from "@sbr/community";
import { PermServiceImpl } from "@sbr/perms";
import { XpService } from "@sbr/xp";
import { LeaderboardService } from "@sbr/leaderboards";
import { GuildConfigServiceImpl } from "@sbr/guild-config";
import {
  ItemCatalog,
  MarketServiceImpl,
  NetworthServiceImpl,
  PricingServiceImpl,
  type NetworthEngine,
} from "@sbr/pricing";
import { ProgressionServiceImpl, type ProfileProvider, type SkyblockProfileData } from "@sbr/progression";
import { AnalyticsServiceImpl } from "@sbr/analytics";
import {
  CommandDispatcher,
  InGameDispatcher,
  buildBridgeRegistry,
  type CapabilityChecker,
  type HandlerDeps,
  type LfgBoard,
  type UsageSink,
} from "@sbr/commands-bridge";
import { BridgeService } from "@sbr/bridge";
import { createLogger, type Logger } from "@sbr/observability";
import { closeRedis, createRedisAdapters, getRedis, startHeartbeat } from "@sbr/redis";
import { randomUUID } from "node:crypto";
import { err, ok, type GuildRosterSource, type PlayerLookup } from "@sbr/shared-types";
import { ProfileNetworthCalculator } from "skyhelper-networth";
import { BridgeGuardImpl, FloodControlImpl, WordlistFilterImpl } from "./adapters.js";
import { applicantStatsSource, skykingsScammerLookup } from "./screening.js";

export interface BridgeApp {
  readonly config: AppConfig;
  readonly log: Logger;
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
   * Join-request screening. Held by the app rather than the transport because
   * the Mineflayer session is rebuilt on every reconnect and the screening
   * service holds no session state — only clients and policy.
   */
  readonly screening: ScreeningService;
  /** Resolve a Discord guild snowflake to the internal Guild.id used by services. */
  resolveGuild(discordGuildId: string): Promise<string | null>;
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
   * Hand the composition a live view of the two sockets, for the heartbeat.
   *
   * Late-bound for the same reason as the roster: the transport is built from
   * the app. Until it is set the heartbeat still fires — a process that is up
   * but not yet connected is exactly what the Health page should show, and
   * withholding the beat until ready would render that as DOWN.
   */
  setStatusSource(source: (() => BridgeStatusDetails) | null): void;
  /** Hand the composition the Discord-backed LFG board once the client exists. */
  setLfgBoard(board: LfgBoard | null): void;
  shutdown(): Promise<void>;
}

/** Whatever the transport can say about itself; forwarded verbatim to Redis. */
export type BridgeStatusDetails = Readonly<Record<string, string | number | boolean | null>>;

export async function createBridgeApp(): Promise<BridgeApp> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, name: "bridge-bot" });
  const redis = await getRedis();
  const adapters = createRedisAdapters(redis);

  const hypixel = new HypixelClient({
    ...(config.hypixel.apiKey ? { apiKey: config.hypixel.apiKey } : {}),
    cache: adapters.hypixelCache,
    rateGate: adapters.rateGate,
    logger: log,
  });

  const identity = new IdentityServiceImpl({ repo: identityRepository, social: hypixel, roles: rankResolver, logger: log });

  // Real networth via skyhelper-networth (museum omitted here ⇒ honest estimate).
  const engine: NetworthEngine = {
    async compute({ profile, museum, bankBalance }) {
      const calc = new ProfileNetworthCalculator(
        profile as Record<string, unknown>,
        (museum ?? undefined) as Record<string, unknown> | undefined,
        bankBalance ?? 0,
      );
      const result = await calc.getNetworth();
      const total = typeof result.networth === "number" ? result.networth : null;
      return { total, breakdown: {} };
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
  const community = new CommunityServiceImpl({ repo: communityRepository, logger: log });
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

  // Same indirection for the LFG board, which additionally needs the Discord
  // client — built from the app, so it cannot be a constructor argument. Before
  // it is set every call is a no-op, which is the right answer: the post is
  // already saved, and only its card in the channel is missing.
  let liveBoard: LfgBoard | null = null;
  const lfgBoard: LfgBoard = {
    async publish(post) {
      await liveBoard?.publish(post);
    },
    async refresh(post) {
      await liveBoard?.refresh(post);
    },
  };

  const handlerDeps: HandlerDeps = {
    identity,
    progression,
    players,
    pricing,
    market,
    community,
    perms,
    roster,
    config: guildConfig,
    analytics,
    lfgBoard,
    xp,
    leaderboards,
    logger: log,
  };

  const dispatcher = new CommandDispatcher({
    registry: buildBridgeRegistry(),
    cooldowns: adapters.cooldowns,
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
      capabilities: { async can() { return true; } },
      handlerDeps,
      logger: log,
      usage,
    }),
    identity: { resolveDiscordIdByIgn: identityRepository.findDiscordIdByIgn },
    cooldowns: adapters.cooldowns,
    logger: log,
  });

  const bridge = new BridgeService({
    guard: new BridgeGuardImpl(redis, identity),
    wordlist: new WordlistFilterImpl(),
    flood: new FloodControlImpl(redis),
    logger: log,
  });

  const unsubscribe = await adapters.configBus.subscribe((guildId) => {
    guildConfig.invalidate(guildId);
    log.debug("guild config invalidated by broadcast", { guildId });
  });

  let liveStatus: (() => BridgeStatusDetails) | null = null;
  const stopHeartbeat = startHeartbeat(adapters.heartbeat, () => ({
    service: "bridge-bot",
    instance: INSTANCE_ID,
    details: liveStatus?.() ?? { connected: false },
  }));

  return {
    config,
    log,
    dispatcher,
    handlerDeps,
    inGame,
    bridge,
    screening,
    resolveGuild: guildRepository.resolveInternalId,
    async creditDiscordMessage(guildId, discordId, text) {
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
    setStatusSource(source) {
      liveStatus = source;
    },
    setLfgBoard(board) {
      liveBoard = board;
    },
    async shutdown() {
      stopHeartbeat();
      await unsubscribe().catch(() => undefined);
      await Promise.allSettled([closeRedis(), disconnectDb()]);
    },
  };
}

/** Per-boot identity in the heartbeat keyspace; see the panel's copy for why. */
const INSTANCE_ID = randomUUID().slice(0, 8);

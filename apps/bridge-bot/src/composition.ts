/**
 * Bridge-bot composition root — wires the member-command dispatcher to the real
 * adapters. The discord.js gateway + Mineflayer connector call `dispatch(...)`
 * and relay through @sbr/bridge; those transports are the remaining runtime piece
 * (need the libs + a bot token).
 */
import { loadConfig, type AppConfig } from "@sbr/config";
import { disconnectDb, guildRepository, identityRepository } from "@sbr/db";
import { IdentityServiceImpl } from "@sbr/identity";
import { HypixelClient } from "@sbr/hypixel";
import { NetworthServiceImpl, type NetworthEngine } from "@sbr/pricing";
import { ProgressionServiceImpl, type ProfileProvider } from "@sbr/progression";
import { AnalyticsServiceImpl } from "@sbr/analytics";
import {
  CommandDispatcher,
  buildBridgeRegistry,
  type CapabilityChecker,
  type UsageSink,
} from "@sbr/commands-bridge";
import { BridgeService } from "@sbr/bridge";
import { createLogger, type Logger } from "@sbr/observability";
import { closeRedis, createRedisAdapters, getRedis } from "@sbr/redis";
import { err, ok } from "@sbr/shared-types";
import { ProfileNetworthCalculator } from "skyhelper-networth";
import { BridgeGuardImpl, FloodControlImpl, WordlistFilterImpl } from "./adapters.js";

export interface BridgeApp {
  readonly config: AppConfig;
  readonly log: Logger;
  readonly dispatcher: CommandDispatcher;
  /** The relay pipeline used by the Discord/in-game transport adapters. */
  readonly bridge: BridgeService;
  /** Resolve a Discord guild snowflake to the internal Guild.id used by services. */
  resolveGuild(discordGuildId: string): Promise<string | null>;
  shutdown(): Promise<void>;
}

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

  const identity = new IdentityServiceImpl({ repo: identityRepository, social: hypixel, logger: log });

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

  // Profile provider over the real Skyblock profiles endpoint.
  const profiles: ProfileProvider = {
    async getSelectedProfile(uuid) {
      const profile = await hypixel.getSkyblockProfile(uuid);
      if (!profile.ok) return err(profile.error);
      const p = profile.value.data;
      return ok({
        data: {
          profileId: p.profileId,
          cuteName: p.cuteName,
          gameMode: p.gameMode,
          skillAverage: null,
          catacombsLevel: null,
          senitherWeight: null,
          networthEngineInput: { profile: p.member, bankBalance: p.bankBalance },
          readableSections: p.readableSections,
          // Museum isn't fetched here, so an exact valuation always requires it.
          requiredSections: [...p.readableSections, "museum"],
        },
        freshness: profile.value.freshness,
        source: profile.value.source,
        fetchedAt: profile.value.fetchedAt,
      });
    },
  };
  const progression = new ProgressionServiceImpl({ profiles, networth, logger: log });

  const analytics = new AnalyticsServiceImpl({ buffer: adapters.analyticsBuffer, logger: log });
  const capabilities: CapabilityChecker = { can: (g, u, c) => identity.hasCapability(g, u, c) };
  const usage: UsageSink = { capture: (u) => analytics.capture(u) };

  const dispatcher = new CommandDispatcher({
    registry: buildBridgeRegistry(),
    cooldowns: adapters.cooldowns,
    capabilities,
    handlerDeps: { identity, progression, logger: log },
    logger: log,
    usage,
  });

  const bridge = new BridgeService({
    guard: new BridgeGuardImpl(redis, identity),
    wordlist: new WordlistFilterImpl(),
    flood: new FloodControlImpl(redis),
    logger: log,
  });

  return {
    config,
    log,
    dispatcher,
    bridge,
    resolveGuild: guildRepository.resolveInternalId,
    async shutdown() {
      await Promise.allSettled([closeRedis(), disconnectDb()]);
    },
  };
}

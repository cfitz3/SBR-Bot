/**
 * Workers composition root — assembles the concrete infrastructure adapters
 * (Redis + Prisma) behind the domain ports and builds the JobRunner. This is
 * where the ports meet their real implementations.
 */
import { loadConfig, type AppConfig } from "@sbr/config";
import { assertDatabaseReady, disconnectDb, pingDb, progressionRepository, workerJobLogSink } from "@sbr/db";
import { HypixelClient, type SkyblockProfileDTO } from "@sbr/hypixel";
import { JobRunner } from "@sbr/jobs";
import { NetworthServiceImpl, type NetworthEngine } from "@sbr/pricing";
import {
  ProgressionServiceImpl,
  type ProfileProvider,
  type SkyblockProfileData,
} from "@sbr/progression";
import { err, ok, type ProgressionService } from "@sbr/shared-types";
import { ProfileNetworthCalculator } from "skyhelper-networth";
import { createLogger, HealthRegistry, pingCheck, type Logger } from "@sbr/observability";
import {
  closeRedis,
  createRedisAdapters,
  getRedis,
  pingRedis,
  startHeartbeat,
  type RedisContext,
} from "@sbr/redis";
import { randomUUID } from "node:crypto";

export interface WorkerContext {
  readonly config: AppConfig;
  readonly log: Logger;
  readonly redis: RedisContext;
  readonly adapters: ReturnType<typeof createRedisAdapters>;
  /** The market jobs are the only place a full bazaar/AH read is permitted. */
  readonly hypixel: HypixelClient;
  /**
   * Same progression service the bots use, so a snapshot records exactly the
   * numbers `/stats` would have shown at that moment. Recomputing the metrics
   * here with a second implementation is the surest way to make the charts
   * disagree with the commands.
   */
  readonly progression: ProgressionService;
  readonly runner: JobRunner;
  readonly health: HealthRegistry;
  shutdown(): Promise<void>;
}

export async function createWorkerContext(): Promise<WorkerContext> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, name: "workers" });

  // Prisma connects lazily, so a wrong or absent Postgres would otherwise only
  // show up later as an endless drip of failing queries. Check once, up front.
  await assertDatabaseReady();
  const redis = await getRedis();
  const adapters = createRedisAdapters(redis);

  const hypixel = new HypixelClient({
    ...(config.hypixel.apiKey ? { apiKey: config.hypixel.apiKey } : {}),
    cache: adapters.hypixelCache,
    // Same Redis-backed budget the bots use, so a sweep cannot starve commands.
    rateGate: adapters.rateGate,
    logger: log,
  });

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

  const toProfileData = (p: SkyblockProfileDTO): SkyblockProfileData => ({
    profileId: p.profileId,
    cuteName: p.cuteName,
    gameMode: p.gameMode,
    rawMember: p.member,
    networthEngineInput: { profile: p.member, bankBalance: p.bankBalance },
    readableSections: p.readableSections,
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
    networth: new NetworthServiceImpl({ engine, logger: log }),
    repo: progressionRepository,
    logger: log,
  });

  // Redis lock guards concurrency; Postgres WorkerJobLog records every run.
  const runner = new JobRunner({ lock: adapters.lock, sink: workerJobLogSink, logger: log });

  const health = new HealthRegistry();
  health.register(pingCheck("postgres", pingDb));
  health.register(pingCheck("redis", pingRedis));

  // No config subscription here: the workers hold no GuildConfigService cache to
  // invalidate. The heartbeat still matters — "are the workers running at all"
  // is the first question the Health page's stale-job badges raise.
  const stopHeartbeat = startHeartbeat(adapters.heartbeat, () => ({
    service: "workers",
    instance: INSTANCE_ID,
    details: { env: config.nodeEnv },
  }));

  return {
    config,
    log,
    redis,
    adapters,
    hypixel,
    progression,
    runner,
    health,
    async shutdown() {
      stopHeartbeat();
      await Promise.allSettled([closeRedis(), disconnectDb()]);
    },
  };
}

/** Per-boot identity in the heartbeat keyspace; see the panel's copy for why. */
const INSTANCE_ID = randomUUID().slice(0, 8);

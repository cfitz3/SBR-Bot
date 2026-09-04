/**
 * Guide-bot composition root — the only place in this app that knows what a
 * real adapter is.
 *
 * Deliberately thin, and deliberately narrow: this process advises, so the only
 * upstream it holds is the Hypixel client, and the only reason it holds Redis is
 * the cache and the per-player rate floor in front of that client. It reads no
 * roster, sweeps no auction pages and stores no player state — see
 * docs/GUIDE.md for why that shape is the product rather than a limitation.
 *
 * The command surface lands in a later slice; what exists today is the wiring,
 * so the process can be booted and verified before there is anything to say.
 */
import { loadConfig, type AppConfig } from "@sbr/config";
import { assertDatabaseReady, disconnectDb } from "@sbr/db";
import { fetchHttp, HypixelClient, hypixelCheck } from "@sbr/hypixel";
import {
  createCallMeter,
  createLogger,
  HealthRegistry,
  installMeterLog,
  pingCheck,
  type Logger,
} from "@sbr/observability";
import { closeRedis, createRedisAdapters, getRedis, pingRedis } from "@sbr/redis";
import { pingDb } from "@sbr/db";

export interface GuideApp {
  readonly config: AppConfig;
  readonly log: Logger;
  readonly hypixel: HypixelClient;
  readonly health: HealthRegistry;
  shutdown(): Promise<void>;
}

export async function createGuideApp(): Promise<GuideApp> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, name: "guide-bot" });

  // Same reasoning as the other roots: Prisma connects lazily, so a wrong or
  // absent Postgres would otherwise surface later as a drip of failing queries
  // rather than as a boot failure. Guide's own use of it is small — the link and
  // the selected profile, nothing player-derived — but it is still on the path
  // of every command, so it is checked once, up front.
  await assertDatabaseReady();
  const redis = await getRedis();
  const adapters = createRedisAdapters(redis, { playerWindowMs: config.hypixel.playerWindowMs });

  const meter = createCallMeter();
  installMeterLog(meter, log);

  const hypixel = new HypixelClient({
    ...(config.hypixel.apiKey ? { apiKey: config.hypixel.apiKey } : {}),
    meter,
    http: fetchHttp,
    cache: adapters.hypixelCache,
    // The self-imposed per-player floor, present in `personal` key mode. In
    // `production` mode the cache TTL is the only floor and the client falls
    // back to `unlimitedPlayers` (docs/HYPIXEL_COMPLIANCE.md §2).
    ...(adapters.playerLimiter ? { playerLimiter: adapters.playerLimiter } : {}),
    rateGate: adapters.rateGate,
    logger: log,
  });

  const health = new HealthRegistry();
  health.register(pingCheck("postgres", pingDb));
  health.register(pingCheck("redis", pingRedis));
  // Costs no requests: reports what the last real call observed, which is as old
  // as the last command anybody ran and is honest about being so.
  health.register(hypixelCheck(hypixel));

  return {
    config,
    log,
    hypixel,
    health,
    async shutdown() {
      await Promise.allSettled([closeRedis(), disconnectDb()]);
    },
  };
}

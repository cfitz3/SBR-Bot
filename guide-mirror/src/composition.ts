/**
 * The composition root: every upstream this process holds, constructed in one
 * place so that the list can be checked by reading rather than by grepping.
 *
 * The list is short, and its shortness is the point. This process advises, so
 * the only external service it talks to is Hypixel (plus Mojang, for turning a
 * name into a UUID). It reads no roster, sweeps no auction pages on anybody
 * behalf, walks no chat, and stores no player state — see COMPLIANCE.md for why
 * that shape is the product rather than a limitation.
 */
import { loadConfig, type AppConfig } from "./config.js";
import { assertDatabaseReady, disconnectDb, pingDb } from "./db/index.js";
import { fetchHttp, HypixelClient, hypixelCheck } from "./hypixel/index.js";
import {
  createCallMeter,
  createLogger,
  HealthRegistry,
  installMeterLog,
  pingCheck,
  type Logger,
} from "./log/index.js";
import { closeRedis, createRedisAdapters, getRedis, pingRedis } from "./redis/index.js";

export interface GuideApp {
  readonly config: AppConfig;
  readonly log: Logger;
  readonly hypixel: HypixelClient;
  readonly health: HealthRegistry;
  shutdown(): Promise<void>;
}

export async function createGuideApp(): Promise<GuideApp> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, name: "guide" });

  // Before anything else: a lazy Prisma client would otherwise let the process
  // start clean and fail later, once per query, against a database that is not
  // ours.
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
    // Absent in production-key mode, where the cache TTL is the only floor. The
    // client default is then `unlimitedPlayers`, which says so out loud rather
    // than being a limiter configured to permit everything.
    ...(adapters.playerLimiter ? { playerLimiter: adapters.playerLimiter } : {}),
    rateGate: adapters.rateGate,
    logger: log,
  });

  const health = new HealthRegistry();
  health.register(pingCheck("postgres", pingDb));
  health.register(pingCheck("redis", pingRedis));
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

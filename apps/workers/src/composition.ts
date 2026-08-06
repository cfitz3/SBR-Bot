/**
 * Workers composition root — assembles the concrete infrastructure adapters
 * (Redis + Prisma) behind the domain ports and builds the JobRunner. This is
 * where the ports meet their real implementations.
 */
import { loadConfig, type AppConfig } from "@sbr/config";
import { disconnectDb, pingDb, workerJobLogSink } from "@sbr/db";
import { JobRunner } from "@sbr/jobs";
import { createLogger, HealthRegistry, pingCheck, type Logger } from "@sbr/observability";
import { closeRedis, createRedisAdapters, getRedis, pingRedis, type RedisContext } from "@sbr/redis";

export interface WorkerContext {
  readonly config: AppConfig;
  readonly log: Logger;
  readonly redis: RedisContext;
  readonly adapters: ReturnType<typeof createRedisAdapters>;
  readonly runner: JobRunner;
  readonly health: HealthRegistry;
  shutdown(): Promise<void>;
}

export async function createWorkerContext(): Promise<WorkerContext> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, name: "workers" });
  const redis = await getRedis();
  const adapters = createRedisAdapters(redis);

  // Redis lock guards concurrency; Postgres WorkerJobLog records every run.
  const runner = new JobRunner({ lock: adapters.lock, sink: workerJobLogSink, logger: log });

  const health = new HealthRegistry();
  health.register(pingCheck("postgres", pingDb));
  health.register(pingCheck("redis", pingRedis));

  return {
    config,
    log,
    redis,
    adapters,
    runner,
    health,
    async shutdown() {
      await Promise.allSettled([closeRedis(), disconnectDb()]);
    },
  };
}

/**
 * Shared boot wiring for the workers process: config → logger → health registry.
 * Kept feature-free for the scaffold; the job queues/processors land on top of
 * this later (WORKERS.md).
 */
import { loadConfig, type AppConfig } from "@sbr/config";
import { pingDb } from "@sbr/db";
import { pingRedis } from "@sbr/redis";
import { createLogger, HealthRegistry, pingCheck, type Logger } from "@sbr/observability";

export interface Boot {
  readonly config: AppConfig;
  readonly log: Logger;
  readonly health: HealthRegistry;
}

/** Validate config, build the logger, and register infra health probes. */
export function bootstrap(name: string): Boot {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, name });

  const health = new HealthRegistry();
  health.register(pingCheck("postgres", pingDb));
  health.register(pingCheck("redis", pingRedis));

  return { config, log, health };
}

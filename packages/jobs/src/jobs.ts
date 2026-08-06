/**
 * Concrete job definitions (thin). The actual fetch/rollup work is injected so
 * these stay decoupled from the hypixel/redis/db wiring; the scheduler passes
 * each definition to the JobRunner.
 */
import type { JobDefinition } from "./runner.js";

/** bazaar-refresh: fetch quick-status and warm the price cache. Returns item count. */
export function defineBazaarRefreshJob(refresh: () => Promise<number>): JobDefinition<number> {
  return {
    name: "bazaar-refresh",
    queue: "pricing",
    lockKey: "lock:job:bazaar",
    lockTtlMs: 90_000,
    maxRetries: 2,
    handler: refresh,
  };
}

/** analytics-rollup: aggregate the day's raw events into metric rows. Returns row count. */
export function defineAnalyticsRollupJob(rollup: () => Promise<number>): JobDefinition<number> {
  return {
    name: "analytics-rollup",
    queue: "analytics",
    lockKey: "lock:job:rollup:daily",
    lockTtlMs: 120_000,
    maxRetries: 1,
    handler: rollup,
  };
}

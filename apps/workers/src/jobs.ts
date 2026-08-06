/**
 * Job definitions for the workers process, bound to the live adapters. Each is a
 * plain JobDefinition the JobRunner executes (lock + retry + WorkerJobLog); the
 * BullMQ scheduler decides *when*.
 */
import { defineBazaarRefreshJob, type JobDefinition } from "@sbr/jobs";
import type { WorkerContext } from "./composition.js";

export function buildJobDefinitions(ctx: WorkerContext): Map<string, JobDefinition<number>> {
  const { keys, client } = ctx.redis;

  const heartbeat: JobDefinition<number> = {
    name: "heartbeat",
    queue: "ops",
    lockKey: keys.lockJob("heartbeat"),
    maxRetries: 0,
    handler: async () => {
      await client.set(keys.cacheGlobal("worker-heartbeat"), new Date().toISOString(), { EX: 120 });
      return 1;
    },
  };

  const bazaar: JobDefinition<number> = {
    ...defineBazaarRefreshJob(async () => {
      // TODO(Serving 6): fetch real quick-status via skyhelper-networth getPrices.
      await ctx.adapters.hypixelCache.set(keys.cacheBazaar(), { items: 0, refreshedAt: Date.now() }, 90_000);
      return 0;
    }),
    lockKey: keys.lockJob("bazaar"),
  };

  return new Map<string, JobDefinition<number>>([
    [heartbeat.name, heartbeat],
    [bazaar.name, bazaar],
  ]);
}

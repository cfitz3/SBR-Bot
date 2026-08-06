/**
 * @sbr/app-workers entrypoint — BullMQ scheduler + worker.
 *
 * A repeatable-job schedule (WORKERS.md) drives the queue; each job is processed
 * through the JobRunner (Redis lock + retry + WorkerJobLog). Long-running with
 * graceful shutdown. Set WORKER_DRAIN_MS to run for a bounded time then exit
 * (used for verification).
 */
import { Queue, Worker, type Job } from "bullmq";
import { createWorkerContext } from "./composition.js";
import { buildJobDefinitions } from "./jobs.js";

const QUEUE = "sbr-worker";

function redisConnection(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

async function main(): Promise<void> {
  const ctx = await createWorkerContext();
  const defs = buildJobDefinitions(ctx);
  const connection = redisConnection(ctx.config.redis.url);

  const worker = new Worker(
    QUEUE,
    async (job: Job) => {
      const def = defs.get(job.name);
      if (!def) {
        ctx.log.warn("no job definition for queued job", { name: job.name });
        return;
      }
      return ctx.runner.run(def);
    },
    { connection, concurrency: 4 },
  );
  worker.on("failed", (job, err) => ctx.log.error("bullmq job failed", { name: job?.name, error: err.message }));

  const queue = new Queue(QUEUE, { connection });
  // Repeatable schedule (off-minute cadence in prod; short here for liveness).
  await queue.add("heartbeat", {}, { repeat: { every: 5_000 }, jobId: "heartbeat" });
  await queue.add("bazaar-refresh", {}, { repeat: { every: 5_000 }, jobId: "bazaar" });
  // Kick one of each immediately.
  await queue.add("heartbeat", {});
  await queue.add("bazaar-refresh", {});

  ctx.log.info("workers scheduler started", { queue: QUEUE, jobs: [...defs.keys()] });

  const shutdown = async (): Promise<void> => {
    ctx.log.info("workers shutting down");
    await worker.close();
    await queue.close();
    await ctx.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const drainMs = Number(process.env.WORKER_DRAIN_MS ?? 0);
  if (drainMs > 0) {
    setTimeout(() => void shutdown(), drainMs);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`workers failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});

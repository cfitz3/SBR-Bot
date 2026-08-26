/**
 * @sbr/app-workers entrypoint — BullMQ scheduler + worker.
 *
 * A repeatable-job schedule (WORKERS.md) drives the queue; each job is processed
 * through the JobRunner (Redis lock + retry + WorkerJobLog). Long-running with
 * graceful shutdown. Set WORKER_DRAIN_MS to run for a bounded time then exit
 * (used for verification).
 */
import { Queue, Worker, type Job } from "bullmq";
import { installLifecycle } from "@sbr/observability";
import { createWorkerContext } from "./composition.js";
import { redisConnection } from "./connection.js";
import { buildJobDefinitions, buildRoleNudgeQueue } from "./jobs.js";
import { LANE, SCHEDULE, reconcileSchedule } from "./schedule.js";

const QUEUE = "sbr-worker";

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
  await reconcileSchedule(queue, ctx.log);
  // Kick the cold-start set immediately, so a fresh process has data before the
  // first scheduled tick rather than serving "not swept yet" for five minutes.
  for (const entry of SCHEDULE) {
    if (entry.warm) await queue.add(entry.name, {}, { priority: entry.priority });
  }

  // "Run now", from the panel's Health page. The panel publishes a request
  // rather than enqueueing, so this process stays the only writer to the queue
  // (see RedisJobTriggerBus). A request for a job this build does not define is
  // dropped with a line in the log: it means the panel is ahead of the fleet,
  // which an operator watching a button do nothing deserves to be able to find.
  const stopTriggers = await ctx.adapters.jobTriggers.subscribe((message) => {
    const def = defs.get(message.jobName);
    if (!def) {
      ctx.log.warn("manual run requested for an unknown job", { name: message.jobName, actor: message.actorDiscordId });
      return;
    }
    // Its scheduled lane, so a hand-started sweep does not jump ahead of the
    // live-serving work a repeatable of the same name would have waited behind.
    const priority = SCHEDULE.find((entry) => entry.name === message.jobName)?.priority ?? LANE.bulk;
    void queue
      .add(message.jobName, {}, { priority })
      .then(() => {
        ctx.log.info("manual run queued", {
          name: message.jobName,
          guildId: message.guildId,
          actor: message.actorDiscordId,
        });
      })
      .catch((error: unknown) => {
        ctx.log.error("manual run could not be queued", {
          name: message.jobName,
          error: error instanceof Error ? error.message : "unknown",
        });
      });
  });

  /**
   * "This one member changed" — the immediate half of role sync.
   *
   * Not a job and not queued. A BullMQ job would be the wrong shape twice over:
   * the unit of work is one member rather than one guild, and the whole point is
   * that it happens now rather than behind whatever the bulk lane is chewing on.
   * The queue in front of it is what keeps a burst of links inside the guild's
   * Discord role budget.
   *
   * The publisher has already marked the member dirty, so everything this path
   * drops — a message published while this process was restarting, a backlog
   * that filled, a reconcile that failed — is still picked up by the
   * fifteen-minute sweep. That is the property that makes it safe to be
   * fire-and-forget, and it is why the sweep is not going anywhere.
   */
  const nudges = buildRoleNudgeQueue(ctx);
  const stopNudges = await ctx.adapters.roleNudges.subscribe((message) => {
    nudges.nudge(message.guildId, message.discordId);
  });

  ctx.log.info("workers scheduler started", { queue: QUEUE, jobs: [...defs.keys()] });

  installLifecycle({
    logger: ctx.log,
    drainMs: Number(process.env.WORKER_DRAIN_MS ?? 0),
    // Worker close is the slow one: it waits for in-flight jobs to finish, and
    // an AH sweep can legitimately still be running. Give it more room than the
    // default before the watchdog decides it is hung rather than busy.
    timeoutMs: 30_000,
    async shutdown() {
      await stopTriggers();
      await stopNudges();
      // Stops taking new members and forgets the backlog rather than holding
      // shutdown open for it. Every one of them is still in the dirty set.
      nudges.stop();
      await worker.close();
      await queue.close();
      await ctx.shutdown();
    },
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`workers failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});

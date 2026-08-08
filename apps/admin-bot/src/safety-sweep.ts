/**
 * The safety-expiry loop.
 *
 * A time-boxed `/lockdown` is only actually time-boxed because something later
 * reopens the channels: the stored record deliberately outlives its `expiresAt`
 * so the unlock still knows what to reopen, and until this sweep runs the
 * server stays locked. It lives in the admin-bot rather than the workers
 * process because the unlock needs the Discord gateway, and this is where the
 * gateway is.
 *
 * The Redis lock means a second admin-bot instance won't double-sweep, and the
 * job log records every run alongside the market jobs.
 */
import { workerJobLogSink } from "@sbr/db";
import { defineSafetyExpiryJob, JobRunner } from "@sbr/jobs";
import type { Logger } from "@sbr/observability";
import type { createRedisAdapters } from "@sbr/redis";

/**
 * How often to check. Postures are set in minutes or hours, so a minute of
 * overshoot is invisible to staff while keeping the Discord call volume low.
 */
export const SAFETY_SWEEP_INTERVAL_MS = 60_000;

export interface SafetySweepDeps {
  readonly lock: ReturnType<typeof createRedisAdapters>["lock"];
  readonly sweep: () => Promise<number>;
  readonly logger: Logger;
  readonly intervalMs?: number;
}

/** Starts the loop and returns a stop function. */
export function startSafetySweep(deps: SafetySweepDeps): () => void {
  const runner = new JobRunner({ lock: deps.lock, sink: workerJobLogSink, logger: deps.logger });
  const job = defineSafetyExpiryJob(deps.sweep);

  const tick = (): void => {
    void runner.run(job).catch((error: unknown) => {
      // The runner already logs; this only stops a rejection from taking the
      // process down over a posture we can retry in a minute.
      deps.logger.error("safety sweep failed", { error: String(error) });
    });
  };

  const timer = setInterval(tick, deps.intervalMs ?? SAFETY_SWEEP_INTERVAL_MS);
  // Don't hold the process open on this alone.
  timer.unref();
  return () => clearInterval(timer);
}

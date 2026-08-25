/**
 * The punishment-expiry loop.
 *
 * A temp ban is only temporary because something later lifts it. Discord bans
 * do not expire on their own, and neither does the guild mute `/g mute` asked
 * Hypixel for — so until this runs, a "7-day ban" is a permanent one whose audit
 * row has quietly gone inactive.
 *
 * It lives in the admin bot rather than the workers process for the same reason
 * the safety sweep does: the reversal needs the Discord gateway, and this is
 * where the gateway is. It used to run in workers, where it could only clear the
 * `active` flag — which is precisely how the reversal went missing for so long.
 *
 * The Redis lock (the same key the workers job used) means a second instance
 * won't double-sweep, and the job log records every run alongside the rest.
 */
import { workerJobLogSink } from "@sbr/db";
import { definePunishmentExpiryJob, JobRunner } from "@sbr/jobs";
import type { Logger } from "@sbr/observability";
import type { createRedisAdapters } from "@sbr/redis";

/**
 * How often to check. Matches the five-minute cadence the workers schedule used:
 * mutes and bans are set in minutes at the very least, and staff read "is this
 * person still being punished" far more often than the answer changes.
 */
export const PUNISHMENT_SWEEP_INTERVAL_MS = 5 * 60_000;

export interface PunishmentSweepDeps {
  readonly lock: ReturnType<typeof createRedisAdapters>["lock"];
  /** Reverses what expired and clears the flags. Returns how many were lifted. */
  readonly sweep: () => Promise<number>;
  readonly logger: Logger;
  readonly intervalMs?: number;
}

/** Starts the loop and returns a stop function. */
export function startPunishmentSweep(deps: PunishmentSweepDeps): () => void {
  const runner = new JobRunner({ lock: deps.lock, sink: workerJobLogSink, logger: deps.logger });
  const job = definePunishmentExpiryJob(deps.sweep);

  const tick = (): void => {
    void runner.run(job).catch((error: unknown) => {
      // The runner already logs; this only stops a rejection from taking the
      // process down over a reversal we can retry in five minutes.
      deps.logger.error("punishment sweep failed", { error: String(error) });
    });
  };

  const timer = setInterval(tick, deps.intervalMs ?? PUNISHMENT_SWEEP_INTERVAL_MS);
  // Don't hold the process open on this alone.
  timer.unref();
  return () => clearInterval(timer);
}

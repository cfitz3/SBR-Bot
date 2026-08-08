/**
 * Process lifecycle: signal handling, crash logging, and a bounded shutdown.
 *
 * Every long-running app in the platform needs the same three behaviours, and
 * each had been open-coding a partial version:
 *
 *   - **Idempotent shutdown.** A second SIGINT — or a SIGTERM arriving while a
 *     SIGINT is still draining, which is exactly what an orchestrator does when
 *     the first one looks slow — re-entered the handler and closed every client
 *     twice, concurrently. That surfaces as errors thrown out of a `close()`
 *     that was already resolving.
 *
 *   - **A watchdog.** If a close hangs (BullMQ waiting on an in-flight job, a
 *     socket that never drains), nothing ever calls `process.exit` and the
 *     process sits there until the supervisor SIGKILLs it — losing whatever the
 *     graceful path existed to protect. A deadline turns "hangs forever" into
 *     "exits noisily", which is strictly better.
 *
 *   - **Crash visibility.** An unhandled rejection terminates a Node process by
 *     default, with a stack on stderr and nothing in the structured log. With
 *     JSON logs shipped somewhere, that means the one event worth alerting on is
 *     the only one that never arrives.
 */
import type { Logger } from "./logger.js";

export interface LifecycleOptions {
  readonly logger: Logger;
  /** Release resources. Must be safe to call once; this module guarantees that. */
  shutdown(): Promise<void>;
  /** Hard deadline for `shutdown()` before the process exits anyway. */
  readonly timeoutMs?: number;
  /** Auto-shutdown after N ms. Used by verification runs; 0 disables. */
  readonly drainMs?: number;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface LifecycleHandle {
  /** Trigger the same shutdown path a signal would. Safe to call repeatedly. */
  stop(reason: string): void;
}

export function installLifecycle(options: LifecycleOptions): LifecycleHandle {
  const { logger, shutdown } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let stopping = false;

  const stop = (reason: string): void => {
    if (stopping) {
      logger.debug("shutdown already in progress, ignoring", { reason });
      return;
    }
    stopping = true;
    logger.info("shutting down", { reason });

    // Armed before the shutdown is awaited, and unref'd so it is never itself
    // the reason the process stays alive once everything else has closed.
    const watchdog = setTimeout(() => {
      logger.error("shutdown exceeded its deadline — exiting anyway", { timeoutMs, reason });
      process.exit(1);
    }, timeoutMs);
    watchdog.unref();

    void shutdown()
      .then(() => {
        clearTimeout(watchdog);
        logger.info("shutdown complete", { reason });
        process.exit(0);
      })
      .catch((error: unknown) => {
        clearTimeout(watchdog);
        logger.error("shutdown failed", {
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      });
  };

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  // Both of these are already fatal in Node; the value added is that they reach
  // the structured log before the process goes, and that the exit is deliberate.
  process.on("unhandledRejection", (reason: unknown) => {
    logger.error("unhandled promise rejection", {
      error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    });
    stop("unhandledRejection");
  });

  process.on("uncaughtException", (error: Error) => {
    logger.error("uncaught exception", { error: error.stack ?? error.message });
    stop("uncaughtException");
  });

  // Deliberately not unref'd: the drain deadline is the whole reason the
  // process was started, so it must hold the loop open even if the app itself
  // has nothing pending.
  const drainMs = options.drainMs ?? 0;
  if (drainMs > 0) setTimeout(() => stop("drain"), drainMs);

  return { stop };
}

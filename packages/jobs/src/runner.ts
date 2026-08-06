/**
 * JobRunner — the shared machinery behind every worker job (WORKERS.md):
 * distributed-lock guard (skip if already held), retry/backoff with transient-
 * vs-permanent classification, and a WorkerJobLog record on completion/failure.
 * Scheduler-agnostic: BullMQ (or a cron tick) just calls `run(def)`.
 */
import type { Logger } from "@sbr/observability";
import { PermanentJobError, type JobLogSink, type LockPort, type Sleeper } from "./ports.js";

export interface JobDefinition<T> {
  readonly name: string;
  readonly queue: string;
  readonly lockKey: string;
  readonly lockTtlMs?: number;
  /** Number of retries after the first attempt. */
  readonly maxRetries: number;
  readonly handler: () => Promise<T>;
}

export type JobOutcome<T> =
  | { readonly status: "COMPLETED"; readonly result: T; readonly attempts: number }
  | { readonly status: "SKIPPED_LOCKED" }
  | { readonly status: "FAILED"; readonly error: string; readonly attempts: number; readonly permanent: boolean };

export interface JobRunnerDeps {
  readonly lock: LockPort;
  readonly sink: JobLogSink;
  readonly logger: Logger;
  readonly sleep?: Sleeper;
  readonly now?: () => number;
}

function backoffMs(attempt: number): number {
  return 100 * 2 ** attempt + Math.floor(Math.random() * 50);
}

export class JobRunner {
  private readonly lock: LockPort;
  private readonly sink: JobLogSink;
  private readonly log: Logger;
  private readonly sleep: Sleeper;
  private readonly now: () => number;

  constructor(deps: JobRunnerDeps) {
    this.lock = deps.lock;
    this.sink = deps.sink;
    this.log = deps.logger.child({ service: "jobs" });
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? (() => Date.now());
  }

  async run<T>(def: JobDefinition<T>): Promise<JobOutcome<T>> {
    const token = await this.lock.acquire(def.lockKey, def.lockTtlMs ?? 60_000);
    if (!token) {
      this.log.debug("job skipped (lock held)", { job: def.name });
      return { status: "SKIPPED_LOCKED" };
    }

    const startedAtMs = this.now();
    let attempts = 0;
    try {
      for (;;) {
        attempts += 1;
        try {
          const result = await def.handler();
          await this.record(def, "COMPLETED", attempts, startedAtMs);
          this.log.info("job completed", { job: def.name, attempts });
          return { status: "COMPLETED", result, attempts };
        } catch (error) {
          const permanent = error instanceof PermanentJobError;
          const message = error instanceof Error ? error.message : "unknown error";

          if (!permanent && attempts <= def.maxRetries) {
            this.log.warn("job attempt failed; retrying", { job: def.name, attempt: attempts, error: message });
            await this.sleep(backoffMs(attempts - 1));
            continue;
          }

          await this.record(def, "FAILED", attempts, startedAtMs, message);
          this.log.error("job failed", { job: def.name, attempts, permanent, error: message });
          return { status: "FAILED", error: message, attempts, permanent };
        }
      }
    } finally {
      await this.lock.release(def.lockKey, token);
    }
  }

  private async record<T>(
    def: JobDefinition<T>,
    status: "COMPLETED" | "FAILED",
    attempts: number,
    startedAtMs: number,
    error?: string,
  ): Promise<void> {
    const finishedAtMs = this.now();
    await this.sink.record({
      queue: def.queue,
      type: def.name,
      status,
      attempts,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      ...(error ? { error } : {}),
    });
  }
}

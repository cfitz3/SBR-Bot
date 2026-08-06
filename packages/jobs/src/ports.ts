import type { JobStatus } from "@sbr/shared-types";

/** Thrown by a job handler to signal a non-retryable failure (dead-letter). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

/** Distributed lock (Redis SET NX at wiring time; in-memory for tests). */
export interface LockPort {
  /** Returns an owner token if acquired, or null if already held. */
  acquire(key: string, ttlMs: number): Promise<string | null>;
  release(key: string, token: string): Promise<void>;
}

export type Sleeper = (ms: number) => Promise<void>;

export interface JobLogEntry {
  readonly queue: string;
  readonly type: string;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly error?: string;
}

/** Persists a WorkerJobLog row (Postgres at wiring time). */
export interface JobLogSink {
  record(entry: JobLogEntry): Promise<void>;
}

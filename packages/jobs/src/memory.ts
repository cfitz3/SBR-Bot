import { randomUUID } from "node:crypto";
import type { JobLogEntry, JobLogSink, LockPort } from "./ports.js";

/** In-memory lock (single-process / tests). Redis-backed at wiring time. */
export class InMemoryLock implements LockPort {
  private readonly held = new Map<string, string>();

  async acquire(key: string, _ttlMs: number): Promise<string | null> {
    if (this.held.has(key)) return null;
    const token = randomUUID();
    this.held.set(key, token);
    return token;
  }

  async release(key: string, token: string): Promise<void> {
    if (this.held.get(key) === token) this.held.delete(key);
  }
}

/** Collecting sink for tests / local runs. */
export class RecordingLogSink implements JobLogSink {
  readonly entries: JobLogEntry[] = [];
  async record(entry: JobLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

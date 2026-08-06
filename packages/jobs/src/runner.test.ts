import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@sbr/observability";
import { JobRunner, type JobDefinition } from "./runner.js";
import { InMemoryLock, RecordingLogSink } from "./memory.js";
import { PermanentJobError } from "./ports.js";
import { defineBazaarRefreshJob } from "./jobs.js";

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };
const noopSleep = async (): Promise<void> => {};

function runner(over: { lock?: InMemoryLock; sink?: RecordingLogSink } = {}) {
  const lock = over.lock ?? new InMemoryLock();
  const sink = over.sink ?? new RecordingLogSink();
  const r = new JobRunner({ lock, sink, logger: silent, sleep: noopSleep, now: () => 1_000 });
  return { r, lock, sink };
}

function job<T>(handler: () => Promise<T>, over: Partial<JobDefinition<T>> = {}): JobDefinition<T> {
  return { name: "test-job", queue: "q", lockKey: "lock:test", maxRetries: 2, handler, ...over };
}

test("runs a job to completion and records a COMPLETED log", async () => {
  const { r, sink } = runner();
  const outcome = await r.run(job(async () => 42));
  assert.equal(outcome.status, "COMPLETED");
  if (outcome.status === "COMPLETED") assert.equal(outcome.result, 42);
  assert.equal(sink.entries[0]?.status, "COMPLETED");
  assert.equal(sink.entries[0]?.attempts, 1);
});

test("skips when the lock is already held", async () => {
  const lock = new InMemoryLock();
  await lock.acquire("lock:test", 1_000); // someone else holds it
  let ran = false;
  const { r } = runner({ lock });
  const outcome = await r.run(job(async () => { ran = true; return 1; }));
  assert.deepEqual(outcome, { status: "SKIPPED_LOCKED" });
  assert.equal(ran, false);
});

test("retries a transient failure then succeeds", async () => {
  let calls = 0;
  const { r, sink } = runner();
  const outcome = await r.run(job(async () => {
    calls += 1;
    if (calls === 1) throw new Error("transient blip");
    return "ok";
  }));
  assert.equal(outcome.status, "COMPLETED");
  if (outcome.status === "COMPLETED") assert.equal(outcome.attempts, 2);
  assert.equal(calls, 2);
  assert.equal(sink.entries[0]?.status, "COMPLETED");
});

test("does not retry a PermanentJobError (dead-letter)", async () => {
  let calls = 0;
  const { r, sink } = runner();
  const outcome = await r.run(job(async () => { calls += 1; throw new PermanentJobError("bad input"); }));
  assert.equal(outcome.status, "FAILED");
  if (outcome.status === "FAILED") {
    assert.equal(outcome.permanent, true);
    assert.equal(outcome.attempts, 1);
  }
  assert.equal(calls, 1);
  assert.equal(sink.entries[0]?.status, "FAILED");
  assert.equal(sink.entries[0]?.error, "bad input");
});

test("gives up after exhausting retries on persistent transient errors", async () => {
  let calls = 0;
  const { r } = runner();
  const outcome = await r.run(job(async () => { calls += 1; throw new Error("still down"); }, { maxRetries: 2 }));
  assert.equal(outcome.status, "FAILED");
  if (outcome.status === "FAILED") {
    assert.equal(outcome.permanent, false);
    assert.equal(outcome.attempts, 3); // 1 initial + 2 retries
  }
  assert.equal(calls, 3);
});

test("releases the lock after running (so the next run can proceed)", async () => {
  const lock = new InMemoryLock();
  const { r } = runner({ lock });
  await r.run(job(async () => 1));
  const outcome = await r.run(job(async () => 2));
  assert.equal(outcome.status, "COMPLETED"); // not SKIPPED_LOCKED
});

test("concrete bazaar-refresh definition runs through the runner", async () => {
  const { r, sink } = runner();
  const outcome = await r.run(defineBazaarRefreshJob(async () => 1_234));
  assert.equal(outcome.status, "COMPLETED");
  if (outcome.status === "COMPLETED") assert.equal(outcome.result, 1_234);
  assert.equal(sink.entries[0]?.queue, "pricing");
  assert.equal(sink.entries[0]?.type, "bazaar-refresh");
});

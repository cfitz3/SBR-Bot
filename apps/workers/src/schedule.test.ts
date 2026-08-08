import assert from "node:assert/strict";
import { test } from "node:test";

import { createKeyFactory } from "@sbr/redis";

import { buildJobDefinitions } from "./jobs.js";
import { SCHEDULE, reconcileSchedule, repeatSignature } from "./schedule.js";
import type { WorkerContext } from "./composition.js";

// The definitions are built, not run: every job body is a closure that only
// touches the context when the queue invokes it. Only the key factory is read
// eagerly (for lock keys), so that is all the stub needs to provide.
const ctx = { redis: { keys: createKeyFactory("sbr:"), client: null } } as unknown as WorkerContext;
const names = new Set(buildJobDefinitions(ctx).keys());

test("every scheduled job has a definition", () => {
  for (const entry of SCHEDULE) {
    assert.ok(names.has(entry.name), `scheduled "${entry.name}" has no job definition`);
  }
});

test("every defined job has a cadence", () => {
  const scheduled = new Set(SCHEDULE.map((e) => e.name));
  for (const name of names) {
    assert.ok(scheduled.has(name), `job "${name}" is defined but never scheduled`);
  }
});

test("no job is scheduled twice", () => {
  assert.equal(new Set(SCHEDULE.map((e) => e.name)).size, SCHEDULE.length);
});

test("cron cadences avoid :00 and :30 (WORKERS.md §3 staggering)", () => {
  for (const entry of SCHEDULE) {
    if (!("pattern" in entry.repeat)) continue;
    const minuteField = entry.repeat.pattern.split(" ")[0] ?? "";

    // Expand the field into the minutes it actually fires on, so a range-step
    // like "1-59/3" is checked against its real output rather than its text.
    const minutes: number[] = [];
    for (const part of minuteField.split(",")) {
      const [range, step] = part.split("/");
      const [lo, hi] = (range ?? "").split("-").map(Number);
      const from = lo ?? 0;
      const to = hi ?? from;
      for (let m = from; m <= to; m += Number(step ?? 1)) minutes.push(m);
    }

    assert.ok(minutes.length > 0, `"${entry.name}" has an unparseable minute field`);
    for (const m of minutes) {
      assert.ok(m !== 0 && m !== 30, `"${entry.name}" fires on :${m}, a thundering-herd minute`);
    }
  }
});

test("live-serving refreshes outrank bulk work", () => {
  const priority = (name: string): number =>
    SCHEDULE.find((e) => e.name === name)?.priority ?? Number.MAX_SAFE_INTEGER;

  // Lower is more urgent in BullMQ.
  assert.ok(priority("bazaar-refresh") < priority("profile-snapshot"));
  assert.ok(priority("ah-sweep") < priority("inactivity-scan"));
  assert.ok(priority("event-transition") < priority("analytics-rollup"));
});

// ── reconciliation ──

/** In-memory stand-in for the BullMQ repeatable registry. */
function fakeQueue(initial: Array<{ key: string; name: string; pattern?: string; every?: string }> = []) {
  const existing = [...initial];
  const added: Array<{ name: string; priority: number }> = [];
  const removedKeys: string[] = [];
  return {
    added,
    removedKeys,
    async getRepeatableJobs() { return existing; },
    async removeRepeatableByKey(key: string) { removedKeys.push(key); return true; },
    async add(name: string, _d: Record<string, never>, opts: { priority: number }) {
      added.push({ name, priority: opts.priority });
      return undefined;
    },
  };
}

const quiet = { info() {}, warn() {} };

test("a repeatable left over from an older cadence is removed", async () => {
  // The exact production drift: bazaar-refresh moved from 5s to 120s, and the
  // 5s entry stayed registered and kept firing 24x more often than intended.
  const queue = fakeQueue([
    { key: "bazaar-refresh:::5000", name: "bazaar-refresh", every: "5000" },
    { key: "bazaar-refresh:::120000", name: "bazaar-refresh", every: "120000" },
  ]);

  await reconcileSchedule(queue, quiet);

  assert.ok(queue.removedKeys.includes("bazaar-refresh:::5000"), "the 5s entry must be unregistered");
  assert.equal(
    queue.added.filter((a) => a.name === "bazaar-refresh").length,
    1,
    "bazaar-refresh should end up registered exactly once",
  );
});

test("a job dropped from the schedule entirely is unregistered", async () => {
  // Adding can never fix this direction — the entry simply has no counterpart
  // in the file any more, so only an explicit removal clears it.
  const queue = fakeQueue([{ key: "retired:::1000", name: "retired-job", every: "1000" }]);
  await reconcileSchedule(queue, quiet);
  assert.deepEqual(queue.removedKeys, ["retired:::1000"]);
});

test("a duplicate at the correct cadence is still cleared", async () => {
  // The case that survived the first version of this function. BullMQ's repeat
  // key covers jobId/timezone/endDate as well as name and cadence, so the same
  // logical job can be registered twice under different keys while looking
  // identical on the fields we can see. Both fired; nothing warned.
  const queue = fakeQueue([
    { key: "bazaar-refresh::::120000", name: "bazaar-refresh", every: "120000" },
    { key: "bazaar-refresh:bazaar-refresh:::120000", name: "bazaar-refresh", every: "120000" },
  ]);

  await reconcileSchedule(queue, quiet);

  assert.equal(queue.removedKeys.length, 2, "both keys must go before the single re-add");
  assert.equal(
    queue.added.filter((a) => a.name === "bazaar-refresh").length,
    1,
    "exactly one bazaar-refresh should be registered afterwards",
  );
});

test("reconciling a registry that already matches leaves it equivalent", async () => {
  // Convergence, not minimal churn: whatever was registered, what remains after
  // is exactly the schedule, once each.
  const queue = fakeQueue(
    SCHEDULE.map((e) => ({
      key: `${e.name}:key`,
      name: e.name,
      ...("pattern" in e.repeat ? { pattern: e.repeat.pattern } : { every: String(e.repeat.every) }),
    })),
  );

  const result = await reconcileSchedule(queue, quiet);

  assert.equal(result.removed, SCHEDULE.length);
  assert.deepEqual(
    queue.added.map((a) => a.name).sort(),
    SCHEDULE.map((e) => e.name).sort(),
  );
});

test("reconciliation re-adds every scheduled job with its lane priority", async () => {
  const queue = fakeQueue();
  await reconcileSchedule(queue, quiet);

  assert.equal(queue.added.length, SCHEDULE.length);
  for (const entry of SCHEDULE) {
    const found = queue.added.find((a) => a.name === entry.name);
    assert.ok(found, `${entry.name} was not registered`);
    assert.equal(found.priority, entry.priority);
  }
});

test("cron and interval cadences do not collide in the signature", () => {
  // A pattern of "5000" and an interval of 5000ms must not compare equal, or a
  // cron job would silently satisfy an interval entry and never be reconciled.
  assert.notEqual(repeatSignature("j", { pattern: "5000" }), repeatSignature("j", { every: 5000 }));
});

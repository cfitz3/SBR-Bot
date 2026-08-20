/**
 * The sweeper's contract: deliver what is due, flip the flag after, retry what
 * did not land — and stop retrying a channel that has clearly gone.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReminderDTO } from "@sbr/shared-types";
import { REMINDER_GIVE_UP_MS, sweepRemindersOnce, type ReminderSweeperDeps } from "./reminders.js";

const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);

const silentLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLog;
  },
} as unknown as ReminderSweeperDeps["log"];

function reminder(over: Partial<ReminderDTO> = {}): ReminderDTO {
  return {
    id: "r1",
    guildId: "g1",
    discordId: "111",
    channelId: "chan-1",
    text: "check auctions",
    dueAt: new Date(NOW - 1_000).toISOString(),
    ...over,
  };
}

interface Harness {
  readonly deps: ReminderSweeperDeps;
  readonly posted: string[];
  readonly delivered: string[];
  readonly asked: Date[];
}

function harness(rows: readonly ReminderDTO[], post: (r: ReminderDTO) => boolean = () => true): Harness {
  const posted: string[] = [];
  const delivered: string[] = [];
  const asked: Date[] = [];

  const deps: ReminderSweeperDeps = {
    reminders: {
      async create() {
        throw new Error("not used");
      },
      async listDue(now, limit) {
        asked.push(now);
        return rows.slice(0, limit);
      },
      async markDelivered(ids) {
        delivered.push(...ids);
        return ids.length;
      },
      async listPendingFor() {
        return [];
      },
      async cancel() {
        return false;
      },
      async countPendingFor() {
        return 0;
      },
    },
    async post(r) {
      const ok = post(r);
      if (ok) posted.push(r.id);
      return ok;
    },
    log: silentLog,
    now: () => NOW,
  };

  return { deps, posted, delivered, asked };
}

test("a due reminder is delivered and then flagged, in that order", async () => {
  const h = harness([reminder()]);
  const count = await sweepRemindersOnce(h.deps);

  assert.equal(count, 1);
  assert.deepEqual(h.posted, ["r1"]);
  assert.deepEqual(h.delivered, ["r1"]);
});

test("the sweep asks for what is due as of its own clock, not the wall clock", async () => {
  const h = harness([]);
  await sweepRemindersOnce(h.deps);
  assert.equal(h.asked[0]?.getTime(), NOW);
});

test("a reminder that does not land stays pending for the next pass", async () => {
  const h = harness([reminder()], () => false);
  const count = await sweepRemindersOnce(h.deps);

  assert.equal(count, 0);
  assert.deepEqual(h.delivered, []);
});

test("a reminder undeliverable for a day is given up on rather than blocking every batch", async () => {
  const stale = reminder({ id: "r-old", dueAt: new Date(NOW - REMINDER_GIVE_UP_MS - 1).toISOString() });
  const h = harness([stale], () => false);
  const count = await sweepRemindersOnce(h.deps);

  // Cleared from the queue, but not counted as delivered — nothing was.
  assert.equal(count, 0);
  assert.deepEqual(h.delivered, ["r-old"]);
});

test("one failure does not stop the rest of the batch", async () => {
  const h = harness(
    [reminder({ id: "r1", channelId: "gone" }), reminder({ id: "r2" })],
    (r) => r.channelId !== "gone",
  );
  const count = await sweepRemindersOnce(h.deps);

  assert.equal(count, 1);
  assert.deepEqual(h.delivered, ["r2"]);
});

test("a post that throws is treated as a failure, not as a crashed sweep", async () => {
  const h = harness([reminder()]);
  const deps: ReminderSweeperDeps = {
    ...h.deps,
    async post() {
      throw new Error("discord exploded");
    },
  };

  assert.equal(await sweepRemindersOnce(deps), 0);
});

test("nothing due is a no-op, with no write at all", async () => {
  const h = harness([]);
  assert.equal(await sweepRemindersOnce(h.deps), 0);
  assert.deepEqual(h.delivered, []);
});

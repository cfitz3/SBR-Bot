import assert from "node:assert/strict";
import test from "node:test";
import { NUDGE_BURST, NUDGE_MAX_PENDING, NUDGE_REFILL_MS, createRoleNudgeQueue } from "./role-nudge.js";

const GUILD = "g1";

interface Harness {
  queue: ReturnType<typeof createRoleNudgeQueue>;
  /** Every reconcile the queue actually ran, and the clock reading it ran at. */
  readonly synced: { discordId: string; at: number }[];
  readonly dropped: { discordId: string; why: string }[];
  /** How long the queue asked to wait, each time it ran out of tokens. */
  readonly slept: number[];
  /** Fake wall clock, moved only by the sleeps the queue asks for. */
  clock: number;
}

/**
 * Time is injected rather than waited on. Proving that a burst of twenty is
 * spread across the following minute must not take a minute, and a test that
 * slept for real would be the kind that gets marked flaky and then skipped.
 */
function harness(over: { sync?: (discordId: string) => Promise<boolean> } = {}): Harness {
  const h: Harness = { synced: [], dropped: [], slept: [], clock: 0, queue: undefined as never };
  h.queue = createRoleNudgeQueue({
    now: () => h.clock,
    sleep: async (ms) => {
      h.slept.push(ms);
      h.clock += ms;
    },
    async sync(_guildId, discordId) {
      h.synced.push({ discordId, at: h.clock });
      return (await over.sync?.(discordId)) ?? true;
    },
    onDropped: (_guildId, discordId, why) => h.dropped.push({ discordId, why }),
  });
  return h;
}

/** The ids the queue reconciled, in order. */
function order(h: Harness): string[] {
  return h.synced.map((entry) => entry.discordId);
}

/** Lets the queue's fire-and-forget drain run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve();
}

test("one person linking is reconciled at once", async () => {
  // The case the whole mechanism exists for. A member who has just linked
  // should not be paced behind anything, because there is nothing to pace.
  const h = harness();

  assert.equal(h.queue.nudge(GUILD, "u1"), true);
  await settle();

  assert.deepEqual(order(h), ["u1"]);
  assert.deepEqual(h.slept, []);
});

test("a burst spends its tokens and then waits", async () => {
  // Discord's per-guild role bucket is roughly ten modifications per ten
  // seconds and one member can cost two, so the queue is allowed a short burst
  // and then has to earn each further member.
  const h = harness();
  for (const id of ["u1", "u2", "u3", "u4", "u5"]) h.queue.nudge(GUILD, id);
  await settle();

  assert.deepEqual(order(h), ["u1", "u2", "u3", "u4", "u5"]);
  // The first NUDGE_BURST went straight through; the rest each had to be waited
  // for, in the order they were asked for.
  assert.equal(h.slept.length, 5 - NUDGE_BURST);
  assert.deepEqual(new Set(h.slept), new Set([NUDGE_REFILL_MS]));
});

test("twenty simultaneous links stay inside the guild's role budget", async () => {
  // The acceptance criterion, checked directly: across every ten-second window
  // of the drain, no more than four members are reconciled — at most two role
  // calls each, so eight against a bucket of about ten.
  const h = harness();
  for (let i = 0; i < 20; i += 1) h.queue.nudge(GUILD, `u${i}`);
  await settle();

  const at = h.synced.map((entry) => entry.at);
  assert.equal(at.length, 20);
  for (const start of at) {
    const inWindow = at.filter((t) => t >= start && t < start + 10_000).length;
    assert.ok(inWindow <= 4, `${inWindow} members reconciled in one ten-second window`);
  }
});

test("the same member nudged twice is reconciled once", async () => {
  // Two events about one person in the same second — a link that fills in an
  // IGN and completes a milestone — want one reconcile, not two identical ones.
  const h = harness();
  h.queue.nudge(GUILD, "u1");
  h.queue.nudge(GUILD, "u1");
  await settle();

  assert.deepEqual(order(h), ["u1"]);
});

test("a backlog past the ceiling is refused rather than queued", async () => {
  // Past this the immediate path has nothing to offer over the sweep: it would
  // deliver the last member minutes late either way. Refusing says so, in a
  // line an operator can find, instead of growing a queue nobody is watching.
  const h = harness();
  for (let i = 0; i < NUDGE_MAX_PENDING * 2; i += 1) h.queue.nudge(GUILD, `u${i}`);

  assert.equal(h.queue.pending(), NUDGE_MAX_PENDING);
  assert.ok(h.dropped.length > 0);
  assert.deepEqual(new Set(h.dropped.map((d) => d.why)), new Set(["backlog"]));
});

test("guilds are paced separately", async () => {
  // The bucket Discord enforces is per guild, so one busy server must not be
  // able to make another one wait.
  const h = harness();
  for (let i = 0; i < NUDGE_BURST; i += 1) h.queue.nudge("busy", `u${i}`);
  h.queue.nudge("quiet", "u1");
  await settle();

  assert.equal(h.slept.length, 0);
  assert.equal(h.synced.length, NUDGE_BURST + 1);
});

test("stopping forgets the backlog instead of holding shutdown open for it", async () => {
  // Everything dropped here is still in the dirty set. Draining forty members
  // at one every two seconds while the process is trying to exit would trade a
  // clean shutdown for work the sweep is about to do anyway.
  const h = harness();
  for (let i = 0; i < 10; i += 1) h.queue.nudge(GUILD, `u${i}`);
  h.queue.stop();
  await settle();

  assert.ok(h.synced.length <= NUDGE_BURST);
  assert.equal(h.queue.nudge(GUILD, "late"), false);
  assert.equal(h.queue.pending(), 0);
});

test("a member whose reconcile fails does not stall the ones behind them", async () => {
  // `syncOneMember` does not throw, but the queue must not depend on that: a
  // lane that died on one member would leave everyone after them to the sweep.
  const h = harness({
    sync: async (discordId) => {
      if (discordId === "u1") throw new Error("discord said no");
      return true;
    },
  });
  h.queue.nudge(GUILD, "u1");
  h.queue.nudge(GUILD, "u2");
  await settle();

  assert.ok(order(h).includes("u2"));
});

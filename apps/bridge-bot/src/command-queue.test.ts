import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandQueue } from "./command-queue.js";

/**
 * A fake clock that advances only when the queue sleeps. Real timers would make
 * every assertion below a race, and pacing is the whole point of the class.
 */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      // Yield so the drain loop's own awaits interleave the way they would with
      // real timers.
      await Promise.resolve();
    },
  };
}

function queue(deliver: (c: string) => boolean, over: Partial<{ spacingMs: number; maxBacklog: number; maxAgeMs: number }> = {}) {
  const clock = fakeClock();
  const q = new CommandQueue(deliver, {
    spacingMs: 1_200,
    maxBacklog: 20,
    maxAgeMs: 120_000,
    sleep: clock.sleep,
    now: clock.now,
    ...over,
  });
  return { q, clock };
}

test("commands are delivered in order, one at a time", async () => {
  const sent: string[] = [];
  const { q } = queue((c) => (sent.push(c), true));
  q.push("/g mute A 1h");
  q.push("/g kick B");
  await q.idle();
  assert.deepEqual(sent, ["/g mute A 1h", "/g kick B"]);
});

test("sends are spaced by at least the configured gap", async () => {
  const at: number[] = [];
  const { q, clock } = queue(() => (at.push(clock.now()), true));
  q.push("a");
  q.push("b");
  q.push("c");
  await q.idle();
  assert.equal(at.length, 3);
  assert.ok((at[1] ?? 0) - (at[0] ?? 0) >= 1_200, "second send too soon");
  assert.ok((at[2] ?? 0) - (at[1] ?? 0) >= 1_200, "third send too soon");
});

test("a full backlog refuses the newest rather than reordering enforcement", async () => {
  // Never delivers, so nothing leaves the queue and the backlog fills.
  const { q } = queue(() => false, { maxBacklog: 2 });
  assert.equal(q.push("first"), true);
  assert.equal(q.push("second"), true);
  assert.equal(q.push("third"), false);
  assert.equal(q.stats().dropped, 1);
  assert.equal(q.stats().queued, 2);
});

test("a command held past its age limit is abandoned, not delivered late", async () => {
  const sent: string[] = [];
  let up = false;
  const { q } = queue((c) => (up ? (sent.push(c), true) : false), { maxAgeMs: 5_000 });
  q.push("/g mute A 10m");
  // The queue retries at the spacing interval, and the fake clock advances with
  // each retry, so the entry ages out before the session returns.
  await q.idle();
  up = true;
  assert.deepEqual(sent, []);
  assert.equal(q.stats().expired, 1);
});

test("a command queued while the session is down is delivered once it returns", async () => {
  const sent: string[] = [];
  let up = false;
  const { q } = queue((c) => (up ? (sent.push(c), true) : false), { maxAgeMs: 600_000 });
  q.push("/g unmute A");
  // Let it fail a couple of times, then bring the session back.
  await Promise.resolve();
  up = true;
  await q.idle();
  assert.deepEqual(sent, ["/g unmute A"]);
  assert.equal(q.stats().sent, 1);
});

/**
 * The urgent lane.
 *
 * Everything else this queue carries — a mute, a promotion — is just as valid a
 * minute later. An answer to a join request is not: Hypixel forgets the request
 * after five minutes, so a paced backlog of ordinary commands is enough to turn
 * an accept into a failure. These assertions are the difference between "the
 * queue is fair" and "the queue is fair and the door still opens".
 */
test("an urgent command overtakes the ordinary backlog", async () => {
  const sent: string[] = [];
  let up = false;
  const { q } = queue((c) => (up ? (sent.push(c), true) : false), { maxAgeMs: 600_000 });
  q.push("/g mute A 1h");
  q.push("/g kick B");
  q.push("/guild accept Jack", { urgent: true });
  up = true;
  await q.idle();
  assert.equal(sent[0], "/guild accept Jack");
});

test("urgent commands keep their own order", async () => {
  // Overtaking the ordinary queue must not mean overtaking each other: two
  // applicants answered in one breath should be answered in the order the
  // staffer pressed, not in reverse.
  const sent: string[] = [];
  let up = false;
  const { q } = queue((c) => (up ? (sent.push(c), true) : false), { maxAgeMs: 600_000 });
  q.push("/g kick B");
  q.push("/guild accept Jack", { urgent: true });
  q.push("/guild deny Alex", { urgent: true });
  up = true;
  await q.idle();
  assert.deepEqual(sent, ["/guild accept Jack", "/guild deny Alex", "/g kick B"]);
});

test("a full backlog displaces the newest ordinary command rather than refusing an urgent one", async () => {
  const { q } = queue(() => false, { maxBacklog: 2 });
  assert.equal(q.push("/g mute A 1h"), true);
  assert.equal(q.push("/g kick B"), true);
  // The old behaviour dropped this, which is the failure this lane exists to
  // prevent: a burst of punishments silently costing the guild an applicant.
  assert.equal(q.push("/guild accept Jack", { urgent: true }), true);
  assert.equal(q.stats().evicted, 1);
});

test("an all-urgent backlog still refuses rather than eating itself", async () => {
  // There is nothing left to displace, and dropping another join answer to make
  // room for this one would just move the loss around.
  const { q } = queue(() => false, { maxBacklog: 2 });
  assert.equal(q.push("/guild accept A", { urgent: true }), true);
  assert.equal(q.push("/guild accept B", { urgent: true }), true);
  assert.equal(q.push("/guild accept C", { urgent: true }), false);
});

test("a join answer that outlived its window is abandoned, not delivered late", async () => {
  // Delivered late it does not arrive late, it fails — against a row the
  // platform has by then already marked ACCEPTED.
  const sent: string[] = [];
  const { q } = queue(() => false, { maxAgeMs: 120_000 });
  q.push("/guild accept Jack", { urgent: true, maxAgeMs: 5_000 });
  await q.idle();
  assert.deepEqual(sent, []);
  assert.equal(q.stats().expired, 1);
});

test("exactly one hook fires for every command the queue accepts", async () => {
  // The ack channel rests on this. A caller waiting to hear whether a ban
  // reached the game has to be told either way; a command that leaves the
  // queue silently costs it a full timeout and records a punishment as
  // unconfirmed that in fact never left the building.
  const seen: string[] = [];
  const hooks = (name: string) => ({
    onSent: () => seen.push(`sent:${name}`),
    onExpired: () => seen.push(`gone:${name}`),
  });

  // Held with no session, then aged out.
  const held = queue(() => false, { maxAgeMs: 5_000 });
  held.q.push("/g kick A late", hooks("A"));
  await held.q.idle();
  assert.deepEqual(seen, ["gone:A"]);

  // Delivered.
  seen.length = 0;
  const sent: string[] = [];
  const live = queue((c) => (sent.push(c), true));
  live.q.push("/g kick B spam", hooks("B"));
  await live.q.idle();
  assert.deepEqual(sent, ["/g kick B spam"]);
  assert.deepEqual(seen, ["sent:B"]);

  // Displaced by an urgent command. Not the entry's fault, and still an
  // answer its caller is owed.
  seen.length = 0;
  const full = queue(() => false, { maxBacklog: 2 });
  full.q.push("/g mute C 1h", hooks("C"));
  full.q.push("/g kick D spam", hooks("D"));
  full.q.push("/guild accept Jack", { urgent: true });
  assert.deepEqual(seen, ["gone:D"]);
});

/**
 * The bus that waits for an answer.
 *
 * Each assertion here stands for a way a `/g kick` used to read as done: the
 * bridge offline, the queue full, Hypixel refusing the line, or nobody ever
 * saying anything at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@sbr/observability";
import { createGameCommandBus, type RelayAck, type RelayInstruction } from "./game-relay.js";

const silent: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
  child() { return silent; },
};

/**
 * `send` crosses several awaits before it registers its waiter — the liveness
 * check, the subscription, the publish. Acking before that happened would test
 * nothing and hang everything, so drain the microtask queue first.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function harness(opts: { live?: boolean; subscribeFails?: boolean } = {}) {
  const sent: RelayInstruction[] = [];
  let emit: ((ack: RelayAck) => void) | null = null;
  /** Fires the timeout only when a test asks, so nothing here races a clock. */
  let expire: (() => void) | null = null;
  const bus = createGameCommandBus({
    async publish(message) { sent.push(message); },
    async subscribeAcks(onAck) {
      if (opts.subscribeFails === true) throw new Error("redis down");
      emit = onAck;
      return () => { emit = null; };
    },
    async live() { return opts.live !== false; },
    logger: silent,
    correlationId: () => "corr-1",
    schedule: (_ms, fn) => { expire = fn; return () => { expire = null; }; },
  });
  return {
    bus,
    sent,
    ack: (outcome: string, detail = "") => emit?.({ correlationId: "corr-1", outcome, detail }),
    expire: () => expire?.(),
  };
}

test("a confirmed command reports what the guild printed", async () => {
  const h = harness();
  const answer = h.bus.send("g1", "/g kick Notch Ban evasion");
  await flush();
  h.ack("CONFIRMED_INGAME", "Notch was kicked from the guild by Bridge!");
  assert.deepEqual(await answer, {
    outcome: "CONFIRMED_INGAME",
    detail: "Notch was kicked from the guild by Bridge!",
  });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]?.command, "/g kick Notch Ban evasion");
});

test("no bridge in-game is answered without publishing anything", async () => {
  // Publishing regardless is what made this failure invisible: pub/sub accepts
  // a message nobody is subscribed to and drops it.
  const h = harness({ live: false });
  assert.equal((await h.bus.send("g1", "/g kick Notch x")).outcome, "NO_SESSION");
  assert.deepEqual(h.sent, []);
});

test("typed is progress, not a verdict", async () => {
  // The bridge saying it typed the line is exactly the old false success. It
  // has to keep waiting for the guild, and settle as unconfirmed if the guild
  // never comments — which is a PENDING row, not a finished punishment.
  const h = harness();
  const answer = h.bus.send("g1", "/g kick Notch x");
  await flush();
  h.ack("TYPED", "handed to Minecraft");
  h.expire();
  const receipt = await answer;
  assert.equal(receipt.outcome, "UNCONFIRMED");
  assert.match(receipt.detail, /said nothing/);
});

test("silence from a bridge that never even typed it is a timeout", async () => {
  const h = harness();
  const answer = h.bus.send("g1", "/g kick Notch x");
  await flush();
  h.expire();
  assert.equal((await answer).outcome, "TIMED_OUT");
});

for (const outcome of ["REFUSED_INGAME", "REFUSED_BACKLOG", "WRONG_GUILD", "EXPIRED"]) {
  test(`${outcome} settles the wait immediately`, async () => {
    const h = harness();
    const answer = h.bus.send("g1", "/g kick Notch x");
    await flush();
    h.ack(outcome, "because");
    assert.equal((await answer).outcome, outcome);
  });
}

test("an ack for somebody else's command is ignored", async () => {
  const h = harness();
  const answer = h.bus.send("g1", "/g kick Notch x");
  await flush();
  h.ack("CONFIRMED_INGAME", "not ours");
  // Same emitter, different correlation id — the map lookup is what filters.
  assert.equal((await answer).detail, "not ours");
});

test("a bus that cannot hear answers says so rather than claiming success", async () => {
  const h = harness({ subscribeFails: true });
  const receipt = await h.bus.send("g1", "/g kick Notch x");
  assert.equal(receipt.outcome, "UNCONFIRMED");
  assert.match(receipt.detail, /cannot hear/);
  // Still published: an unverifiable kick is better than no kick.
  assert.equal(h.sent.length, 1);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { MarketRange } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import {
  BREAKER_COOLDOWN_MS,
  BREAKER_THRESHOLD,
  HISTORY_TTL_MS,
  MarketHistoryServiceImpl,
} from "./history.js";
import { InMemoryHistoryCache, type HistoryPoint, type PriceHistoryProvider } from "./ports.js";

const HOUR = 3_600_000;

const silent: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

function point(at: number, avg: number): HistoryPoint {
  return { at, min: avg - 1, max: avg + 1, avg, volume: 10 };
}

/** A clock the tests drive, shared by the service and its cache. */
function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function service(
  provider: PriceHistoryProvider,
  now: () => number = Date.now,
): MarketHistoryServiceImpl {
  return new MarketHistoryServiceImpl({
    provider,
    logger: silent,
    cache: new InMemoryHistoryCache(now),
    now,
  });
}

/** Counts calls, so "did we go out" is a fact rather than an inference. */
function counting(answer: () => Promise<readonly HistoryPoint[] | null>) {
  const calls: { itemId: string; range: MarketRange }[] = [];
  const provider: PriceHistoryProvider = {
    async history(itemId, range) {
      calls.push({ itemId, range });
      return answer();
    },
  };
  return { provider, calls };
}

test("a series comes back oldest first, whatever order the source used", async () => {
  // Coflnet happens to send oldest-first, but a chart drawn backwards is the
  // kind of bug nobody reports and everybody misreads, so the order is ours.
  const { provider } = counting(async () => [point(3 * HOUR, 30), point(HOUR, 10), point(2 * HOUR, 20)]);
  const dto = await service(provider).history("HYPERION", "DAY");

  assert.deepEqual(dto?.points.map((p) => p.avg), [10, 20, 30]);
  assert.equal(dto?.points[0]?.at, new Date(HOUR).toISOString());
  assert.equal(dto?.range, "DAY");
});

test("the same item asked for twice inside the window costs one request", async () => {
  const c = clock();
  const { provider, calls } = counting(async () => [point(HOUR, 10)]);
  const svc = service(provider, c.now);

  await svc.history("HYPERION", "WEEK");
  await svc.history("HYPERION", "WEEK");
  assert.equal(calls.length, 1);

  c.advance(HISTORY_TTL_MS.WEEK + 1);
  await svc.history("HYPERION", "WEEK");
  assert.equal(calls.length, 2);
});

test("each range is its own series, not a cache hit on the last one", async () => {
  const { provider, calls } = counting(async () => [point(HOUR, 10)]);
  const svc = service(provider);

  await svc.history("HYPERION", "DAY");
  await svc.history("HYPERION", "WEEK");
  assert.deepEqual(calls.map((c) => c.range), ["DAY", "WEEK"]);
});

test("a burst on one cold item is one request, not one per press", async () => {
  // Two people pressing Week on the same card in the same second is the normal
  // case, not the exotic one.
  let release = (): void => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const { provider, calls } = counting(async () => {
    await gate;
    return [point(HOUR, 10)];
  });
  const svc = service(provider);

  const both = Promise.all([svc.history("HYPERION", "DAY"), svc.history("HYPERION", "DAY")]);
  release();
  const [a, b] = await both;

  assert.equal(calls.length, 1);
  assert.deepEqual(a?.points, b?.points);
});

test("an item with no recorded past is an empty series, and stays cached as one", async () => {
  // Empty is an answer about the item. Asking again in a second cannot change
  // it, so it is cached like any other answer.
  const { provider, calls } = counting(async () => []);
  const svc = service(provider);

  assert.deepEqual((await svc.history("NEW_ITEM", "DAY"))?.points, []);
  await svc.history("NEW_ITEM", "DAY");
  assert.equal(calls.length, 1);
});

test("a failure is null rather than an empty series, and is not cached", async () => {
  // A flat chart and a missing chart say opposite things about an item.
  const { provider, calls } = counting(async () => null);
  const svc = service(provider);

  assert.equal(await svc.history("HYPERION", "DAY"), null);
  assert.equal(await svc.history("HYPERION", "DAY"), null);
  assert.equal(calls.length, 2, "a failed read must not be remembered as an answer");
});

test("a provider that throws is counted as a failure rather than escaping", async () => {
  const svc = service({
    async history() {
      throw new Error("socket hang up");
    },
  });
  assert.equal(await svc.history("HYPERION", "DAY"), null);
});

test("consecutive failures stop the calls, and time lets them start again", async () => {
  const c = clock();
  const { provider, calls } = counting(async () => null);
  const svc = service(provider, c.now);

  for (let i = 0; i < BREAKER_THRESHOLD; i += 1) await svc.history(`ITEM_${String(i)}`, "DAY");
  assert.equal(calls.length, BREAKER_THRESHOLD);

  // Open: no further requests leave, whatever is asked for.
  assert.equal(await svc.history("HYPERION", "DAY"), null);
  assert.equal(calls.length, BREAKER_THRESHOLD);

  c.advance(BREAKER_COOLDOWN_MS + 1);
  await svc.history("HYPERION", "DAY");
  assert.equal(calls.length, BREAKER_THRESHOLD + 1, "the breaker must heal on its own");
});

test("one success in the middle clears the count, so a blip is not an outage", async () => {
  const c = clock();
  let answer: readonly HistoryPoint[] | null = null;
  const { provider, calls } = counting(async () => answer);
  const svc = service(provider, c.now);

  await svc.history("A", "DAY");
  await svc.history("B", "DAY");
  answer = [point(HOUR, 10)];
  await svc.history("C", "DAY");
  answer = null;
  await svc.history("D", "DAY");
  await svc.history("E", "DAY");

  // Five reads, none of them refused: the two failures either side of a success
  // never reached the threshold together.
  assert.equal(calls.length, 5);
});

test("an open breaker still serves what is already cached", async () => {
  // "Stop calling out" is not "forget what we know". A series read a minute ago
  // is still the best answer available.
  const c = clock();
  let answer: readonly HistoryPoint[] | null = [point(HOUR, 10)];
  const { provider } = counting(async () => answer);
  const svc = service(provider, c.now);

  await svc.history("HYPERION", "WEEK");
  answer = null;
  for (let i = 0; i < BREAKER_THRESHOLD; i += 1) await svc.history(`OTHER_${String(i)}`, "DAY");

  assert.deepEqual((await svc.history("HYPERION", "WEEK"))?.points.length, 1);
});

test("a cache that throws is a cache miss, not a failed lookup", async () => {
  // Redis going down must cost latency, not answers.
  const { provider } = counting(async () => [point(HOUR, 10)]);
  const svc = new MarketHistoryServiceImpl({
    provider,
    logger: silent,
    cache: {
      async get() {
        throw new Error("redis down");
      },
      async set() {
        throw new Error("redis down");
      },
    },
  });

  assert.equal((await svc.history("HYPERION", "DAY"))?.points.length, 1);
});

import assert from "node:assert/strict";
import test from "node:test";

import { forEachLimit, mapLimit } from "./concurrency.js";

const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

test("results come back in input order however they finished", async () => {
  const out = await mapLimit([30, 10, 20], 3, async (ms) => {
    await new Promise((r) => setTimeout(r, ms));
    return ms;
  });
  assert.deepEqual(
    out.map((r) => (r.ok ? r.value : null)),
    [30, 10, 20],
  );
});

test("no more than `limit` are ever in flight", async () => {
  let live = 0;
  let peak = 0;
  await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
    live += 1;
    peak = Math.max(peak, live);
    await tick();
    live -= 1;
  });
  assert.equal(peak, 4);
});

test("one failure does not cancel the rest", async () => {
  // The property every bulk pass in this package already relied on: an
  // unreadable member costs that member's row, not the batch.
  const out = await mapLimit([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error("nope");
    return n;
  });
  assert.deepEqual(out.map((r) => r.ok), [true, false, true]);
  assert.equal(out[1]?.ok === false && (out[1].error as Error).message, "nope");
});

test("a limit of one is the serial loop it replaced", async () => {
  const seen: number[] = [];
  let live = 0;
  await mapLimit([1, 2, 3], 1, async (n) => {
    assert.equal(live, 0, "two ran at once under a limit of one");
    live += 1;
    await tick();
    seen.push(n);
    live -= 1;
  });
  assert.deepEqual(seen, [1, 2, 3]);
});

test("a nonsense limit slows the pass down rather than breaking it", async () => {
  // The failure mode of a throughput knob somebody typed wrong.
  for (const limit of [0, -3, Number.NaN]) {
    const out = await mapLimit([1, 2], limit, async (n) => n);
    assert.deepEqual(out.map((r) => (r.ok ? r.value : null)), [1, 2]);
  }
});

test("nothing to do costs no workers", async () => {
  let ran = 0;
  assert.deepEqual(await mapLimit([], 8, async () => (ran += 1)), []);
  assert.equal(ran, 0);
});

test("forEachLimit reports only what went wrong", async () => {
  const errors = await forEachLimit([1, 2, 3], 2, async (n) => {
    if (n !== 2) return;
    throw new Error("second");
  });
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, "second");
});

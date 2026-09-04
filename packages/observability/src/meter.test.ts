import assert from "node:assert/strict";
import test from "node:test";

import { createCallMeter, installMeterLog } from "./meter.js";

test("calls, failures and rate limits are counted apart from one another", () => {
  const meter = createCallMeter();
  meter.record("hypixel", 100);
  meter.record("hypixel", 300, { failed: true });
  // Retried and succeeded: the limit was real, the call was not a failure.
  meter.record("hypixel", 900, { rateLimited: true });

  const [stats] = meter.current();
  assert.equal(stats?.calls, 3);
  assert.equal(stats?.failures, 1);
  assert.equal(stats?.rateLimited, 1);
  assert.equal(stats?.meanMs, 433);
  assert.equal(stats?.maxMs, 900);
});

test("a rate limit reported from inside a client queue is not a call", () => {
  // discord.js says this before the request goes out, so counting it as a call
  // would inflate the very number the ratio is measured against.
  const meter = createCallMeter();
  meter.rateLimited("discord");
  const [stats] = meter.current();
  assert.equal(stats?.calls, 0);
  assert.equal(stats?.rateLimited, 1);
});

test("surfaces are kept apart and reported busiest first", () => {
  const meter = createCallMeter();
  meter.record("hypixel", 10);
  meter.record("discord", 10);
  meter.record("discord", 10);
  assert.deepEqual(
    meter.current().map((s) => s.surface),
    ["discord", "hypixel"],
  );
});

test("draining reports the window and starts the next one empty", () => {
  const meter = createCallMeter();
  meter.record("discord", 40);
  assert.equal(meter.drain()[0]?.calls, 1);
  assert.deepEqual(meter.drain(), []);
});

test("a nonsense duration still counts the call", () => {
  // A clock that went backwards must not lose the fact that we made a request.
  const meter = createCallMeter();
  meter.record("discord", Number.NaN);
  meter.record("discord", -5);
  const [stats] = meter.current();
  assert.equal(stats?.calls, 2);
  assert.equal(stats?.totalMs, 0);
});

test("a quiet window logs nothing at all", () => {
  const lines: string[] = [];
  const meter = createCallMeter();
  let tick = (): void => {};
  installMeterLog(
    meter,
    { info: (msg) => lines.push(msg) },
    {
      intervalMs: 1,
      setInterval: ((fn: () => void) => {
        tick = fn;
        return { unref() {} } as unknown as NodeJS.Timeout;
      }) as unknown as typeof setInterval,
    },
  );

  tick();
  assert.deepEqual(lines, [], "an idle process should be silent");
  meter.record("discord", 5);
  tick();
  assert.deepEqual(lines, ["upstream throughput"]);
});

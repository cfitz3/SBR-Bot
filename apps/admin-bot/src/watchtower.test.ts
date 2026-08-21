/**
 * The watchtower is only useful if it is quiet. These tests are mostly about
 * what it does *not* say: no alert on a single missed beat, no repeat of a
 * status it has already reported, nothing at all without a channel.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger } from "@sbr/observability";
import type { HealthReportDTO } from "@sbr/shared-types";
import {
  BEAT_STALE_MS,
  readFleet,
  watchOnce,
  WATCHED_SERVICES,
  type FleetBeat,
  type WatchtowerDeps,
  type WatchtowerState,
} from "./watchtower.js";

const silent: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

const NOW = Date.parse("2026-08-21T12:00:00.000Z");

/** Beats for the named services, all fresh unless listed in `stale`. */
function beats(services: readonly string[], stale: readonly string[] = []): FleetBeat[] {
  return services.map((service) => ({
    service,
    instance: `${service}-1`,
    at: new Date(NOW - (stale.includes(service) ? BEAT_STALE_MS + 5_000 : 1_000)).toISOString(),
  }));
}

function healthy(): HealthReportDTO {
  return {
    status: "ok",
    checkedAt: new Date(NOW).toISOString(),
    components: [
      { name: "postgres", status: "ok", latencyMs: 3 },
      { name: "redis", status: "ok", latencyMs: 1 },
    ],
  };
}

interface Harness extends WatchtowerDeps {
  readonly posts: { channelId: string; text: string }[];
}

function deps(overrides: Partial<WatchtowerDeps> = {}): Harness {
  const posts: { channelId: string; text: string }[] = [];
  return {
    posts,
    async listBeats() {
      return beats([...WATCHED_SERVICES]);
    },
    async health() {
      return healthy();
    },
    channelId: () => "chan-1",
    async post(channelId, text) {
      posts.push({ channelId, text });
      return true;
    },
    log: silent,
    now: () => NOW,
    ...overrides,
  };
}

function state(): WatchtowerState {
  return { last: null, strikes: 0 };
}

test("a fleet where everything is beating reads ok", async () => {
  const report = await readFleet(deps());
  assert.equal(report.status, "ok");
  assert.deepEqual(report.silent, []);
  assert.deepEqual(report.unhealthy, []);
});

test("one silent service is degraded; two is down", async () => {
  const one = await readFleet(deps({ listBeats: async () => beats([...WATCHED_SERVICES], ["workers"]) }));
  assert.equal(one.status, "degraded");
  assert.deepEqual(one.silent, ["workers"]);

  const two = await readFleet(
    deps({ listBeats: async () => beats([...WATCHED_SERVICES], ["workers", "web-panel"]) }),
  );
  assert.equal(two.status, "down");
  assert.deepEqual(two.silent, ["workers", "web-panel"]);
});

test("a service that never beat at all is silent, not absent", async () => {
  const report = await readFleet(deps({ listBeats: async () => [] }));
  assert.deepEqual(report.silent, [...WATCHED_SERVICES]);
});

test("the newest instance decides whether a service is alive", async () => {
  const report = await readFleet(
    deps({
      listBeats: async () => [
        { service: "workers", instance: "old", at: new Date(NOW - 10 * BEAT_STALE_MS).toISOString() },
        { service: "workers", instance: "new", at: new Date(NOW - 1_000).toISOString() },
        ...beats(["bridge-bot", "admin-bot", "web-panel"]),
      ],
    }),
  );
  assert.deepEqual(report.silent, []);
});

test("a component that is down outranks a single silent service", async () => {
  const report = await readFleet(
    deps({
      async health() {
        return {
          status: "down",
          checkedAt: new Date(NOW).toISOString(),
          components: [{ name: "postgres", status: "down", latencyMs: null, detail: "ECONNREFUSED" }],
        };
      },
    }),
  );
  assert.equal(report.status, "down");
  assert.deepEqual(report.unhealthy, [{ name: "postgres", status: "down", detail: "ECONNREFUSED" }]);
});

test("a heartbeat read that throws is an unreadable fleet, not a crash", async () => {
  const report = await readFleet(
    deps({
      listBeats: async () => {
        throw new Error("redis gone");
      },
    }),
  );
  assert.equal(report.status, "down");
});

test("a beat with an unparseable timestamp counts as no beat", async () => {
  const report = await readFleet(
    deps({ listBeats: async () => [{ service: "workers", instance: "w-1", at: "whenever" }] }),
  );
  assert.ok(report.silent.includes("workers"));
});

test("one bad pass is a grace pass; the second one speaks", async () => {
  const d = deps({ listBeats: async () => beats([...WATCHED_SERVICES], ["workers"]) });
  const s = state();

  assert.equal(await watchOnce(d, s), null);
  assert.equal(d.posts.length, 0);

  const said = await watchOnce(d, s);
  assert.ok(said);
  assert.match(said, /Fleet degraded/);
  assert.match(said, /Silent: workers/);
  assert.equal(d.posts[0]?.channelId, "chan-1");
});

test("a status that has already been reported is not repeated", async () => {
  const d = deps({ listBeats: async () => beats([...WATCHED_SERVICES], ["workers"]) });
  const s = state();

  await watchOnce(d, s);
  await watchOnce(d, s);
  await watchOnce(d, s);
  await watchOnce(d, s);

  assert.equal(d.posts.length, 1);
});

test("degraded worsening into down is a new thing to say", async () => {
  let stale = ["workers"];
  const d = deps({ listBeats: async () => beats([...WATCHED_SERVICES], stale) });
  const s = state();

  await watchOnce(d, s);
  await watchOnce(d, s);
  stale = ["workers", "web-panel"];
  await watchOnce(d, s);

  assert.equal(d.posts.length, 2);
  assert.match(d.posts[1]?.text ?? "", /Fleet down/);
});

test("recovery is announced once, and healthy passes after it are silent", async () => {
  let stale = ["workers"];
  const d = deps({ listBeats: async () => beats([...WATCHED_SERVICES], stale) });
  const s = state();

  await watchOnce(d, s);
  await watchOnce(d, s);
  stale = [];
  const recovery = await watchOnce(d, s);
  assert.match(recovery ?? "", /Fleet recovered/);

  await watchOnce(d, s);
  await watchOnce(d, s);
  assert.equal(d.posts.length, 2);
});

test("a fleet that was never unhealthy does not announce a recovery on boot", async () => {
  const d = deps();
  const s = state();

  await watchOnce(d, s);
  assert.equal(d.posts.length, 0);
});

test("a single bad pass followed by a good one resets the strike count", async () => {
  let stale = ["workers"];
  const d = deps({ listBeats: async () => beats([...WATCHED_SERVICES], stale) });
  const s = state();

  await watchOnce(d, s);
  stale = [];
  await watchOnce(d, s);
  stale = ["workers"];
  // First strike again — the earlier one must not carry over.
  assert.equal(await watchOnce(d, s), null);
  assert.equal(d.posts.length, 0);
});

test("no configured channel is silence rather than an error", async () => {
  const d = deps({
    channelId: () => null,
    listBeats: async () => beats([...WATCHED_SERVICES], ["workers", "web-panel"]),
  });
  const s = state();

  await watchOnce(d, s);
  assert.equal(await watchOnce(d, s), null);
  assert.equal(d.posts.length, 0);
});

test("a post that does not land is logged, not reported as said", async () => {
  const warned: string[] = [];
  const d = deps({
    listBeats: async () => beats([...WATCHED_SERVICES], ["workers"]),
    async post() {
      return false;
    },
    log: { ...silent, warn: (msg: string) => void warned.push(msg) },
  });
  const s = state();

  await watchOnce(d, s);
  assert.equal(await watchOnce(d, s), null);
  assert.deepEqual(warned, ["watchtower alert did not land"]);
});

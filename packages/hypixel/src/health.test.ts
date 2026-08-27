import assert from "node:assert/strict";
import { test } from "node:test";
import type { HypixelObservation } from "./client.js";
import { hypixelCheck, OBSERVATION_TTL_MS } from "./health.js";

const NOW = Date.parse("2026-08-22T09:00:00.000Z");

function check(last: HypixelObservation | null, at = NOW) {
  return hypixelCheck({ lastUpstream: () => last }, () => at).check();
}

function seen(over: Partial<HypixelObservation>): HypixelObservation {
  return { at: new Date(NOW).toISOString(), ok: false, ...over };
}

test("nothing asked yet reads as ok, because the probe costs no requests", async () => {
  // The alternative is a request per health read, spending the guild's shared
  // budget on a diagnostic — most of all when members are running `/health`
  // because something is already wrong.
  assert.equal((await check(null)).status, "ok");
});

test("a throttled key is degraded, not down", async () => {
  assert.equal((await check(seen({ reason: "RATE_LIMITED" }))).status, "degraded");
});

test("a rejected key and an unreachable API are both outages", async () => {
  assert.equal((await check(seen({ reason: "API_DISABLED" }))).status, "down");
  assert.equal((await check(seen({ reason: "UNREACHABLE" }))).status, "down");
});

test("a failure nobody has retried since goes stale rather than staying red", async () => {
  const stale = seen({ reason: "UNREACHABLE" });
  assert.equal((await check(stale, NOW + OBSERVATION_TTL_MS - 1)).status, "down");
  // The outage it recorded may have ended twenty minutes ago and nothing has
  // asked since. That is not news.
  assert.equal((await check(stale, NOW + OBSERVATION_TTL_MS + 1)).status, "ok");
});

test("a success clears a previous failure", async () => {
  assert.equal((await check(seen({ ok: true }))).status, "ok");
});

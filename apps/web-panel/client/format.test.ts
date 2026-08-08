import assert from "node:assert/strict";
import { test } from "node:test";
import {
  count,
  countdown,
  describeSpan,
  duration,
  humanizeJob,
  localInputToIso,
  parseDurationSeconds,
  ratio,
  relativeTime,
} from "./format.js";

const NOW = Date.parse("2026-08-07T12:00:00.000Z");

test("counts are grouped, and absent values read as a dash", () => {
  assert.equal(count(1234567), "1,234,567");
  assert.equal(count(0), "0");
  assert.equal(count(null), "—");
});

test("relative time picks the largest useful unit", () => {
  assert.equal(relativeTime("2026-08-07T11:59:40.000Z", NOW), "less than a minute ago");
  assert.equal(relativeTime("2026-08-07T11:57:00.000Z", NOW), "3 minutes ago");
  assert.equal(relativeTime("2026-08-07T09:00:00.000Z", NOW), "3 hours ago");
  assert.equal(relativeTime("2026-08-05T12:00:00.000Z", NOW), "2 days ago");
});

test("singular units are not pluralised", () => {
  assert.equal(describeSpan(60_000), "1 minute");
  assert.equal(describeSpan(3_600_000), "1 hour");
  assert.equal(describeSpan(86_400_000), "1 day");
});

/**
 * A job that has never succeeded is the case the freshness badge exists for, so
 * it has to render as something a human reads as wrong — not as an empty cell.
 */
test("a missing timestamp reads as never, not as an error", () => {
  assert.equal(relativeTime(null, NOW), "never");
  assert.equal(relativeTime(undefined, NOW), "never");
  assert.equal(relativeTime("not a date", NOW), "unknown");
});

/** Clock skew between the worker box and the viewer's browser is normal. */
test("a future timestamp does not render as negative time", () => {
  assert.equal(relativeTime("2026-08-07T12:05:00.000Z", NOW), "in the future");
});

test("durations switch units at the thresholds a job run crosses", () => {
  assert.equal(duration(412), "412ms");
  assert.equal(duration(1500), "1.5s");
  assert.equal(duration(95_000), "1m 35s");
  assert.equal(duration(null), "—");
});

test("ratios degrade to a bare count when the denominator is zero", () => {
  assert.equal(ratio(12, 40), "12 of 40 (30%)");
  assert.equal(ratio(0, 0), "0");
});

test("job ids are title-cased for display", () => {
  assert.equal(humanizeJob("guild-roster-sync"), "Guild Roster Sync");
  assert.equal(humanizeJob("ah-sweep"), "Ah Sweep");
});

test("durations parse the shorthand staff actually type", () => {
  assert.equal(parseDurationSeconds("90s"), 90);
  assert.equal(parseDurationSeconds("30m"), 1_800);
  assert.equal(parseDurationSeconds(" 2H "), 7_200);
  assert.equal(parseDurationSeconds("7d"), 604_800);
  assert.equal(parseDurationSeconds("2w"), 1_209_600);
});

/**
 * Blank and malformed have to stay distinguishable: blank is a permanent ban,
 * malformed is a typo, and collapsing the two would turn "2 hrs" into forever.
 */
test("a blank duration is permanent and a malformed one is refused", () => {
  assert.equal(parseDurationSeconds(""), null);
  assert.equal(parseDurationSeconds("   "), null);
  assert.equal(parseDurationSeconds("2 hrs"), "invalid");
  assert.equal(parseDurationSeconds("forever"), "invalid");
  assert.equal(parseDurationSeconds("0m"), "invalid");
  assert.equal(parseDurationSeconds("-5m"), "invalid");
});

/** Events run in both directions, unlike job freshness which only ever looks back. */
test("a countdown reads forwards as well as backwards", () => {
  assert.equal(countdown("2026-08-07T15:00:00.000Z", NOW), "in 3 hours");
  assert.equal(countdown("2026-08-05T12:00:00.000Z", NOW), "2 days ago");
  assert.equal(countdown("2026-08-07T12:00:30.000Z", NOW), "now");
  assert.equal(countdown(null, NOW), "—");
  assert.equal(countdown("not a date", NOW), "unknown");
});

/**
 * The value a `datetime-local` input holds carries no zone. Reading it as local
 * time is the whole point — treating it as UTC would shift every event by the
 * scheduler's offset — so this asserts the round trip rather than a literal.
 */
test("a datetime-local value is read in the viewer's zone", () => {
  const iso = localInputToIso("2026-09-01T18:30");
  assert.equal(iso, new Date(2026, 8, 1, 18, 30).toISOString());
  assert.equal(localInputToIso("  "), null);
  assert.equal(localInputToIso("whenever"), null);
});

test("the year ceiling matches the one the mutation layer enforces", () => {
  assert.equal(parseDurationSeconds("365d"), 31_536_000);
  assert.equal(parseDurationSeconds("366d"), "invalid");
  assert.equal(parseDurationSeconds("53w"), "invalid");
});

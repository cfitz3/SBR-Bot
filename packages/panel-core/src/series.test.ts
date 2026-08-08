import assert from "node:assert/strict";
import { test } from "node:test";
import type { RollupPoint } from "./reads.js";
import { bucketRange, dimValue, MAX_BUCKETS, shapeAnalytics } from "./series.js";

function point(metric: string, bucketStart: string, count: number, dims: unknown = {}): RollupPoint {
  return { metric, bucketStart, count, dims };
}

const WINDOW = { period: "DAILY" as const, since: "2026-08-01T09:30:00.000Z", until: "2026-08-05T11:00:00.000Z" };

test("bucket range is aligned to the period, not to the query time", () => {
  const { buckets } = bucketRange(WINDOW.since, WINDOW.until, "DAILY");
  assert.deepEqual(buckets, [
    "2026-08-01T00:00:00.000Z",
    "2026-08-02T00:00:00.000Z",
    "2026-08-03T00:00:00.000Z",
    "2026-08-04T00:00:00.000Z",
    "2026-08-05T00:00:00.000Z",
  ]);
});

test("weekly buckets start on Monday and monthly on the first", () => {
  const weekly = bucketRange("2026-08-05T00:00:00.000Z", "2026-08-19T00:00:00.000Z", "WEEKLY").buckets;
  assert.deepEqual(weekly, [
    "2026-08-03T00:00:00.000Z",
    "2026-08-10T00:00:00.000Z",
    "2026-08-17T00:00:00.000Z",
  ]);

  const monthly = bucketRange("2026-01-15T00:00:00.000Z", "2026-04-02T00:00:00.000Z", "MONTHLY").buckets;
  assert.deepEqual(monthly, [
    "2026-01-01T00:00:00.000Z",
    "2026-02-01T00:00:00.000Z",
    "2026-03-01T00:00:00.000Z",
    "2026-04-01T00:00:00.000Z",
  ]);
});

/**
 * The reason this module exists: a quiet day writes no rollup row, and a chart
 * that skips it draws a straight line across the gap — which reads as steady
 * traffic instead of none.
 */
test("days with no rows are zero, not missing", () => {
  const charts = shapeAnalytics(
    [
      point("command.used", "2026-08-01T00:00:00.000Z", 5, { command: "stats" }),
      point("command.used", "2026-08-04T00:00:00.000Z", 2, { command: "stats" }),
    ],
    WINDOW,
  );

  assert.equal(charts.length, 1);
  assert.equal(charts[0]?.buckets.length, 5);
  assert.deepEqual(charts[0]?.series[0]?.points, [5, 0, 0, 2, 0]);
  assert.equal(charts[0]?.total, 7);
});

test("a metric is split into one series per primary dimension value", () => {
  const charts = shapeAnalytics(
    [
      point("command.used", "2026-08-01T00:00:00.000Z", 5, { command: "stats", surface: "DISCORD" }),
      point("command.used", "2026-08-01T00:00:00.000Z", 3, { command: "nw" }),
      point("command.used", "2026-08-02T00:00:00.000Z", 1, { command: "nw" }),
    ],
    WINDOW,
  );

  const series = charts[0]?.series ?? [];
  // Ordered by total, so the busiest line is the one the eye lands on.
  assert.deepEqual(
    series.map((s) => [s.label, s.total]),
    [
      ["stats", 5],
      ["nw", 4],
    ],
  );
  assert.deepEqual(series[1]?.points, [3, 1, 0, 0, 0]);
});

test("counts for the same command and bucket are summed across dimension sets", () => {
  const charts = shapeAnalytics(
    [
      point("command.used", "2026-08-01T00:00:00.000Z", 4, { command: "stats", success: "true" }),
      point("command.used", "2026-08-01T00:00:00.000Z", 1, { command: "stats", success: "false" }),
    ],
    WINDOW,
  );
  assert.deepEqual(charts[0]?.series[0]?.points, [5, 0, 0, 0, 0]);
});

test("charts are discovered from the data, busiest metric first", () => {
  const charts = shapeAnalytics(
    [
      point("command.used", "2026-08-01T00:00:00.000Z", 2, { command: "stats" }),
      point("bridge.relay", "2026-08-01T00:00:00.000Z", 40, { direction: "GAME_TO_DISCORD" }),
    ],
    WINDOW,
  );
  assert.deepEqual(
    charts.map((c) => [c.metric, c.total]),
    [
      ["bridge.relay", 40],
      ["command.used", 2],
    ],
  );
});

test("an unknown metric still charts, as a single undifferentiated line", () => {
  const charts = shapeAnalytics([point("something.new", "2026-08-02T00:00:00.000Z", 9)], WINDOW);
  assert.equal(charts[0]?.metric, "something.new");
  assert.equal(charts[0]?.series.length, 1);
  assert.deepEqual(charts[0]?.series[0]?.points, [0, 9, 0, 0, 0]);
});

test("a missing dimension value is labelled rather than dropped", () => {
  const charts = shapeAnalytics([point("command.used", "2026-08-01T00:00:00.000Z", 3, { surface: "PANEL" })], WINDOW);
  assert.equal(charts[0]?.series[0]?.label, "unknown");
  assert.equal(charts[0]?.total, 3);
});

/** Sixty commands would mean sixty indistinguishable lines and a giant legend. */
test("beyond six series the tail collapses into one 'other' line", () => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    point("command.used", "2026-08-01T00:00:00.000Z", 10 - i, { command: `cmd${i}` }),
  );
  const series = shapeAnalytics(rows, WINDOW)[0]?.series ?? [];

  assert.equal(series.length, 6);
  assert.equal(series[5]?.label, "other (5)");
  // 5+4+3+2+1 for cmd5..cmd9 — nothing is lost, only merged.
  assert.equal(series[5]?.total, 15);
  assert.equal(shapeAnalytics(rows, WINDOW)[0]?.total, 55);
});

test("rows outside the window are ignored", () => {
  const charts = shapeAnalytics(
    [
      point("command.used", "2026-07-01T00:00:00.000Z", 99, { command: "stats" }),
      point("command.used", "2026-08-02T00:00:00.000Z", 1, { command: "stats" }),
    ],
    WINDOW,
  );
  assert.equal(charts[0]?.total, 1);
});

test("an hourly year is capped, keeping the recent end and saying so", () => {
  const { buckets, truncated } = bucketRange("2026-01-01T00:00:00.000Z", "2026-08-05T00:00:00.000Z", "HOURLY");
  assert.equal(buckets.length, MAX_BUCKETS);
  assert.equal(truncated, true);
  assert.equal(buckets.at(-1), "2026-08-05T00:00:00.000Z");
});

test("empty input yields no charts rather than empty ones", () => {
  assert.deepEqual(shapeAnalytics([], WINDOW), []);
  // A metric whose rows all fall outside the window has nothing to draw either.
  assert.deepEqual(shapeAnalytics([point("command.used", "2020-01-01T00:00:00.000Z", 5)], WINDOW), []);
});

test("dimValue reads strings only, from a blob that may be anything", () => {
  assert.equal(dimValue({ command: "stats" }, "command"), "stats");
  assert.equal(dimValue({ command: 7 }, "command"), null);
  assert.equal(dimValue(null, "command"), null);
  assert.equal(dimValue("not an object", "command"), null);
});

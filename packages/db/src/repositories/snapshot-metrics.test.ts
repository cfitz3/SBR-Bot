/**
 * The JSON side of the snapshot catalog.
 *
 * Worth testing without a database because the whole point of this module is a
 * distinction that is easy to lose in a round trip: absent means "this row
 * predates the metric", and an explicit null means "we looked and found
 * nothing". Collapsing the two would turn every old row into a claim that the
 * profile was read and came back empty.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { COLUMN_METRICS, JSON_METRICS, packJsonMetrics, unpackJsonMetrics } from "./snapshot-metrics.js";

test("the two halves partition the catalog without overlapping", () => {
  const overlap = COLUMN_METRICS.filter((m) => (JSON_METRICS as readonly string[]).includes(m));
  assert.deepEqual(overlap, []);
});

test("packing keeps explicit nulls and drops absent keys", () => {
  assert.deepEqual(packJsonMetrics({ classTank: null, classMage: 42 }), {
    classTank: null,
    classMage: 42,
  });
  // An absent key is not "null on the way out" — it is one that was never read.
  assert.deepEqual(packJsonMetrics({ classMage: 42 }), { classMage: 42 });
  // And the same holds for a key present with an undefined value, which is what
  // a widened `SnapshotMetrics` looks like at runtime under a loose caller.
  assert.deepEqual(
    packJsonMetrics({ classTank: undefined, classMage: 42 } as unknown as Record<string, number | null>),
    { classMage: 42 },
  );
  assert.deepEqual(packJsonMetrics({}), {});
});

test("unpacking a row written before the metrics existed yields nothing", () => {
  assert.deepEqual(unpackJsonMetrics({}), {});
  assert.deepEqual(unpackJsonMetrics(null), {});
  assert.deepEqual(unpackJsonMetrics(undefined), {});
  // A column that somehow holds a scalar or an array is not a metric bag.
  assert.deepEqual(unpackJsonMetrics(7), {});
  assert.deepEqual(unpackJsonMetrics("{}"), {});
  assert.deepEqual(unpackJsonMetrics([1, 2]), {});
});

test("unpacking drops anything that is not a number or an explicit null", () => {
  const out = unpackJsonMetrics({
    classMage: 42,
    classTank: null,
    classArcher: "30",
    classHealer: Number.NaN,
    classBerserk: Number.POSITIVE_INFINITY,
    // A key from a newer deployment, or a typo: not a metric, not carried.
    somethingElse: 5,
  });
  assert.deepEqual(out, { classMage: 42, classTank: null });
});

test("a pack round-trips through JSON unchanged", () => {
  const packed = packJsonMetrics({ classMage: 42, classTank: null, slayerVampire: 0 });
  assert.deepEqual(unpackJsonMetrics(JSON.parse(JSON.stringify(packed))), {
    classMage: 42,
    classTank: null,
    // Zero is a real reading — a member who has never touched the boss — and
    // has to survive, which a falsy check here would not let it do.
    slayerVampire: 0,
  });
});

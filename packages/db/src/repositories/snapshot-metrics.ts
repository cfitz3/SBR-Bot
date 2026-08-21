/**
 * The half of a snapshot's readings that lives in JSON rather than in columns.
 *
 * `ProfileSnapshot` has a column each for the six original metrics — they are
 * charted, ordered by, and compared in SQL, and a JSON path would make all
 * three awkward. The widened catalog (per-class dungeon levels, per-boss slayer
 * XP, the bestiary milestone) is only ever read whole, for one account, so it
 * rides in the `metrics` JSON column instead. That is a deliberate trade: a
 * metric that turns out to be a bad idea costs a deploy to remove rather than a
 * migration, and adding the next one costs nothing at all.
 *
 * If one of these ever needs to be charted or ranked in SQL, promoting it to a
 * column is the right move — and the assertion below is what will make the
 * compiler point at every place that has to change.
 */
import { SNAPSHOT_MILESTONE_METRICS, type SnapshotMilestoneMetric } from "@sbr/shared-types";

/** The six with columns of their own. */
export const COLUMN_METRICS = [
  "skyblockLevel",
  "networth",
  "skillAverage",
  "catacombsLevel",
  "slayerXp",
  "senitherWeight",
] as const;

/** Everything else, stored in `ProfileSnapshot.metrics`. */
export const JSON_METRICS = [
  "classHealer",
  "classMage",
  "classBerserk",
  "classArcher",
  "classTank",
  "slayerZombie",
  "slayerSpider",
  "slayerWolf",
  "slayerEnderman",
  "slayerBlaze",
  "slayerVampire",
  "bestiaryMilestone",
] as const;

export type JsonMetric = (typeof JSON_METRICS)[number];

/**
 * Compile-time check that the two halves partition the catalog. A metric added
 * to `SNAPSHOT_MILESTONE_METRICS` and to neither list would otherwise be
 * accepted by the panel, stored on a definition, and then silently never read.
 */
const _everyMetricIsStoredSomewhere: readonly (SnapshotMilestoneMetric)[] = [
  ...COLUMN_METRICS,
  ...JSON_METRICS,
];
const _everyStoredMetricIsReal: readonly ((typeof COLUMN_METRICS)[number] | JsonMetric)[] =
  SNAPSHOT_MILESTONE_METRICS;
void _everyMetricIsStoredSomewhere;
void _everyStoredMetricIsReal;

/**
 * The JSON-backed readings of a snapshot, for the `metrics` column.
 *
 * Absent readings are left out rather than written as null: `{}` on a row
 * captured before a metric existed and `{"classTank": null}` on a profile whose
 * dungeon read failed are genuinely different facts, and only the second one
 * means "we looked".
 */
export function packJsonMetrics(source: Partial<Record<JsonMetric, number | null>>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const key of JSON_METRICS) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The inverse. Anything not a finite number or an explicit null is dropped. */
export function unpackJsonMetrics(value: unknown): Partial<Record<JsonMetric, number | null>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const out: Partial<Record<JsonMetric, number | null>> = {};
  for (const key of JSON_METRICS) {
    if (!(key in source)) continue;
    const raw = source[key];
    if (raw === null) out[key] = null;
    else if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
  }
  return out;
}

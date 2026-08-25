/**
 * Turns the flat `RollupPoint` rows the analytics job writes into chart-ready
 * series.
 *
 * Two things this does that a chart library can't do for us:
 *
 * 1. **Zero-fills empty buckets.** A day with no commands produces no rollup row
 *    at all. Plotting only the rows that exist draws a line straight across the
 *    gap, which reads as "steady traffic" when the truth is "nothing happened" —
 *    the opposite conclusion.
 * 2. **Discovers metrics from the data.** Only `command.used` is emitted today
 *    (AnalyticsServiceImpl.capture), but `emit()` is open and the rollup job
 *    already knows how to break down bridge relays, mod actions, and filter hits.
 *    Deriving the chart list from what's in the rows means those appear on the
 *    page the day something starts emitting them, with no change here.
 */
import { bucketStart, type MetricPeriod } from "@sbr/analytics";
import type { RollupPoint } from "./reads.js";

/**
 * The dimension each metric is broken down by on the chart — the first entry of
 * the rollup job's own DIM_KEYS, which is the one that carries the shape of the
 * metric rather than a qualifier.
 */
const PRIMARY_DIMENSION: Readonly<Record<string, string>> = {
  "command.used": "command",
  "bridge.relay": "direction",
  "mod.action": "type",
  "mod.action.failed": "type",
  "filter.hit": "rule",
};

const METRIC_LABELS: Readonly<Record<string, string>> = {
  "command.used": "Command usage",
  "bridge.relay": "Bridge messages",
  "mod.action": "Moderation actions",
  "mod.action.failed": "Failed enforcement",
  "filter.hit": "Filter hits",
};

/**
 * Series drawn separately before the rest collapse into "other".
 *
 * A guild with sixty commands would otherwise get sixty indistinguishable lines,
 * and the legend would be taller than the chart.
 */
const MAX_SERIES = 6;

/**
 * Buckets a single chart will render. An hourly range over a year is ~8,760
 * points — more than the pixels available and more than anyone reads.
 */
export const MAX_BUCKETS = 400;

export interface ChartSeries {
  /** Dimension value, or `""` when the metric has no breakdown. */
  readonly key: string;
  readonly label: string;
  /** One count per entry of the parent chart's `buckets`, zero-filled. */
  readonly points: readonly number[];
  readonly total: number;
}

export interface MetricChart {
  readonly metric: string;
  readonly label: string;
  /** Inclusive bucket starts, ascending, ISO-8601 UTC. */
  readonly buckets: readonly string[];
  readonly series: readonly ChartSeries[];
  readonly total: number;
  /** True when older buckets were dropped to stay under MAX_BUCKETS. */
  readonly truncated: boolean;
}

/** Step one bucket in either direction. UTC throughout, as the rollup job buckets. */
function step(iso: string, period: MetricPeriod, sign: 1 | -1): string {
  const d = new Date(iso);
  switch (period) {
    case "HOURLY":
      d.setUTCHours(d.getUTCHours() + sign);
      break;
    case "DAILY":
      d.setUTCDate(d.getUTCDate() + sign);
      break;
    case "WEEKLY":
      d.setUTCDate(d.getUTCDate() + 7 * sign);
      break;
    case "MONTHLY":
      // setUTCMonth handles the short-month rollover; every MONTHLY bucket
      // start is day 1, so there is no 31st-of-February case to land on.
      d.setUTCMonth(d.getUTCMonth() + sign);
      break;
  }
  return d.toISOString();
}

/**
 * Every bucket start in `[since, until]`, aligned the same way the rollup job
 * aligns them.
 *
 * Built backwards from `until` so that hitting MAX_BUCKETS drops the *oldest*
 * buckets. Walking forwards and trimming afterwards is the same thing only if
 * the walk is allowed to run to the end of the range — and an hourly year is
 * long enough that any loop bound cheap enough to be safe would stop partway,
 * leaving a chart labelled "last 365 days" that ends in March.
 */
export function bucketRange(
  since: string,
  until: string,
  period: MetricPeriod,
): { buckets: string[]; truncated: boolean } {
  const first = bucketStart(since, period);
  const last = bucketStart(until, period);
  if (Number.isNaN(Date.parse(first)) || Number.isNaN(Date.parse(last))) {
    return { buckets: [], truncated: false };
  }

  const floor = Date.parse(first);
  const buckets: string[] = [];
  let cursor = last;
  let truncated = false;

  while (Date.parse(cursor) >= floor) {
    if (buckets.length >= MAX_BUCKETS) {
      truncated = true;
      break;
    }
    buckets.push(cursor);
    cursor = step(cursor, period, -1);
  }

  buckets.reverse();
  return { buckets, truncated };
}

/** Read one dimension off a rollup row's opaque `dims` blob. */
export function dimValue(dims: unknown, key: string): string | null {
  if (typeof dims !== "object" || dims === null) return null;
  const value = (dims as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

export interface ShapeOptions {
  readonly period: MetricPeriod;
  readonly since: string;
  readonly until: string;
}

/** One chart per metric present in `rollups`, largest total first. */
export function shapeAnalytics(rollups: readonly RollupPoint[], opts: ShapeOptions): MetricChart[] {
  const { buckets, truncated } = bucketRange(opts.since, opts.until, opts.period);
  if (buckets.length === 0) return [];

  const metrics = [...new Set(rollups.map((r) => r.metric))];
  return metrics
    .map((metric) => shapeMetric(rollups, metric, buckets, truncated))
    .filter((chart) => chart.total > 0)
    .sort((a, b) => b.total - a.total);
}

function shapeMetric(
  rollups: readonly RollupPoint[],
  metric: string,
  buckets: readonly string[],
  truncated: boolean,
): MetricChart {
  const index = new Map(buckets.map((bucket, i) => [bucket, i]));
  const dimension = PRIMARY_DIMENSION[metric] ?? null;

  // key → per-bucket counts
  const bySeries = new Map<string, number[]>();
  for (const row of rollups) {
    if (row.metric !== metric) continue;
    const slot = index.get(row.bucketStart);
    if (slot === undefined) continue; // outside the window, or a trimmed bucket

    const key = dimension ? (dimValue(row.dims, dimension) ?? "unknown") : "";
    let points = bySeries.get(key);
    if (!points) {
      points = new Array<number>(buckets.length).fill(0);
      bySeries.set(key, points);
    }
    points[slot] = (points[slot] ?? 0) + row.count;
  }

  const all: ChartSeries[] = [...bySeries.entries()]
    .map(([key, points]) => ({
      key,
      label: key === "" ? (METRIC_LABELS[metric] ?? metric) : key,
      points,
      total: points.reduce((sum, n) => sum + n, 0),
    }))
    .sort((a, b) => b.total - a.total);

  return {
    metric,
    label: METRIC_LABELS[metric] ?? metric,
    buckets,
    series: collapseTail(all, buckets.length),
    total: all.reduce((sum, s) => sum + s.total, 0),
    truncated,
  };
}

/** Keep the biggest MAX_SERIES; sum the rest into a single "other" line. */
function collapseTail(series: readonly ChartSeries[], bucketCount: number): ChartSeries[] {
  if (series.length <= MAX_SERIES) return [...series];

  const kept = series.slice(0, MAX_SERIES - 1);
  const tail = series.slice(MAX_SERIES - 1);
  const points = new Array<number>(bucketCount).fill(0);
  for (const s of tail) {
    for (let i = 0; i < bucketCount; i += 1) points[i] = (points[i] ?? 0) + (s.points[i] ?? 0);
  }

  return [
    ...kept,
    {
      key: "__other__",
      label: `other (${tail.length})`,
      points,
      total: tail.reduce((sum, s) => sum + s.total, 0),
    },
  ];
}

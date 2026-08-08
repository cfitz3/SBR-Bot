/**
 * Pure daily-rollup reducer (WORKERS.md analytics-rollup). Aggregates raw events
 * into guild-scoped metric counts by (guildId, metric, day, dimensions).
 * Idempotent and rebuildable: given the same events it yields the same rows.
 */
import type { AnalyticsEvent } from "@sbr/shared-types";

export interface MetricRow {
  readonly guildId: string | null;
  readonly metric: string;
  readonly day: string; // YYYY-MM-DD
  readonly dims: Readonly<Record<string, string>>;
  readonly count: number;
}

/** Which prop/dimension keys to break each metric down by. */
const DIM_KEYS: Readonly<Record<string, readonly string[]>> = {
  "command.used": ["command", "surface", "success"],
  "bridge.relay": ["direction"],
  "mod.action": ["type"],
  "filter.hit": ["rule", "action"],
};

function pickDims(event: AnalyticsEvent): Record<string, string> {
  const keys = DIM_KEYS[event.type] ?? [];
  const merged: Record<string, unknown> = { ...(event.props ?? {}), surface: event.surface };
  const dims: Record<string, string> = {};
  for (const k of keys) {
    if (merged[k] !== undefined) dims[k] = String(merged[k]);
  }
  return dims;
}

export function rollupDaily(events: readonly AnalyticsEvent[]): MetricRow[] {
  const acc = new Map<string, MetricRow>();

  for (const event of events) {
    const day = event.ts.slice(0, 10);
    const dims = pickDims(event);
    const key = JSON.stringify([event.guildId, event.type, day, dims]);

    const existing = acc.get(key);
    if (existing) {
      acc.set(key, { ...existing, count: existing.count + 1 });
    } else {
      acc.set(key, { guildId: event.guildId, metric: event.type, day, dims, count: 1 });
    }
  }

  return [...acc.values()];
}

/** The rollup grains ANALYTICS.md §3 defines. */
export type MetricPeriod = "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";

export interface PeriodMetricRow {
  readonly guildId: string | null;
  readonly metric: string;
  readonly period: MetricPeriod;
  /** Inclusive start of the bucket, ISO-8601 and always UTC. */
  readonly bucketStart: string;
  readonly dims: Readonly<Record<string, string>>;
  readonly count: number;
}

/**
 * Truncate a timestamp to the start of its bucket.
 *
 * All grains are UTC. Guild-local day boundaries are a scheduling concern —
 * *when* the daily job runs — not a bucketing one; mixing the two would make a
 * rebuild depend on which timezone the guild was in when the job first ran.
 */
export function bucketStart(iso: string, period: MetricPeriod): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;

  switch (period) {
    case "HOURLY":
      d.setUTCMinutes(0, 0, 0);
      break;
    case "DAILY":
      d.setUTCHours(0, 0, 0, 0);
      break;
    case "WEEKLY": {
      d.setUTCHours(0, 0, 0, 0);
      // ISO weeks start on Monday; getUTCDay() calls Sunday 0.
      const shift = (d.getUTCDay() + 6) % 7;
      d.setUTCDate(d.getUTCDate() - shift);
      break;
    }
    case "MONTHLY":
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(1);
      break;
  }
  return d.toISOString();
}

/**
 * Aggregate raw events at any grain.
 *
 * A pure reduction, which is what makes the documented recovery path work: drop
 * a partition, feed the same events back in, and you get byte-identical rows.
 * Nothing here reads a clock or a previous rollup.
 */
export function rollupEvents(events: readonly AnalyticsEvent[], period: MetricPeriod): PeriodMetricRow[] {
  const acc = new Map<string, PeriodMetricRow>();

  for (const event of events) {
    const start = bucketStart(event.ts, period);
    const dims = pickDims(event);
    const key = JSON.stringify([event.guildId, event.type, start, dims]);

    const existing = acc.get(key);
    acc.set(
      key,
      existing
        ? { ...existing, count: existing.count + 1 }
        : { guildId: event.guildId, metric: event.type, period, bucketStart: start, dims, count: 1 },
    );
  }

  return [...acc.values()];
}

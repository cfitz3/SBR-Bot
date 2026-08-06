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

/**
 * Which progression metrics a guild puts in front of its members.
 *
 * The tracker records every metric in the catalog for everyone — that costs one
 * profile read either way, and a reading not taken is history that can never be
 * recovered. What a guild chooses is narrower: which of them the `/progression`
 * card *offers*, in the select menu and as goal targets.
 *
 * That distinction is the whole point of this setting. A dungeon-focused guild
 * wants Catacombs and the five class levels at the top of the menu and does not
 * want to scroll past Alchemy to reach them; a farming guild wants the reverse.
 * Neither wants a menu of thirty-odd entries, which is what "offer everything"
 * would be. Capping the offered set keeps the card legible without ever costing
 * a member a number the platform already holds — switching a metric back on
 * shows its whole history immediately, because it was being captured all along.
 *
 * Tolerant on read, strict on write, like every other policy in this package.
 */
import { SNAPSHOT_MILESTONE_METRICS, type SnapshotMilestoneMetric } from "@sbr/shared-types";

export const PROGRESSION_SETTING_KEY = "progression.metrics";

/**
 * Discord's select menu holds 25 options and a card that offers more than that
 * has stopped being a card. The floor is one: a guild that wants members
 * watching exactly one number is making a real choice, and an empty set is not
 * a choice but a broken command.
 */
export const MAX_OFFERED_METRICS = 25;

/**
 * What a guild that has never opened the page gets.
 *
 * The six with columns of their own, which are also the six that were the whole
 * trackable set before this: an install that upgrades sees no change until
 * somebody chooses one, and a fresh install sees the numbers most members ask
 * about first.
 */
export const DEFAULT_PROGRESSION_METRICS: readonly SnapshotMilestoneMetric[] = Object.freeze([
  "skyblockLevel",
  "networth",
  "skillAverage",
  "catacombsLevel",
  "slayerXp",
  "senitherWeight",
]);

export interface ProgressionPolicy {
  /** In the order the card offers them — the guild's own ordering, preserved. */
  readonly metrics: readonly SnapshotMilestoneMetric[];
}

export const DEFAULT_PROGRESSION_POLICY: ProgressionPolicy = Object.freeze({
  metrics: DEFAULT_PROGRESSION_METRICS,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMetric(value: unknown): value is SnapshotMilestoneMetric {
  return typeof value === "string" && (SNAPSHOT_MILESTONE_METRICS as readonly string[]).includes(value);
}

/**
 * Read the stored document, dropping only what cannot be understood.
 *
 * A metric retired from the catalog since the guild saved its choice is dropped
 * rather than rejected: the rest of their ordering is still exactly what they
 * asked for, and refusing the whole document over one dead name would silently
 * reset a page they spent time on.
 */
export function parseProgressionPolicy(raw: unknown): ProgressionPolicy {
  if (!isRecord(raw)) return DEFAULT_PROGRESSION_POLICY;
  const list = Array.isArray(raw["metrics"]) ? raw["metrics"] : null;
  if (list === null) return DEFAULT_PROGRESSION_POLICY;

  const seen = new Set<SnapshotMilestoneMetric>();
  for (const entry of list) {
    if (isMetric(entry)) seen.add(entry);
  }
  // An empty result falls back rather than offering nothing: a guild whose every
  // chosen metric has been retired should get the defaults back, not a card with
  // an empty menu and no way to fix it from Discord.
  if (seen.size === 0) return DEFAULT_PROGRESSION_POLICY;
  return { metrics: [...seen].slice(0, MAX_OFFERED_METRICS) };
}

/** The strict half, for the panel: the first thing wrong with this blob, or null. */
export function validateProgressionPolicy(raw: unknown): string | null {
  if (!isRecord(raw)) return "progression settings must be an object";
  const list = raw["metrics"];
  if (!Array.isArray(list)) return "metrics must be a list";
  if (list.length === 0) return "pick at least one metric";
  if (list.length > MAX_OFFERED_METRICS) return `at most ${MAX_OFFERED_METRICS} metrics`;
  const seen = new Set<string>();
  for (const entry of list) {
    if (!isMetric(entry)) return `${String(entry)} is not a metric this platform records`;
    if (seen.has(entry)) return `${entry} is listed twice`;
    seen.add(entry);
  }
  return null;
}

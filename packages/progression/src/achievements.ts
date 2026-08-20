/**
 * Achievements — a guild's milestone definitions joined to one member's record
 * and latest measurements.
 *
 * Pure by design: the join is the whole of the logic, and keeping it out of the
 * service means it can be tested against every awkward shape (an earned row
 * whose definition was since deleted, a threshold of zero, an unmeasured
 * metric) without a database or a Hypixel client in the room.
 */
import { categoryOfMetric } from "@sbr/shared-types";
import type {
  AchievementDTO,
  AchievementsDTO,
  MilestoneDTO,
  MilestoneDefinitionDTO,
  SnapshotMetricsDTO,
} from "@sbr/shared-types";

/**
 * Identity of an achievement *as recorded*. Milestone rows carry no definition
 * key — detection writes the metric and the threshold it crossed — so this pair
 * is the only thing an earned row and a definition reliably share. It is also
 * what the detector's uniqueness is built on, so a match here means the same
 * achievement in both directions.
 */
function recordKey(metric: string, threshold: number): string {
  return `${metric}:${threshold}`;
}

/** The member's reading for a metric, or null when it was never measured. */
function reading(snapshot: SnapshotMetricsDTO | null, metric: string): number | null {
  if (snapshot === null) return null;
  const value = (snapshot as unknown as Record<string, unknown>)[metric];
  return typeof value === "number" ? value : null;
}

function fraction(current: number | null, threshold: number): number | null {
  if (current === null) return null;
  // A threshold of zero is met by existing. Dividing would give Infinity or NaN.
  if (threshold <= 0) return 1;
  return Math.max(0, Math.min(1, current / threshold));
}

export function buildAchievements(
  definitions: readonly MilestoneDefinitionDTO[],
  earnedRows: readonly MilestoneDTO[],
  snapshot: SnapshotMetricsDTO | null,
  options: { readonly configured: boolean } = { configured: true },
): AchievementsDTO {
  // First crossing wins: a member who re-crosses a threshold (a networth dip and
  // recovery, a profile switch) earned it on the earlier date, and reporting the
  // later one would quietly move an achievement's anniversary.
  const earnedAt = new Map<string, string>();
  for (const row of earnedRows) {
    const key = recordKey(row.metric, row.thresholdValue);
    const seen = earnedAt.get(key);
    if (seen === undefined || row.achievedAt < seen) earnedAt.set(key, row.achievedAt);
  }

  const earned: AchievementDTO[] = [];
  const upcoming: AchievementDTO[] = [];
  const matched = new Set<string>();
  let hiddenLocked = 0;

  for (const def of definitions) {
    // A disabled definition is one the guild has stopped recognising. It stays
    // in the panel so staff can switch it back on, but it is not something a
    // member is working towards, so it is absent here entirely.
    if (!def.enabled) continue;

    const key = recordKey(def.metric, def.threshold);
    matched.add(key);
    const current = reading(snapshot, def.metric);
    const achievedAt = earnedAt.get(key) ?? null;
    const entry: AchievementDTO = {
      key: def.key,
      label: def.label,
      description: def.description,
      type: def.type,
      metric: def.metric,
      threshold: def.threshold,
      xpReward: def.xpReward,
      current,
      progress: achievedAt !== null ? 1 : fraction(current, def.threshold),
      achievedAt,
      tier: def.tier,
      icon: def.icon,
      category: categoryOfMetric(def.metric),
      hidden: def.hidden,
    };

    if (achievedAt !== null) {
      // Earning a hidden achievement is exactly when it stops being hidden: the
      // reveal is the reward, and a member who cannot see what they got has
      // been given nothing.
      earned.push(entry);
      continue;
    }
    if (def.hidden) {
      hiddenLocked += 1;
      continue;
    }
    upcoming.push(entry);
  }

  // Earned rows no live definition claims: a definition deleted or re-thresholded
  // since. The member still did it, and dropping it would make an achievement
  // disappear from their record because staff edited a config. It pays no XP
  // here because the reward figure belongs to a definition that no longer exists.
  for (const row of earnedRows) {
    const key = recordKey(row.metric, row.thresholdValue);
    if (matched.has(key)) continue;
    matched.add(key);
    earned.push({
      key,
      label: row.label ?? `${row.metric} ${row.thresholdValue}`,
      description: null,
      type: row.type,
      metric: row.metric,
      threshold: row.thresholdValue,
      xpReward: 0,
      current: reading(snapshot, row.metric),
      progress: 1,
      achievedAt: earnedAt.get(key) ?? row.achievedAt,
      // The definition that would have said otherwise is gone, so this is what
      // is left that is true: it was earned, and the metric says where it fits.
      tier: "BRONZE",
      icon: null,
      category: categoryOfMetric(row.metric),
      hidden: false,
    });
  }

  earned.sort((a, b) => (b.achievedAt ?? "").localeCompare(a.achievedAt ?? ""));
  // Closest first, and an unmeasured metric last: "we don't know" is less useful
  // to a member than any real number, however far off it is.
  upcoming.sort((a, b) => (b.progress ?? -1) - (a.progress ?? -1));

  return {
    earned,
    upcoming,
    earnedCount: earned.length,
    // Hidden-and-locked entries are counted but never named, so a member can
    // tell there is more without being told what.
    totalCount: earned.length + upcoming.length + hiddenLocked,
    hiddenLocked,
    xpEarned: earned.reduce((sum, a) => sum + a.xpReward, 0),
    measuredAt: snapshot?.capturedAt ?? null,
    configured: options.configured,
  };
}

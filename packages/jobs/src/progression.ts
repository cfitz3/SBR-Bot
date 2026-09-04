/**
 * Progression jobs (WORKERS.md §2.5–2.6): `profile-refresh` keeps each member's
 * current reading up to date, and `milestone-detect` turns the pair of readings
 * on that row — current and the one it displaced — into announceable
 * achievements.
 *
 * **This job does not build a history, and that is a policy constraint rather
 * than a design preference.** Appending a reading per member per run is the
 * "session tracking" pattern the Hypixel Developer API Policy prohibits
 * outright (docs/HYPIXEL_COMPLIANCE.md §1). So the write is an upsert: one row
 * per `(account, profile)`, carrying its own previous reading and nothing
 * older. Members who want to compare over time save snapshots explicitly.
 *
 * The Hypixel budget is the other design constraint. A ~125-member guild
 * refreshed naively would spend its whole rate allowance on people who are
 * offline, so refreshes are batched, spread, and skipped when the account was
 * read recently — and a member whose fetch fails is logged past, never retried
 * in a tight loop.
 */
import {
  isCommunityMetric,
  SNAPSHOT_MILESTONE_METRICS,
  type AchievementTier,
  type MilestoneMetric as SharedMilestoneMetric,
  type SnapshotMilestoneMetric as SharedSnapshotMetric,
} from "@sbr/shared-types";

import { forEachLimit } from "./concurrency.js";

export interface TrackedAccount {
  readonly minecraftAccountId: string;
  readonly uuid: string;
  /** Selected profile, or null to let the provider pick the active one. */
  readonly profileId: string | null;
  /** ISO-8601 of the most recent snapshot, or null if never captured. */
  readonly lastCapturedAt: string | null;
}

/** The metrics a snapshot records. Absent data is null, never zero. */
/**
 * The six with columns of their own on `ProfileSnapshot`. They are charted,
 * ordered by and compared in SQL, which a JSON path would make awkward.
 */
export type CoreSnapshotMetric =
  | "skyblockLevel"
  | "networth"
  | "skillAverage"
  | "catacombsLevel"
  | "slayerXp"
  | "senitherWeight";

/**
 * Derived from the shared catalog rather than restated here.
 *
 * This was a hand-written list of every metric, which meant adding one to the
 * catalog compiled cleanly and then silently never got captured. Now the six
 * column-backed readings are required, everything else the catalog knows about
 * is optional, and a new metric appears here the moment it is declared.
 *
 * Optional rather than nullable for the widened set: a capture from before a
 * metric existed genuinely does not carry it, and `undefined` says that, where
 * a `null` invented at read time would claim we looked and saw nothing.
 */
export type SnapshotMetrics = Readonly<Record<CoreSnapshotMetric, number | null>> &
  Partial<Readonly<Record<Exclude<SharedSnapshotMetric, CoreSnapshotMetric>, number | null>>>;

/**
 * One refreshed reading, as `profile-refresh` writes it.
 *
 * Deliberately flat and deliberately without a sequence number: there is no
 * ordering to establish because there is only ever one row per profile.
 */
export interface ProfileReading extends SnapshotMetrics {
  readonly minecraftAccountId: string;
  readonly profileId: string;
  readonly capturedAt: string;
}

/** The only three ways a `ProfileSnapshot` row comes into existence. */
export type SnapshotSource = "USER_SAVED" | "EVENT_BASELINE" | "EVENT_FINAL";

/**
 * A snapshot somebody asked for: a member saving a marker to compare against
 * later, or an event recording where a participant started and finished.
 *
 * Nothing on a timer writes one of these. That is the distinction the whole
 * redesign turns on — a row here exists because a person or a bounded event
 * boundary called for it, not because a clock ticked.
 */
export interface SnapshotWrite extends SnapshotMetrics {
  readonly minecraftAccountId: string;
  readonly profileId: string;
  readonly capturedAt: string;
  readonly source: SnapshotSource;
  /** Set on the event boundaries, null on a member-saved marker. */
  readonly eventId: string | null;
  /** Discord id of whoever pressed save, null for event boundaries. */
  readonly savedBy: string | null;
  readonly label: string | null;
}

export interface ProfileRefreshDeps {
  listTracked(): Promise<readonly TrackedAccount[]>;
  /** null when the account has no readable profile (API off, no profiles). */
  capture(account: TrackedAccount): Promise<{ profileId: string; metrics: SnapshotMetrics } | null>;
  write(reading: ProfileReading): Promise<void>;
  /** Called after each write so `milestone-detect` can run per member. */
  onReading?: (reading: ProfileReading) => Promise<void>;
  /**
   * Called when `write` or `onReading` throws for one account, instead of
   * letting the throw leave the loop.
   *
   * Opt-in, because the two callers want different things from a failed write.
   * `profile-refresh` wants the throw: a database that will not take a snapshot
   * is a run-level problem and the retry belongs to the job runner. Event
   * tracking wants isolation: one participant whose score row failed must not
   * cost the rest of that event's roster their poll, and the next tick will
   * pick them back up. Whoever supplies this takes responsibility for logging.
   */
  onAccountError?: (account: TrackedAccount, error: unknown) => void;
  now?: () => Date;
  /** Cap per run, so one tick can't consume the whole rate budget. */
  batchSize?: number;
  /** Skip accounts read more recently than this. */
  minIntervalMs?: number;
  /**
   * How many accounts to have in the air at once.
   *
   * The cap above says how much of the budget a run may spend; this says how
   * fast it may spend it. They are different questions, and conflating them is
   * why a 25-account pass used to take most of a minute of pure waiting against
   * an upstream that answers eight at a time without noticing.
   *
   * The Hypixel client is still the thing that enforces the actual limits — the
   * shared rate gate, the per-player window, the 429 backoff — so raising this
   * cannot exceed them; it can only stop us from being slower than they require.
   */
  concurrency?: number;
}

const DEFAULT_BATCH = 25;

/**
 * Accounts fetched at once, by default.
 *
 * Four, which is a quarter of a small guild's roster in flight and well inside
 * anything Hypixel has ever objected to. `HYPIXEL_CONCURRENCY` moves it; the
 * `hypixel` line in the throughput log is how you find out whether it should be
 * moved, because a rate-limited count that is still zero means there is room.
 */
const DEFAULT_CONCURRENCY = 4;
/**
 * Refresh cadence floor. Sits well above the one-hour per-player cap the policy
 * sets, so the schedule is inside the cap by construction rather than by the
 * limiter having to catch it.
 */
const DEFAULT_MIN_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * One refresh pass. Returns the number of rows written.
 *
 * Accounts are ordered oldest-read-first, which spreads the guild across
 * successive runs on its own: whoever went longest without a refresh is always
 * next, so no explicit scheduling table is needed. That ordering decides which
 * accounts are in the batch; within the batch they are fetched several at a
 * time, because the order in which 25 already-chosen members are refreshed is
 * not something anybody can observe.
 */
export async function refreshProfiles(deps: ProfileRefreshDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const minInterval = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

  const due = [...(await deps.listTracked())]
    .filter((a) => {
      if (a.lastCapturedAt === null) return true;
      const last = Date.parse(a.lastCapturedAt);
      return !Number.isFinite(last) || now.getTime() - last >= minInterval;
    })
    .sort((a, b) => (a.lastCapturedAt ?? "").localeCompare(b.lastCapturedAt ?? ""))
    .slice(0, deps.batchSize ?? DEFAULT_BATCH);

  let written = 0;
  const failures = await forEachLimit(due, deps.concurrency ?? DEFAULT_CONCURRENCY, async (account) => {
    const captured = await deps.capture(account).catch(() => null);
    // A member whose profile can't be read (API access off, or an upstream
    // blip) is skipped silently rather than failing the batch — one unreadable
    // account must not cost the other 124 their refresh.
    if (captured === null) return;

    const reading: ProfileReading = {
      minecraftAccountId: account.minecraftAccountId,
      profileId: captured.profileId,
      capturedAt: now.toISOString(),
      ...captured.metrics,
    };
    try {
      await deps.write(reading);
      if (deps.onReading) await deps.onReading(reading);
    } catch (error) {
      // Without a handler this rethrows, which is `profile-refresh`'s
      // behaviour and stays it. It surfaces below rather than here, because a
      // throw out of one of several concurrent passes has to be collected
      // before it can be re-raised.
      if (deps.onAccountError === undefined) throw error;
      deps.onAccountError(account, error);
      return;
    }
    // Safe unsynchronised: every one of these resumes on the same event-loop
    // turn as the await above, and JavaScript has no preemption between them.
    written += 1;
  });

  // The first is enough. A database that refused one snapshot refused them all,
  // and the job runner's retry is what this is being handed to.
  if (failures.length > 0) throw failures[0];
  return written;
}

// ─────────────────────────────── milestones ───────────────────────────────

export type MilestoneType =
  | "SKYBLOCK_LEVEL"
  | "SKILL_LEVEL"
  | "CATACOMBS_LEVEL"
  | "SLAYER_TIER"
  | "NETWORTH_THRESHOLD"
  | "COLLECTION"
  | "CUSTOM";

// The metric vocabulary lives in the contract layer, where the panel can also
// reach it; re-exported here so the detector's callers have one import. The
// annotation is a compile-time assertion that the two agree: if a field is
// added to a snapshot without being added to the list (or the reverse), this
// line stops the build rather than letting a metric silently never fire.
export { isMilestoneMetric } from "@sbr/shared-types";
export type MilestoneMetric = SharedMilestoneMetric;
/**
 * Compile-time check that every snapshot metric is a field a snapshot carries.
 *
 * Only the snapshot half: the community metrics are deliberately not fields
 * here, which is what stops `detectMilestones` from ever being handed one.
 */
const _metricsAreSnapshotFields: readonly (keyof SnapshotMetrics)[] = SNAPSHOT_MILESTONE_METRICS;
void _metricsAreSnapshotFields;

/**
 * One threshold worth recognising.
 *
 * `id` is null for the built-in defaults: they are not rows, so a milestone
 * detected from one records no `definitionId`. That is the difference the
 * schema's nullable column exists to carry.
 */
export interface MilestoneDefinition {
  readonly id: string | null;
  /** Stable across renames — the detector and the panel both key off this. */
  readonly key: string;
  readonly label: string;
  readonly type: MilestoneType;
  readonly metric: MilestoneMetric;
  readonly threshold: number;
  /** Guild XP credited once, when the milestone is announced. */
  readonly xpReward: number;
  readonly announce: boolean;
  readonly enabled: boolean;
  /** Presentation only — the detector never reads it. */
  readonly tier: AchievementTier;
  readonly icon: string | null;
  readonly hidden: boolean;
}

function def(
  key: string,
  label: string,
  type: MilestoneType,
  metric: MilestoneMetric,
  threshold: number,
  tier: AchievementTier = "BRONZE",
): MilestoneDefinition {
  return {
    id: null,
    key,
    label,
    type,
    metric,
    threshold,
    xpReward: 0,
    announce: true,
    enabled: true,
    tier,
    // The defaults ship no icons: an emoji is a guild's own voice, and a
    // platform-chosen one is the first thing every guild would want to change.
    icon: null,
    hidden: false,
  };
}

/**
 * What a guild is measured against before it configures anything.
 *
 * Round numbers on purpose: the point is a moment the guild recognises, not
 * every incremental gain. All carry `xpReward: 0` — recognition is free, and a
 * guild opts into paying for progress rather than opting out.
 */
export const DEFAULT_MILESTONE_DEFINITIONS: readonly MilestoneDefinition[] = [
  // SkyBlock Level leads, because it is the one track that advances for anyone
  // who plays at all: skills plateau, dungeons are a sub-community, and networth
  // swings with the market. Every 25 up to 100 and every 50 after, which is
  // roughly how the milestones feel in-game rather than uniformly spaced.
  def("level:50", "SkyBlock Level 50", "SKYBLOCK_LEVEL", "skyblockLevel", 50, "BRONZE"),
  def("level:100", "SkyBlock Level 100", "SKYBLOCK_LEVEL", "skyblockLevel", 100, "BRONZE"),
  def("level:150", "SkyBlock Level 150", "SKYBLOCK_LEVEL", "skyblockLevel", 150, "SILVER"),
  def("level:200", "SkyBlock Level 200", "SKYBLOCK_LEVEL", "skyblockLevel", 200, "SILVER"),
  def("level:250", "SkyBlock Level 250", "SKYBLOCK_LEVEL", "skyblockLevel", 250, "GOLD"),
  def("level:300", "SkyBlock Level 300", "SKYBLOCK_LEVEL", "skyblockLevel", 300, "GOLD"),
  def("level:350", "SkyBlock Level 350", "SKYBLOCK_LEVEL", "skyblockLevel", 350, "PLATINUM"),
  def("level:400", "SkyBlock Level 400", "SKYBLOCK_LEVEL", "skyblockLevel", 400, "PLATINUM"),
  def("networth:1b", "1b networth", "NETWORTH_THRESHOLD", "networth", 1e9, "BRONZE"),
  def("networth:5b", "5b networth", "NETWORTH_THRESHOLD", "networth", 5e9, "SILVER"),
  def("networth:10b", "10b networth", "NETWORTH_THRESHOLD", "networth", 1e10, "SILVER"),
  def("networth:25b", "25b networth", "NETWORTH_THRESHOLD", "networth", 2.5e10, "GOLD"),
  def("networth:50b", "50b networth", "NETWORTH_THRESHOLD", "networth", 5e10, "GOLD"),
  def("networth:100b", "100b networth", "NETWORTH_THRESHOLD", "networth", 1e11, "PLATINUM"),
  def("catacombs:10", "Catacombs 10", "CATACOMBS_LEVEL", "catacombsLevel", 10, "BRONZE"),
  def("catacombs:20", "Catacombs 20", "CATACOMBS_LEVEL", "catacombsLevel", 20, "BRONZE"),
  def("catacombs:25", "Catacombs 25", "CATACOMBS_LEVEL", "catacombsLevel", 25, "SILVER"),
  def("catacombs:30", "Catacombs 30", "CATACOMBS_LEVEL", "catacombsLevel", 30, "SILVER"),
  def("catacombs:35", "Catacombs 35", "CATACOMBS_LEVEL", "catacombsLevel", 35, "GOLD"),
  def("catacombs:40", "Catacombs 40", "CATACOMBS_LEVEL", "catacombsLevel", 40, "GOLD"),
  def("catacombs:45", "Catacombs 45", "CATACOMBS_LEVEL", "catacombsLevel", 45, "PLATINUM"),
  def("catacombs:50", "Catacombs 50", "CATACOMBS_LEVEL", "catacombsLevel", 50, "PLATINUM"),
  def("skill-average:20", "Skill average 20", "SKILL_LEVEL", "skillAverage", 20, "BRONZE"),
  def("skill-average:30", "Skill average 30", "SKILL_LEVEL", "skillAverage", 30, "BRONZE"),
  def("skill-average:40", "Skill average 40", "SKILL_LEVEL", "skillAverage", 40, "SILVER"),
  def("skill-average:45", "Skill average 45", "SKILL_LEVEL", "skillAverage", 45, "SILVER"),
  def("skill-average:50", "Skill average 50", "SKILL_LEVEL", "skillAverage", 50, "GOLD"),
  def("skill-average:55", "Skill average 55", "SKILL_LEVEL", "skillAverage", 55, "GOLD"),
  def("skill-average:60", "Skill average 60", "SKILL_LEVEL", "skillAverage", 60, "PLATINUM"),
  // The five `weight:*` defaults were here and are gone (Part III decision 1).
  // Senither weight is frozen at v1 and does not score newer skills or slayers,
  // so a member who spends a month on Hunting sees the number barely move — a
  // recognition system built on it quietly stops recognising current gameplay.
  // The metric stays queryable, on the snapshot and on `/stats`; it just no
  // longer decides what the guild celebrates. A guild that disagrees can add
  // its own definitions back, on `senitherWeight`, which is still a valid metric.
  def("slayer:1m", "1m slayer XP", "SLAYER_TIER", "slayerXp", 1e6),
  def("slayer:5m", "5m slayer XP", "SLAYER_TIER", "slayerXp", 5e6),
  def("slayer:10m", "10m slayer XP", "SLAYER_TIER", "slayerXp", 1e7),
];

/**
 * The defaults with a guild's own definitions layered over them, by key.
 *
 * Merged rather than replaced so a guild that changes one threshold does not
 * silently lose the other twenty-nine — and so a default can be switched off by
 * storing the same key with `enabled: false`, which a replace-everything model
 * could not express. Disabled definitions are dropped here, so callers never
 * have to remember to check the flag.
 */
export function resolveDefinitions(
  guildDefinitions: readonly MilestoneDefinition[] = [],
): readonly MilestoneDefinition[] {
  const byKey = new Map<string, MilestoneDefinition>();
  for (const d of DEFAULT_MILESTONE_DEFINITIONS) byKey.set(d.key, d);
  for (const d of guildDefinitions) byKey.set(d.key, d);
  return [...byKey.values()].filter((d) => d.enabled);
}

export interface MilestoneCandidate {
  readonly minecraftAccountId: string;
  readonly type: MilestoneType;
  readonly metric: string;
  readonly thresholdValue: number;
  /** The definition that recognised it; null for a built-in default. */
  readonly definitionId: string | null;
  readonly key: string;
  readonly label: string;
  readonly xpReward: number;
  readonly announce: boolean;
}

/**
 * Thresholds crossed between two snapshots.
 *
 * Compares against the *previous* snapshot rather than against stored
 * milestones, so this stays a pure function; the unique constraint on
 * `(account, type, metric, threshold)` is what makes a replay safe. A null
 * previous value means the account was never captured before, and nothing is
 * emitted — otherwise the first snapshot of a long-standing member would
 * announce every threshold they ever passed at once.
 *
 * A definition added *after* a member already passed its threshold will never
 * fire for them, for the same reason: this reports crossings, not standings.
 */
export function detectMilestones(
  minecraftAccountId: string,
  definitions: readonly MilestoneDefinition[],
  previous: SnapshotMetrics | null,
  current: SnapshotMetrics,
): readonly MilestoneCandidate[] {
  if (previous === null) return [];

  const found: MilestoneCandidate[] = [];
  for (const d of definitions) {
    if (!d.enabled) continue;
    // Community metrics are ours, monotonic, and readable at any time, so they
    // are recognised from the standing rather than from a crossing — see
    // `COMMUNITY_MILESTONE_METRICS`. They are not snapshot fields at all, so
    // this guard is also what keeps the two indexes below well typed.
    if (isCommunityMetric(d.metric)) continue;
    const before = previous[d.metric];
    const after = current[d.metric];
    // `undefined` is a snapshot captured before the metric existed, `null` is a
    // profile we read and found nothing in. Neither is a crossing.
    if (before === null || before === undefined || after === null || after === undefined) continue;
    if (before < d.threshold && after >= d.threshold) {
      found.push({
        minecraftAccountId,
        type: d.type,
        metric: d.metric,
        thresholdValue: d.threshold,
        definitionId: d.id,
        key: d.key,
        label: d.label,
        xpReward: d.xpReward,
        announce: d.announce,
      });
    }
  }
  return found;
}

export interface MilestoneDetectDeps {
  /**
   * The account's current reading and the one it displaced, newest first.
   *
   * Two entries at most, and by construction rather than by a `take: 2` — the
   * row stores exactly one previous reading, so there is no third to ask for.
   * A never-refreshed account returns empty; a first refresh returns one.
   */
  recentReadings(minecraftAccountId: string): Promise<readonly SnapshotMetrics[]>;
  /** Insert, ignoring a duplicate — the unique constraint is the real guard. */
  record(candidate: MilestoneCandidate): Promise<boolean>;
  /**
   * What this guild recognises. Omitted means the built-in defaults, which is
   * what a guild that has configured nothing is measured against.
   */
  definitions?: readonly MilestoneDefinition[];
  guildId?: string | null;
}

/** Detects and records milestones for one account. Returns rows created. */
export async function detectAndRecord(minecraftAccountId: string, deps: MilestoneDetectDeps): Promise<number> {
  const [current, previous] = await deps.recentReadings(minecraftAccountId);
  if (!current) return 0;

  const definitions = resolveDefinitions(deps.definitions ?? []);
  let recorded = 0;
  for (const candidate of detectMilestones(minecraftAccountId, definitions, previous ?? null, current)) {
    if (await deps.record(candidate)) recorded += 1;
  }
  return recorded;
}

// ─────────────────────────────── backfill ───────────────────────────────

/**
 * Everything a member already satisfies, whether or not they crossed it here.
 *
 * The standings counterpart to `detectMilestones`, and the reason the two are
 * separate functions rather than one with a flag: crossings are what a guild
 * celebrates, standings are what it *knows*, and only the first is news. Using
 * standings for announcements would congratulate a member for a threshold they
 * passed eight months before the bot existed.
 */
export function standingMilestones(
  minecraftAccountId: string,
  definitions: readonly MilestoneDefinition[],
  current: SnapshotMetrics,
): readonly MilestoneCandidate[] {
  const found: MilestoneCandidate[] = [];
  for (const d of definitions) {
    if (!d.enabled) continue;
    // Community metrics are guild-scoped and this snapshot is account-scoped,
    // so there is nothing here to compare them against. They are recognised
    // from the standing at read time instead — see `buildAchievements`.
    if (isCommunityMetric(d.metric)) continue;
    const value = current[d.metric];
    if (value === null || value === undefined || value < d.threshold) continue;
    found.push({
      minecraftAccountId,
      type: d.type,
      metric: d.metric,
      thresholdValue: d.threshold,
      definitionId: d.id,
      key: d.key,
      label: d.label,
      xpReward: d.xpReward,
      announce: d.announce,
    });
  }
  return found;
}

/** An account to catch up, with the guild whose definitions apply. */
export interface BackfillTarget {
  readonly minecraftAccountId: string;
  readonly guildId: string | null;
  readonly discordId: string | null;
}

export interface MilestoneBackfillDeps {
  /** Accounts with at least one snapshot, in a stable order, paged. */
  listTargets(limit: number, offset: number): Promise<readonly BackfillTarget[]>;
  /** The newest snapshot for an account, or null if it somehow has none. */
  latestSnapshot(minecraftAccountId: string): Promise<SnapshotMetrics | null>;
  /** What that guild recognises. The defaults are layered in by the job. */
  definitionsFor(guildId: string | null): Promise<readonly MilestoneDefinition[]>;
  /**
   * Write the row as *already announced*. Returns false when it existed, which
   * is the common case on a re-run and is not an error.
   */
  record(target: BackfillTarget, candidate: MilestoneCandidate): Promise<boolean>;
  /**
   * Restrict to these definition keys.
   *
   * This is how a newly added definition is caught up without re-walking every
   * threshold in the catalogue: the guild adds "Catacombs 45", the backfill
   * runs for that key alone, and everybody already past it gets a silent row —
   * so the definition starts life reflecting reality instead of announcing
   * itself to half the guild the next time anyone gains a level.
   */
  keys?: readonly string[];
  /** Accounts per page. */
  pageSize?: number;
  /** Hard cap on accounts examined, so one run cannot walk forever. */
  maxAccounts?: number;
}

const DEFAULT_BACKFILL_PAGE = 100;
const DEFAULT_BACKFILL_MAX = 5_000;

/**
 * Record every threshold the guild's members have already passed, silently.
 *
 * Without this the achievement system is stillborn: `detectMilestones` reports
 * crossings, so on the day it goes live a guild of long-standing members has
 * nothing — and the first member to gain a level gets congratulated for a
 * SkyBlock Level 100 they reached last year while everyone else still shows
 * zero. The rows are written with the announcement flag already set, so the
 * backlog is caught up in the database and never in the channel.
 *
 * Returns how many rows were created. A second run creates none: the unique
 * constraint on `(account, type, metric, threshold)` is what makes it safe to
 * run whenever a definition is added.
 */
export async function backfillMilestones(deps: MilestoneBackfillDeps): Promise<number> {
  const pageSize = deps.pageSize ?? DEFAULT_BACKFILL_PAGE;
  const max = deps.maxAccounts ?? DEFAULT_BACKFILL_MAX;
  const only = deps.keys === undefined ? null : new Set(deps.keys);

  // One read per guild rather than per account: a backfill is mostly the same
  // handful of guilds, and definitions cannot change mid-run.
  const byGuild = new Map<string, readonly MilestoneDefinition[]>();
  const definitionsFor = async (guildId: string | null): Promise<readonly MilestoneDefinition[]> => {
    const cacheKey = guildId ?? "";
    const cached = byGuild.get(cacheKey);
    if (cached !== undefined) return cached;
    const resolved = resolveDefinitions(await deps.definitionsFor(guildId));
    const filtered = only === null ? resolved : resolved.filter((d) => only.has(d.key));
    byGuild.set(cacheKey, filtered);
    return filtered;
  };

  let written = 0;
  let seen = 0;
  for (let offset = 0; seen < max; offset += pageSize) {
    const page = await deps.listTargets(Math.min(pageSize, max - seen), offset);
    if (page.length === 0) break;
    seen += page.length;

    for (const target of page) {
      const current = await deps.latestSnapshot(target.minecraftAccountId);
      if (current === null) continue;
      const definitions = await definitionsFor(target.guildId);
      if (definitions.length === 0) continue;

      for (const candidate of standingMilestones(target.minecraftAccountId, definitions, current)) {
        if (await deps.record(target, candidate)) written += 1;
      }
    }

    if (page.length < pageSize) break;
  }
  return written;
}

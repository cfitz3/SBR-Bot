/**
 * Progression jobs (WORKERS.md §2.5–2.6): `profile-snapshot` captures the
 * time-series rows that `/progress` and the panel charts read, and
 * `milestone-detect` turns a pair of consecutive snapshots into announceable
 * achievements.
 *
 * The Hypixel budget is the design constraint. A ~125-member guild refreshed
 * naively would spend its whole rate allowance on people who are offline, so
 * snapshots are batched, spread, and skipped when the account was captured
 * recently — and a member whose fetch fails is logged past, never retried in a
 * tight loop.
 */

export interface TrackedAccount {
  readonly minecraftAccountId: string;
  readonly uuid: string;
  /** Selected profile, or null to let the provider pick the active one. */
  readonly profileId: string | null;
  /** ISO-8601 of the most recent snapshot, or null if never captured. */
  readonly lastCapturedAt: string | null;
}

/** The metrics a snapshot records. Absent data is null, never zero. */
export interface SnapshotMetrics {
  readonly networth: number | null;
  readonly skillAverage: number | null;
  readonly catacombsLevel: number | null;
  readonly slayerXp: number | null;
  readonly senitherWeight: number | null;
}

export interface SnapshotWrite extends SnapshotMetrics {
  readonly minecraftAccountId: string;
  readonly profileId: string;
  /** YYYY-MM-DD bucket the unique key uses. */
  readonly captureDate: string;
  readonly seq: number;
  readonly capturedAt: string;
  readonly source: "SCHEDULED" | "ON_DEMAND" | "EVENT_TRACKED" | "BACKFILL";
  readonly eventId: string | null;
}

export interface ProfileSnapshotDeps {
  listTracked(): Promise<readonly TrackedAccount[]>;
  /** null when the account has no readable profile (API off, no profiles). */
  capture(account: TrackedAccount): Promise<{ profileId: string; metrics: SnapshotMetrics } | null>;
  write(snapshot: SnapshotWrite): Promise<void>;
  /** Called after each write so `milestone-detect` can run per member. */
  onSnapshot?: (snapshot: SnapshotWrite) => Promise<void>;
  now?: () => Date;
  /** Cap per run, so one tick can't consume the whole rate budget. */
  batchSize?: number;
  /** Skip accounts captured more recently than this. */
  minIntervalMs?: number;
  /** EVENT_TRACKED runs pass their event; bulk runs leave it null. */
  source?: SnapshotWrite["source"];
  eventId?: string | null;
}

const DEFAULT_BATCH = 25;
/** Bulk cadence floor — the ~6–12h window WORKERS.md §2.5 specifies. */
const DEFAULT_MIN_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * One snapshot pass. Returns the number of rows written.
 *
 * Accounts are ordered oldest-capture-first, which spreads the guild across
 * successive runs on its own: whoever went longest without a capture is always
 * next, so no explicit scheduling table is needed.
 */
export async function snapshotProfiles(deps: ProfileSnapshotDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const minInterval = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const source = deps.source ?? "SCHEDULED";
  const eventId = deps.eventId ?? null;

  const due = [...(await deps.listTracked())]
    .filter((a) => {
      if (a.lastCapturedAt === null) return true;
      const last = Date.parse(a.lastCapturedAt);
      return !Number.isFinite(last) || now.getTime() - last >= minInterval;
    })
    .sort((a, b) => (a.lastCapturedAt ?? "").localeCompare(b.lastCapturedAt ?? ""))
    .slice(0, deps.batchSize ?? DEFAULT_BATCH);

  let written = 0;
  for (const account of due) {
    const captured = await deps.capture(account).catch(() => null);
    // A member whose profile can't be read (API access off, or an upstream
    // blip) is skipped silently rather than failing the batch — one unreadable
    // account must not cost the other 124 their snapshot.
    if (captured === null) continue;

    const snapshot: SnapshotWrite = {
      minecraftAccountId: account.minecraftAccountId,
      profileId: captured.profileId,
      captureDate: now.toISOString().slice(0, 10),
      // Bulk captures own seq 0 (one row per day, upserted). The event cohort
      // writes many rows a day, so it needs a distinct sequence per capture.
      seq: source === "EVENT_TRACKED" ? Math.floor(now.getTime() / 60_000) % 100_000 : 0,
      capturedAt: now.toISOString(),
      source,
      eventId,
      ...captured.metrics,
    };
    await deps.write(snapshot);
    if (deps.onSnapshot) await deps.onSnapshot(snapshot);
    written += 1;
  }
  return written;
}

// ─────────────────────────────── milestones ───────────────────────────────

export type MilestoneType =
  | "SKILL_LEVEL"
  | "CATACOMBS_LEVEL"
  | "SLAYER_TIER"
  | "NETWORTH_THRESHOLD"
  | "COLLECTION"
  | "CUSTOM";

/** The snapshot fields a definition may be measured against. */
export type MilestoneMetric = keyof SnapshotMetrics;

const METRICS: readonly MilestoneMetric[] = [
  "networth",
  "skillAverage",
  "catacombsLevel",
  "slayerXp",
  "senitherWeight",
];

/** Narrow an untrusted string — a panel body, a stored row — to a real metric. */
export function isMilestoneMetric(value: unknown): value is MilestoneMetric {
  return typeof value === "string" && (METRICS as readonly string[]).includes(value);
}

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
}

function def(
  key: string,
  label: string,
  type: MilestoneType,
  metric: MilestoneMetric,
  threshold: number,
): MilestoneDefinition {
  return { id: null, key, label, type, metric, threshold, xpReward: 0, announce: true, enabled: true };
}

/**
 * What a guild is measured against before it configures anything.
 *
 * Round numbers on purpose: the point is a moment the guild recognises, not
 * every incremental gain. All carry `xpReward: 0` — recognition is free, and a
 * guild opts into paying for progress rather than opting out.
 */
export const DEFAULT_MILESTONE_DEFINITIONS: readonly MilestoneDefinition[] = [
  def("networth:1b", "1b networth", "NETWORTH_THRESHOLD", "networth", 1e9),
  def("networth:5b", "5b networth", "NETWORTH_THRESHOLD", "networth", 5e9),
  def("networth:10b", "10b networth", "NETWORTH_THRESHOLD", "networth", 1e10),
  def("networth:25b", "25b networth", "NETWORTH_THRESHOLD", "networth", 2.5e10),
  def("networth:50b", "50b networth", "NETWORTH_THRESHOLD", "networth", 5e10),
  def("networth:100b", "100b networth", "NETWORTH_THRESHOLD", "networth", 1e11),
  def("catacombs:10", "Catacombs 10", "CATACOMBS_LEVEL", "catacombsLevel", 10),
  def("catacombs:20", "Catacombs 20", "CATACOMBS_LEVEL", "catacombsLevel", 20),
  def("catacombs:25", "Catacombs 25", "CATACOMBS_LEVEL", "catacombsLevel", 25),
  def("catacombs:30", "Catacombs 30", "CATACOMBS_LEVEL", "catacombsLevel", 30),
  def("catacombs:35", "Catacombs 35", "CATACOMBS_LEVEL", "catacombsLevel", 35),
  def("catacombs:40", "Catacombs 40", "CATACOMBS_LEVEL", "catacombsLevel", 40),
  def("catacombs:45", "Catacombs 45", "CATACOMBS_LEVEL", "catacombsLevel", 45),
  def("catacombs:50", "Catacombs 50", "CATACOMBS_LEVEL", "catacombsLevel", 50),
  def("skill-average:20", "Skill average 20", "SKILL_LEVEL", "skillAverage", 20),
  def("skill-average:30", "Skill average 30", "SKILL_LEVEL", "skillAverage", 30),
  def("skill-average:40", "Skill average 40", "SKILL_LEVEL", "skillAverage", 40),
  def("skill-average:45", "Skill average 45", "SKILL_LEVEL", "skillAverage", 45),
  def("skill-average:50", "Skill average 50", "SKILL_LEVEL", "skillAverage", 50),
  def("skill-average:55", "Skill average 55", "SKILL_LEVEL", "skillAverage", 55),
  def("skill-average:60", "Skill average 60", "SKILL_LEVEL", "skillAverage", 60),
  def("weight:5000", "5,000 weight", "CUSTOM", "senitherWeight", 5_000),
  def("weight:10000", "10,000 weight", "CUSTOM", "senitherWeight", 10_000),
  def("weight:15000", "15,000 weight", "CUSTOM", "senitherWeight", 15_000),
  def("weight:20000", "20,000 weight", "CUSTOM", "senitherWeight", 20_000),
  def("weight:25000", "25,000 weight", "CUSTOM", "senitherWeight", 25_000),
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
    const before = previous[d.metric];
    const after = current[d.metric];
    if (before === null || after === null) continue;
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
  /** The two most recent snapshots for an account, newest first. */
  recentSnapshots(minecraftAccountId: string): Promise<readonly SnapshotMetrics[]>;
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
  const [current, previous] = await deps.recentSnapshots(minecraftAccountId);
  if (!current) return 0;

  const definitions = resolveDefinitions(deps.definitions ?? []);
  let recorded = 0;
  for (const candidate of detectMilestones(minecraftAccountId, definitions, previous ?? null, current)) {
    if (await deps.record(candidate)) recorded += 1;
  }
  return recorded;
}

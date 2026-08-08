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

export interface MilestoneCandidate {
  readonly minecraftAccountId: string;
  readonly type: "SKILL_LEVEL" | "CATACOMBS_LEVEL" | "SLAYER_TIER" | "NETWORTH_THRESHOLD" | "COLLECTION" | "CUSTOM";
  readonly metric: string;
  readonly thresholdValue: number;
}

/**
 * Thresholds worth announcing, per metric. Round numbers on purpose: the point
 * is a moment the guild recognises, not every incremental gain.
 */
const THRESHOLDS: Readonly<Record<string, { type: MilestoneCandidate["type"]; steps: readonly number[] }>> = {
  networth: {
    type: "NETWORTH_THRESHOLD",
    steps: [1e9, 5e9, 1e10, 2.5e10, 5e10, 1e11],
  },
  catacombsLevel: {
    type: "CATACOMBS_LEVEL",
    steps: [10, 20, 25, 30, 35, 40, 45, 50],
  },
  skillAverage: {
    type: "SKILL_LEVEL",
    steps: [20, 30, 40, 45, 50, 55, 60],
  },
  senitherWeight: {
    type: "CUSTOM",
    steps: [5_000, 10_000, 15_000, 20_000, 25_000],
  },
};

/**
 * Thresholds crossed between two snapshots.
 *
 * Compares against the *previous* snapshot rather than against stored
 * milestones, so this stays a pure function; the unique constraint on
 * `(account, type, metric, threshold)` is what makes a replay safe. A null
 * previous value means the account was never captured before, and nothing is
 * emitted — otherwise the first snapshot of a long-standing member would
 * announce every threshold they ever passed at once.
 */
export function detectMilestones(
  minecraftAccountId: string,
  previous: SnapshotMetrics | null,
  current: SnapshotMetrics,
): readonly MilestoneCandidate[] {
  if (previous === null) return [];

  const found: MilestoneCandidate[] = [];
  for (const [metric, rule] of Object.entries(THRESHOLDS)) {
    const before = previous[metric as keyof SnapshotMetrics];
    const after = current[metric as keyof SnapshotMetrics];
    if (before === null || after === null) continue;

    for (const threshold of rule.steps) {
      if (before < threshold && after >= threshold) {
        found.push({ minecraftAccountId, type: rule.type, metric, thresholdValue: threshold });
      }
    }
  }
  return found;
}

export interface MilestoneDetectDeps {
  /** The two most recent snapshots for an account, newest first. */
  recentSnapshots(minecraftAccountId: string): Promise<readonly SnapshotMetrics[]>;
  /** Insert, ignoring a duplicate — the unique constraint is the real guard. */
  record(candidate: MilestoneCandidate): Promise<boolean>;
  guildId?: string | null;
}

/** Detects and records milestones for one account. Returns rows created. */
export async function detectAndRecord(minecraftAccountId: string, deps: MilestoneDetectDeps): Promise<number> {
  const [current, previous] = await deps.recentSnapshots(minecraftAccountId);
  if (!current) return 0;

  let recorded = 0;
  for (const candidate of detectMilestones(minecraftAccountId, previous ?? null, current)) {
    if (await deps.record(candidate)) recorded += 1;
  }
  return recorded;
}

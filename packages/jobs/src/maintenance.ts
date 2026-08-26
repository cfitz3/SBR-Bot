/**
 * Housekeeping jobs (WORKERS.md §2.9–2.12): roster reconciliation, inactivity
 * flagging, analytics buffer drain, and config cache invalidation.
 *
 * What these share is that they reconcile two sources of truth that drift apart
 * on their own — Hypixel's guild roster against ours, Redis's buffer against
 * Postgres, cached config against stored config. None of them decide anything;
 * they surface differences and let a human or a command act on them.
 */

// ────────────────────────── guild roster sync ──────────────────────────

export interface RosterMemberLike {
  readonly uuid: string;
  readonly rank: string | null;
  /** Epoch ms the member joined the Hypixel guild, when known. */
  readonly joinedAt: number | null;
}

export interface StoredRosterRow {
  readonly minecraftAccountId: string;
  readonly uuid: string;
  readonly guildRank: string | null;
  readonly active: boolean;
}

export interface RosterDiff {
  /** In Hypixel's roster but not ours (or previously marked departed). */
  readonly joined: readonly RosterMemberLike[];
  /** In ours and active, but gone from Hypixel's roster. */
  readonly left: readonly StoredRosterRow[];
  /** Present in both, but the guild rank changed. */
  readonly rankChanged: readonly { readonly row: StoredRosterRow; readonly rank: string | null }[];
}

/**
 * Compare the two rosters. Pure, so the diff can be shown before it is applied.
 *
 * UUIDs are the join key rather than names, because a rename is not a departure
 * and matching on IGN would report every renamed member as having left and
 * rejoined.
 */
export function diffRoster(
  remote: readonly RosterMemberLike[],
  stored: readonly StoredRosterRow[],
): RosterDiff {
  const norm = (uuid: string): string => uuid.replace(/-/g, "").toLowerCase();
  const remoteByUuid = new Map(remote.map((m) => [norm(m.uuid), m]));
  const storedByUuid = new Map(stored.map((r) => [norm(r.uuid), r]));

  const joined: RosterMemberLike[] = [];
  const rankChanged: { row: StoredRosterRow; rank: string | null }[] = [];
  for (const [uuid, member] of remoteByUuid) {
    const row = storedByUuid.get(uuid);
    if (!row || !row.active) {
      joined.push(member);
    } else if ((row.guildRank ?? null) !== (member.rank ?? null)) {
      rankChanged.push({ row, rank: member.rank ?? null });
    }
  }

  const left = stored.filter((r) => r.active && !remoteByUuid.has(norm(r.uuid)));
  return { joined, left, rankChanged };
}

export interface RosterSyncDeps {
  /** null when Hypixel is unreadable — the sweep then makes no changes. */
  fetchRemoteRoster(guildId: string): Promise<readonly RosterMemberLike[] | null>;
  listStoredRoster(guildId: string): Promise<readonly StoredRosterRow[]>;
  applyJoined(guildId: string, members: readonly RosterMemberLike[]): Promise<void>;
  applyLeft(guildId: string, rows: readonly StoredRosterRow[]): Promise<void>;
  applyRankChanges(
    guildId: string,
    changes: readonly { readonly row: StoredRosterRow; readonly rank: string | null }[],
  ): Promise<void>;
  /**
   * Refuse to apply a diff that removes more than this fraction of the roster.
   * A truncated or errored Hypixel response looks exactly like a mass exodus,
   * and marking 120 people departed is far harder to undo than skipping a run.
   */
  maxLeaveFraction?: number;
}

const DEFAULT_MAX_LEAVE_FRACTION = 0.25;

export interface RosterSyncResult {
  readonly joined: number;
  readonly left: number;
  readonly rankChanged: number;
  /**
   * The uuids this pass actually wrote something about.
   *
   * Membership and rank are auto-role triggers, and this is the only pass that
   * writes `GuildMember.guildRank` — so a caller that only received counts had
   * no way to tell role sync whose facts just changed, and the grant waited for
   * the daily full sweep. The counts stay because callers log them; this is
   * what the caller acts on. Empty whenever `skipped` is set.
   */
  readonly touched: readonly string[];
  /** Set when the departure guard tripped and nothing was applied. */
  readonly skipped?: "unreadable" | "mass-departure";
}

export async function syncRoster(guildId: string, deps: RosterSyncDeps): Promise<RosterSyncResult> {
  const remote = await deps.fetchRemoteRoster(guildId);
  if (remote === null) return { joined: 0, left: 0, rankChanged: 0, touched: [], skipped: "unreadable" };

  const stored = await deps.listStoredRoster(guildId);
  const diff = diffRoster(remote, stored);

  const activeCount = stored.filter((r) => r.active).length;
  const limit = deps.maxLeaveFraction ?? DEFAULT_MAX_LEAVE_FRACTION;
  if (activeCount > 0 && diff.left.length / activeCount > limit) {
    return { joined: 0, left: 0, rankChanged: 0, touched: [], skipped: "mass-departure" };
  }

  if (diff.joined.length > 0) await deps.applyJoined(guildId, diff.joined);
  if (diff.left.length > 0) await deps.applyLeft(guildId, diff.left);
  if (diff.rankChanged.length > 0) await deps.applyRankChanges(guildId, diff.rankChanged);

  const touched = [
    ...new Set([
      ...diff.joined.map((m) => m.uuid),
      ...diff.left.map((r) => r.uuid),
      ...diff.rankChanged.map((c) => c.row.uuid),
    ]),
  ];

  return {
    joined: diff.joined.length,
    left: diff.left.length,
    rankChanged: diff.rankChanged.length,
    touched,
  };
}

// ────────────────────────── inactivity scan ──────────────────────────

export interface ActivityRow {
  readonly minecraftAccountId: string;
  readonly uuid: string;
  /** Epoch ms of last Hypixel login, or null when the API is hidden. */
  readonly lastSeenAt: number | null;
  /** Epoch ms the member joined; new members get a grace period. */
  readonly joinedAt: number | null;
  readonly exempt: boolean;
}

export interface InactivityFlag {
  readonly minecraftAccountId: string;
  readonly inactiveDays: number;
  readonly reason: "INACTIVE" | "UNKNOWN_ACTIVITY";
}

const DAY_MS = 24 * 60 * 60_000;

export interface InactivityScanDeps {
  listActivity(guildId: string): Promise<readonly ActivityRow[]>;
  flag(guildId: string, flags: readonly InactivityFlag[]): Promise<void>;
  /** Days without a login before a member is flagged. */
  thresholdDays?: number;
  /** Days after joining during which nobody is flagged. */
  graceDays?: number;
  now?: () => Date;
}

/**
 * Members who look inactive. Flags only — never a kick.
 *
 * Hidden API settings make `lastSeenAt` null for players who are perfectly
 * active, so those are reported separately as UNKNOWN_ACTIVITY rather than
 * folded in with genuine absences; conflating them would put privacy-conscious
 * members on the same list as people who quit.
 */
export function findInactive(
  rows: readonly ActivityRow[],
  now: Date,
  thresholdDays: number,
  graceDays: number,
): readonly InactivityFlag[] {
  const ms = now.getTime();
  const flags: InactivityFlag[] = [];

  for (const row of rows) {
    if (row.exempt) continue;
    if (row.joinedAt !== null && ms - row.joinedAt < graceDays * DAY_MS) continue;

    if (row.lastSeenAt === null) {
      flags.push({ minecraftAccountId: row.minecraftAccountId, inactiveDays: 0, reason: "UNKNOWN_ACTIVITY" });
      continue;
    }
    const days = Math.floor((ms - row.lastSeenAt) / DAY_MS);
    if (days >= thresholdDays) {
      flags.push({ minecraftAccountId: row.minecraftAccountId, inactiveDays: days, reason: "INACTIVE" });
    }
  }
  return flags;
}

export async function scanInactivity(guildId: string, deps: InactivityScanDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const rows = await deps.listActivity(guildId);
  const flags = findInactive(rows, now, deps.thresholdDays ?? 14, deps.graceDays ?? 7);
  if (flags.length > 0) await deps.flag(guildId, flags);
  return flags.length;
}

// ────────────────────────── analytics ingest ──────────────────────────

export interface AnalyticsIngestDeps {
  /** Drain up to `n` buffered events. Returns them in arrival order. */
  drain(n: number): Promise<readonly unknown[]>;
  /** Persist a batch. Throwing leaves the events unacknowledged. */
  persist(events: readonly unknown[]): Promise<void>;
  /** Acknowledge the batch so a later drain won't return it again. */
  ack(events: readonly unknown[]): Promise<void>;
  batchSize?: number;
  maxBatches?: number;
}

/**
 * Drain the Redis buffer into Postgres in batches.
 *
 * Persist-then-ack, deliberately in that order: a crash between the two replays
 * a batch, which analytics tolerates (rollups are recomputed from scratch), while
 * ack-then-persist would silently lose events with no way to notice.
 */
export async function ingestAnalytics(deps: AnalyticsIngestDeps): Promise<number> {
  const batchSize = deps.batchSize ?? 500;
  const maxBatches = deps.maxBatches ?? 20;

  let total = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const events = await deps.drain(batchSize);
    if (events.length === 0) break;
    await deps.persist(events);
    await deps.ack(events);
    total += events.length;
    // A short batch means the buffer is drained; stop rather than spin.
    if (events.length < batchSize) break;
  }
  return total;
}

// ────────────────────────── config invalidation ──────────────────────────

export interface ConfigInvalidationDeps {
  /** Guilds whose stored config changed since the last sweep. */
  listChangedGuilds(since: Date): Promise<readonly string[]>;
  invalidate(guildId: string): Promise<void>;
  /** Persist the new watermark, so the next sweep starts where this ended. */
  setWatermark(at: Date): Promise<void>;
  watermark(): Promise<Date | null>;
  now?: () => Date;
  /** How far back to look when no watermark exists yet. */
  coldStartLookbackMs?: number;
}

/**
 * Evict cached guild config for guilds whose settings changed.
 *
 * A backstop, not the primary path — commands invalidate on write. This exists
 * for the case where a write landed but its invalidation didn't (a Redis blip,
 * a panel edit against a different process), which would otherwise leave a guild
 * running on stale config until the TTL expired.
 */
export async function invalidateConfigCaches(deps: ConfigInvalidationDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const lookback = deps.coldStartLookbackMs ?? 60 * 60_000;
  const since = (await deps.watermark()) ?? new Date(now.getTime() - lookback);

  const guilds = await deps.listChangedGuilds(since);
  for (const guildId of guilds) await deps.invalidate(guildId);

  // Only advance after every eviction succeeded; a throw above re-covers the
  // same window next run, and evicting twice costs nothing.
  await deps.setWatermark(now);
  return guilds.length;
}

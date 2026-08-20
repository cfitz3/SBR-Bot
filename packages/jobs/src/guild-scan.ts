/**
 * `guild-scan` — the rolling snapshot of the in-game guild roster that the rest
 * of the platform reads instead of calling Hypixel.
 *
 * Deliberately *not* the same job as `guild-roster-sync`. That one reconciles
 * platform membership, which is keyed by Discord account and drives roles and
 * access. This one caches the Hypixel guild as it actually is — including the
 * majority of members who have never linked a Discord account — plus the GEXP
 * series, because Hypixel's `expHistory` window is only about a week wide and
 * everything downstream (XP, tenure, leaderboards, perm roster autofill) needs
 * more history than that.
 *
 * The two facts that shape the code:
 *
 * - **Today's GEXP is still climbing.** Writing it is correct, but only as an
 *   overwrite. Every write here is an upsert keyed on (guild, uuid, day), so a
 *   day scanned four times converges on its final value rather than summing to
 *   four times the truth.
 * - **A partial roster is a lie, not a subset.** If the fetch fails, nothing is
 *   written and nothing is marked absent — otherwise one bad response would
 *   evict the entire guild from the cache and read as 125 people leaving.
 */

export interface ScannedMember {
  readonly uuid: string;
  readonly rank: string | null;
  readonly joinedAt: number | null;
  /** Day (`YYYY-MM-DD`) → that day's GEXP, as Hypixel reports it. */
  readonly expHistory: Readonly<Record<string, number>>;
  readonly weeklyGexp: number;
}

export interface CachedMemberRow {
  readonly uuid: string;
  readonly ign: string | null;
  /**
   * The rank we last recorded, used only to notice a promotion.
   *
   * Optional because a caller that does not select it simply gets no rank-change
   * signal, which degrades to "the auto-role sweep will find it" rather than to
   * a wrong answer.
   */
  readonly guildRank?: string | null;
}

export interface MemberCacheWrite {
  readonly uuid: string;
  readonly ign: string | null;
  readonly guildRank: string | null;
  readonly joinedAt: Date | null;
  readonly weeklyGexp: number;
  readonly refreshedAt: Date;
}

export interface GexpDailyWrite {
  readonly uuid: string;
  /** `YYYY-MM-DD`, kept as a string because that is the grain of the unique key. */
  readonly day: string;
  readonly gexp: number;
}

export interface GuildScanResult {
  readonly memberCount: number;
  readonly joined: readonly string[];
  readonly left: readonly string[];
  /**
   * Members whose in-game rank differs from the one we had cached.
   *
   * Joiners are not listed here — they are in `joined`, and everything that
   * consumes a rank change treats a join as one too.
   */
  readonly rankChanged: readonly string[];
  readonly gexpRows: number;
  /** Set when the scan did nothing; the caller logs it and moves to the next guild. */
  readonly skipped?: "no-hypixel-guild" | "fetch-failed";
  /**
   * Why the fetch failed, in the operator's terms. Present only alongside
   * `skipped: "fetch-failed"`.
   *
   * A rejected API key, a guild id that matches nothing, and a rate limit are
   * three different jobs for three different people, and every one of them used
   * to be recorded as the same "roster fetch failed" — which is a scan that
   * fails constantly and tells nobody why.
   */
  readonly reason?: string;
}

/** A fetch that failed, carrying the reason instead of discarding it. */
export interface RosterFetchFailure {
  readonly failed: string;
}

export interface GuildScanDeps {
  /**
   * The live roster, never a partial list. `{ failed }` when Hypixel could not
   * be read and the caller knows why; bare `null` when it does not.
   */
  fetchRoster(guildId: string): Promise<readonly ScannedMember[] | RosterFetchFailure | null>;
  /** Everything currently cached for the guild, however stale. */
  listCached(guildId: string): Promise<readonly CachedMemberRow[]>;
  /**
   * Resolve uuids to names, for members we have no cached IGN for. Best-effort:
   * an unresolved uuid simply stays nameless until a later scan.
   */
  resolveNames?(uuids: readonly string[]): Promise<Readonly<Record<string, string>>>;
  upsertMembers(guildId: string, rows: readonly MemberCacheWrite[]): Promise<void>;
  /** Drop members no longer in-game. Called only after a successful fetch. */
  removeMembers(guildId: string, uuids: readonly string[]): Promise<void>;
  writeGexp(guildId: string, rows: readonly GexpDailyWrite[]): Promise<number>;
  recordScan(guildId: string, result: GuildScanResult, error: string | null): Promise<void>;
  now?: () => Date;
  /**
   * Cap on name lookups per run. Mojang is rate limited far more tightly than
   * Hypixel, and a guild's names change rarely — spreading a cold start over a
   * few scans costs nothing anyone notices.
   */
  nameBatchSize?: number;
}

const DEFAULT_NAME_BATCH = 20;

const isFailure = (
  value: readonly ScannedMember[] | RosterFetchFailure,
): value is RosterFetchFailure => !Array.isArray(value);

/**
 * Scan one guild. Returns what changed; never throws for an upstream failure,
 * because one unreachable guild must not abort the others in the same run.
 */
export async function scanGuild(guildId: string, deps: GuildScanDeps): Promise<GuildScanResult> {
  const now = (deps.now ?? (() => new Date()))();

  const fetched = await deps
    .fetchRoster(guildId)
    .catch((error: unknown): RosterFetchFailure => ({
      failed: error instanceof Error ? error.message : "roster fetch threw",
    }));

  // `Array.isArray` does not narrow a `readonly T[]` union member (it asserts
  // the mutable `any[]`), so the failure shape is the thing tested for.
  if (fetched === null || isFailure(fetched)) {
    const reason = fetched === null ? "roster fetch failed" : fetched.failed;
    const result: GuildScanResult = {
      memberCount: 0,
      joined: [],
      left: [],
      rankChanged: [],
      gexpRows: 0,
      skipped: "fetch-failed",
      reason,
    };
    await deps.recordScan(guildId, result, reason);
    return result;
  }
  const roster: readonly ScannedMember[] = fetched;

  const cached = await deps.listCached(guildId);
  const cachedByUuid = new Map(cached.map((row) => [row.uuid, row]));
  const live = new Set(roster.map((m) => m.uuid));

  const joined = roster.filter((m) => !cachedByUuid.has(m.uuid)).map((m) => m.uuid);
  const left = cached.filter((row) => !live.has(row.uuid)).map((row) => row.uuid);
  const rankChanged = roster
    .filter((m) => {
      const before = cachedByUuid.get(m.uuid);
      // `undefined` is "the caller did not tell us", which is not a change.
      return before !== undefined && before.guildRank !== undefined && before.guildRank !== m.rank;
    })
    .map((m) => m.uuid);

  // Only look up names we do not already have. Joiners first: they are the ones
  // whose absence is actually visible, in a perm roster or a leaderboard.
  const joinedSet = new Set(joined);
  const needNames = roster
    .filter((m) => (cachedByUuid.get(m.uuid)?.ign ?? null) === null)
    .map((m) => m.uuid)
    .sort((a, b) => Number(joinedSet.has(b)) - Number(joinedSet.has(a)))
    .slice(0, deps.nameBatchSize ?? DEFAULT_NAME_BATCH);
  const resolved: Readonly<Record<string, string>> =
    deps.resolveNames && needNames.length > 0
      ? await deps.resolveNames(needNames).catch(() => ({}))
      : {};

  const members: MemberCacheWrite[] = roster.map((m) => ({
    uuid: m.uuid,
    ign: cachedByUuid.get(m.uuid)?.ign ?? resolved[m.uuid] ?? null,
    guildRank: m.rank,
    joinedAt: m.joinedAt === null ? null : new Date(m.joinedAt),
    weeklyGexp: m.weeklyGexp,
    refreshedAt: now,
  }));
  await deps.upsertMembers(guildId, members);
  if (left.length > 0) await deps.removeMembers(guildId, left);

  const gexpRows = await deps.writeGexp(guildId, collectGexp(roster));

  const result: GuildScanResult = { memberCount: roster.length, joined, left, rankChanged, gexpRows };
  await deps.recordScan(guildId, result, null);
  return result;
}

/**
 * Flatten every member's expHistory into rows.
 *
 * Zero-GEXP days are kept rather than filtered: "earned nothing on Tuesday" and
 * "we have no reading for Tuesday" are different facts, and an activity system
 * that cannot tell them apart will read a quiet week as missing data.
 */
export function collectGexp(roster: readonly ScannedMember[]): GexpDailyWrite[] {
  const rows: GexpDailyWrite[] = [];
  for (const member of roster) {
    for (const [day, gexp] of Object.entries(member.expHistory)) {
      rows.push({ uuid: member.uuid, day, gexp });
    }
  }
  return rows;
}

/**
 * Whether a cached roster is fresh enough to serve without a warning.
 *
 * `refreshedAt` is the newest row's timestamp; a guild with no rows at all is
 * stale by definition, which is what makes a cold start ask for a scan instead
 * of confidently reporting an empty guild.
 */
export function isCacheFresh(refreshedAt: Date | null, now: Date, ttlMs: number): boolean {
  if (refreshedAt === null) return false;
  return now.getTime() - refreshedAt.getTime() < ttlMs;
}

/** The 6-hour rolling window the platform plan specifies for the member cache. */
export const MEMBER_CACHE_TTL_MS = 6 * 60 * 60_000;

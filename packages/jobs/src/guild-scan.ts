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
  readonly gexpRows: number;
  /** Set when the scan did nothing; the caller logs it and moves to the next guild. */
  readonly skipped?: "no-hypixel-guild" | "fetch-failed";
}

export interface GuildScanDeps {
  /** The live roster, or null when Hypixel could not be read. Never a partial list. */
  fetchRoster(guildId: string): Promise<readonly ScannedMember[] | null>;
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

/**
 * Scan one guild. Returns what changed; never throws for an upstream failure,
 * because one unreachable guild must not abort the others in the same run.
 */
export async function scanGuild(guildId: string, deps: GuildScanDeps): Promise<GuildScanResult> {
  const now = (deps.now ?? (() => new Date()))();

  const roster = await deps.fetchRoster(guildId).catch(() => null);
  if (roster === null) {
    const result: GuildScanResult = { memberCount: 0, joined: [], left: [], gexpRows: 0, skipped: "fetch-failed" };
    await deps.recordScan(guildId, result, "roster fetch failed");
    return result;
  }

  const cached = await deps.listCached(guildId);
  const cachedByUuid = new Map(cached.map((row) => [row.uuid, row]));
  const live = new Set(roster.map((m) => m.uuid));

  const joined = roster.filter((m) => !cachedByUuid.has(m.uuid)).map((m) => m.uuid);
  const left = cached.filter((row) => !live.has(row.uuid)).map((row) => row.uuid);

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

  const result: GuildScanResult = { memberCount: roster.length, joined, left, gexpRows };
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

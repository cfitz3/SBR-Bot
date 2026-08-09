/**
 * Ranking and paging. Pure, and the only place the ordering rules live.
 */
import type { CategorySpec, LeaderboardEntry, LeaderboardPage, MemberValue } from "./types.js";

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 25;

export interface RankOptions {
  readonly spec: CategorySpec;
  readonly page?: number;
  readonly pageSize?: number;
  /** The caller's key in this category's identity space, when they have one. */
  readonly viewerKey?: string | null;
  readonly windowDays?: number | null;
}

/**
 * Rank every value, then cut out one page.
 *
 * Two rules worth stating:
 *
 * - **Non-positive values are not ranked at all.** A board listing members who
 *   have earned nothing is not a leaderboard, it is a roster, and padding the
 *   bottom with zeroes makes an empty guild look busy.
 * - **Ties share a rank and consume the ones after it** (1, 2, 2, 4). Two
 *   members on the same catacombs level are equal, and the alternative — an
 *   arbitrary tiebreak presented as an ordering — would invent a difference.
 *   Within a tie the order is by label, so the same data always prints the
 *   same way.
 */
export function rank(values: readonly MemberValue[], options: RankOptions): LeaderboardPage {
  const pageSize = clamp(options.pageSize ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const viewerKey = options.viewerKey ?? null;

  const ordered = values
    .filter((v) => Number.isFinite(v.value) && v.value > 0)
    .sort((a, b) => (b.value - a.value) || a.label.localeCompare(b.label));

  const ranked: LeaderboardEntry[] = [];
  let lastValue: number | null = null;
  let lastRank = 0;
  ordered.forEach((row, index) => {
    const tied = lastValue !== null && row.value === lastValue;
    const position = tied ? lastRank : index + 1;
    lastValue = row.value;
    lastRank = position;
    ranked.push({ ...row, rank: position, isViewer: viewerKey !== null && row.key === viewerKey });
  });

  const pageCount = Math.max(1, Math.ceil(ranked.length / pageSize));
  // Clamped rather than rejected: asking for page 9 of a 3-page board is a
  // reasonable mistake, and the last page answers it better than an error does.
  const page = clamp(Math.trunc(options.page ?? 1), 1, pageCount);
  const entries = ranked.slice((page - 1) * pageSize, page * pageSize);

  const onPage = entries.some((e) => e.isViewer);
  const viewer = onPage ? null : (ranked.find((e) => e.isViewer) ?? null);

  return {
    category: options.spec.id,
    spec: options.spec,
    entries,
    page,
    pageCount,
    totalRanked: ranked.length,
    windowDays: options.spec.windowed ? (options.windowDays ?? null) : null,
    viewer,
    oldestReadingAt: oldest(entries),
  };
}

/**
 * The oldest reading on the page. Deliberately the oldest and not the newest:
 * a footer built from the freshest row would advertise a currency the rest of
 * the page does not have.
 */
function oldest(entries: readonly LeaderboardEntry[]): string | null {
  let found: string | null = null;
  for (const entry of entries) {
    if (entry.at === null) continue;
    if (found === null || entry.at < found) found = entry.at;
  }
  return found;
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

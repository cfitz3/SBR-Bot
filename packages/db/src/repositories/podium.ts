/**
 * Counting somebody's top-three finishes, given the raw scores.
 *
 * Split from the query in `community.ts` so the placing rule can be tested
 * without a database — the rule is the part that is easy to get subtly wrong,
 * and the query around it is two lines of `findMany`.
 */

/** One member's result in one event, on one metric. */
export interface ScoreRow {
  readonly eventId: string;
  readonly metric: string;
  readonly discordId: string;
  readonly delta: number;
}

/**
 * How many podiums a member holds across the given scores.
 *
 * Placing is per event *and per metric*, the same unit the tracker board ranks
 * in: an event scored on two metrics has two podiums to win, and collapsing
 * them would make the same finish worth less in a multi-metric event than in a
 * single-metric one.
 *
 * Non-positive deltas are unranked, matching the leaderboard rule — somebody
 * who signed up and gained nothing did not come third. Ties share a place and
 * consume the ones after (1, 2, 2, 4), so two silvers means nobody took bronze.
 */
export function countPodiumsIn(rows: readonly ScoreRow[], discordId: string): number {
  const boards = new Map<string, { discordId: string; delta: number }[]>();
  for (const row of rows) {
    if (row.delta <= 0) continue;
    const key = `${row.eventId}:${row.metric}`;
    const board = boards.get(key);
    if (board === undefined) boards.set(key, [{ discordId: row.discordId, delta: row.delta }]);
    else board.push({ discordId: row.discordId, delta: row.delta });
  }

  let podiums = 0;
  for (const board of boards.values()) {
    board.sort((a, b) => b.delta - a.delta);
    let place = 0;
    let previous: number | null = null;
    for (let i = 0; i < board.length; i += 1) {
      const entry = board[i];
      if (entry === undefined) continue;
      if (previous === null || entry.delta < previous) place = i + 1;
      previous = entry.delta;
      if (place > 3) break;
      if (entry.discordId === discordId) {
        podiums += 1;
        break;
      }
    }
  }
  return podiums;
}

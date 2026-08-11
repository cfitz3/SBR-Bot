/**
 * @sbr/leaderboards — what the guild can be ranked by, and how a column of
 * numbers becomes a page with ranks, ties and "where am I".
 *
 * Member-facing only. There is no panel surface for any of this by design
 * (WEB_PANEL.md §0): a leaderboard is something the guild reads, not something
 * staff administers.
 */
export { LeaderboardService, DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS, type LeaderboardQuery } from "./service.js";
export { rank, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type RankOptions } from "./rank.js";
export type { LeaderboardSource } from "./ports.js";
export {
  CATEGORY_SPECS,
  LEADERBOARD_CATEGORIES,
  categoryFor,
  type CategorySpec,
  type LeaderboardCategory,
  type LeaderboardEntry,
  type LeaderboardPage,
  type LeaderboardSourceKind,
  type MemberValue,
  type ValueFormat,
} from "./types.js";

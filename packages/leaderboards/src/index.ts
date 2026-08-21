/**
 * @sbr/leaderboards — what the guild can be ranked by, and how a column of
 * numbers becomes a page with ranks, ties and "where am I".
 *
 * Read-only on every surface: `/leaderboard` in Discord, the panel's
 * Leaderboard page, and the weekly digest the workers schedule. WEB_PANEL.md §0
 * once said there would be no panel surface at all, on the reasoning that a
 * leaderboard is something the guild reads rather than something staff
 * administers. The first half of that still holds — the page has no action on
 * it anywhere — but "staff does not administer it" turned out to be an argument
 * for a page with no controls, not for no page.
 */
export {
  LeaderboardService,
  DEFAULT_POSITION_CATEGORIES,
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  type LeaderboardQuery,
} from "./service.js";
export { rank, rankAll, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type RankOptions } from "./rank.js";
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

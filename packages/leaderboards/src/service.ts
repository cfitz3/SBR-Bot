/**
 * LeaderboardService — fetch, rank, page.
 *
 * Thin by design. It exists so the command surface has one call to make and one
 * place where the window and page size are clamped, rather than every caller
 * re-deciding what a reasonable request looks like.
 */
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, rank } from "./rank.js";
import type { LeaderboardSource } from "./ports.js";
import { CATEGORY_SPECS, type LeaderboardCategory, type LeaderboardPage } from "./types.js";

/** A month of activity: long enough to be a record, short enough to be current. */
export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 365;

export interface LeaderboardQuery {
  readonly guildId: string;
  readonly category: LeaderboardCategory;
  /** The caller, so their own row can be found. */
  readonly discordId: string;
  readonly page?: number;
  readonly pageSize?: number;
  readonly windowDays?: number;
}

export class LeaderboardService {
  constructor(private readonly source: LeaderboardSource) {}

  async page(query: LeaderboardQuery): Promise<LeaderboardPage> {
    const spec = CATEGORY_SPECS[query.category];
    const windowDays = clamp(query.windowDays ?? DEFAULT_WINDOW_DAYS, 1, MAX_WINDOW_DAYS);

    // Both reads are independent, and the viewer lookup is a single row — no
    // reason for the board to wait on it.
    const [values, viewerKey] = await Promise.all([
      this.source.values(query.guildId, query.category, windowDays),
      this.source.viewerKey(query.guildId, query.discordId, query.category).catch(() => null),
    ]);

    return rank(values, {
      spec,
      page: query.page ?? 1,
      pageSize: clamp(query.pageSize ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
      viewerKey,
      windowDays,
    });
  }
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : min;
}

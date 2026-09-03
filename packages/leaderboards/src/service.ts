/**
 * LeaderboardService — fetch, rank, page.
 *
 * Thin by design. It exists so the command surface has one call to make and one
 * place where the window and page size are clamped, rather than every caller
 * re-deciding what a reasonable request looks like.
 */
import { buildBoard } from "./board.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, rank, rankAll } from "./rank.js";
import type { LeaderboardSource } from "./ports.js";
import { CATEGORY_SPECS, type LeaderboardCategory, type LeaderboardPage } from "./types.js";
import type { LeaderboardBoardDTO, LeaderboardPositionDTO } from "@sbr/shared-types";

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

/**
 * What the profile card asks for by default.
 *
 * Four rather than all nine, and chosen so each says a different thing: how far
 * the account has come, what it is worth, what it can clear, and what the member
 * has put into the guild. Every category added here is another whole-guild read
 * on a card that already fans out eight, and a card listing nine ranks is one
 * nobody reads any of.
 */
export const DEFAULT_POSITION_CATEGORIES: readonly LeaderboardCategory[] = [
  "level",
  "wealth",
  "catacombs",
  "xp",
];

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

  /**
   * Every column at once, for the panel's board. See `board.ts` for why this is
   * one read rather than one per column.
   */
  async board(query: {
    readonly guildId: string;
    readonly discordId: string;
    readonly tab: string;
    readonly windowDays?: number;
  }): Promise<LeaderboardBoardDTO> {
    return buildBoard(this.source, {
      guildId: query.guildId,
      discordId: query.discordId,
      tab: query.tab,
      windowDays: clamp(query.windowDays ?? DEFAULT_WINDOW_DAYS, 1, MAX_WINDOW_DAYS),
    });
  }

  /**
   * Where one member places, category by category.
   *
   * Each category is read independently and absorbs its own failure: a card is
   * worth more with three ranks on it than with none, and a board whose source
   * is briefly unreadable is not news the member can act on. A member with no
   * ranked value in a category is simply absent from the answer.
   */
  async positions(
    guildId: string,
    discordId: string,
    categories: readonly LeaderboardCategory[] = DEFAULT_POSITION_CATEGORIES,
  ): Promise<readonly LeaderboardPositionDTO[]> {
    const wanted = [...new Set(categories)].filter((c) => CATEGORY_SPECS[c] !== undefined);

    const found = await Promise.all(
      wanted.map(async (category): Promise<LeaderboardPositionDTO | null> => {
        try {
          const spec = CATEGORY_SPECS[category];
          const [values, viewerKey] = await Promise.all([
            this.source.values(guildId, category, DEFAULT_WINDOW_DAYS),
            this.source.viewerKey(guildId, discordId, category),
          ]);
          if (viewerKey === null) return null;

          const ranked = rankAll(values, viewerKey);
          const row = ranked.find((entry) => entry.isViewer);
          if (row === undefined) return null;

          return {
            category,
            label: spec.label,
            format: spec.format,
            rank: row.rank,
            value: row.value,
            // Ranked members only, matching `totalRanked` on a page: "12th of
            // 40" must mean the same thing on the card as on the board.
            totalRanked: ranked.length,
          };
        } catch {
          return null;
        }
      }),
    );

    return found.filter((row): row is LeaderboardPositionDTO => row !== null);
  }
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : min;
}

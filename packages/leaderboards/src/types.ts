/**
 * What can be ranked, and what a ranked number means.
 *
 * The catalog is closed on purpose. A leaderboard is a claim about the guild,
 * and every category here has a stated source and a stated freshness — an
 * open-ended "rank by any metric" surface could not make either promise.
 */

import type {
  LeaderboardCategory,
  LeaderboardCategorySpec,
  LeaderboardEntryDTO,
  LeaderboardPageDTO,
  LeaderboardValueFormat,
} from "@sbr/shared-types";
import { LEADERBOARD_LABELS } from "@sbr/shared-types";

/**
 * The vocabulary lives in `@sbr/shared-types`, so the bots can depend on the
 * shapes without depending on this package. The aliases below keep the domain
 * code reading as domain code.
 */
export { LEADERBOARD_CATEGORIES, categoryFor } from "@sbr/shared-types";
export type { LeaderboardCategory, LeaderboardSourceKind } from "@sbr/shared-types";
export type ValueFormat = LeaderboardValueFormat;
export type CategorySpec = LeaderboardCategorySpec;
export type LeaderboardEntry = LeaderboardEntryDTO;
export type LeaderboardPage = LeaderboardPageDTO;

/**
 * Where each family's numbers come from, and how stale they can be:
 *
 * - `SNAPSHOT` — the newest `ProfileSnapshot` per member, so up to a snapshot
 *   cycle behind (~6–12h). The only family that can be stale at all.
 * - `TENURE` — `GuildMember.joinedAt`, exact and derived at read time.
 * - `ACTIVITY` — summed `ActivityDaily` counters over a window. Same counters
 *   XP is derived from, so a member's activity rank and XP rank move together.
 * - `XP` — the denormalized `XpBalance`, rebuilt by `xp-aggregate`.
 */
export const CATEGORY_SPECS: Readonly<Record<LeaderboardCategory, CategorySpec>> = {
  level: {
    id: "level",
    label: LEADERBOARD_LABELS["level"],
    format: "level",
    source: "SNAPSHOT",
    description: "SkyBlock Level on the member's selected profile",
    windowed: false,
  },
  wealth: {
    id: "wealth",
    label: LEADERBOARD_LABELS["wealth"],
    format: "coins",
    source: "SNAPSHOT",
    description: "Networth on the member's selected profile",
    windowed: false,
  },
  tenure: {
    id: "tenure",
    label: LEADERBOARD_LABELS["tenure"],
    format: "days",
    source: "TENURE",
    description: "Days as a member of this guild",
    windowed: false,
  },
  "skill-average": {
    id: "skill-average",
    label: LEADERBOARD_LABELS["skill-average"],
    format: "level",
    source: "SNAPSHOT",
    description: "Mean level across the skills that count",
    windowed: false,
  },
  catacombs: {
    id: "catacombs",
    label: LEADERBOARD_LABELS["catacombs"],
    format: "level",
    source: "SNAPSHOT",
    description: "Catacombs level",
    windowed: false,
  },
  slayer: {
    id: "slayer",
    label: LEADERBOARD_LABELS["slayer"],
    format: "count",
    source: "SNAPSHOT",
    description: "Total slayer XP across all bosses",
    windowed: false,
  },
  "discord-activity": {
    id: "discord-activity",
    label: LEADERBOARD_LABELS["discord-activity"],
    format: "count",
    source: "ACTIVITY",
    description: "Messages sent in Discord",
    windowed: true,
  },
  "guild-chat": {
    id: "guild-chat",
    label: LEADERBOARD_LABELS["guild-chat"],
    format: "count",
    source: "ACTIVITY",
    description: "Messages sent in guild chat",
    windowed: true,
  },
  xp: {
    id: "xp",
    label: LEADERBOARD_LABELS["xp"],
    format: "count",
    source: "XP",
    description: "Total guild XP earned",
    windowed: false,
  },
};

/** One member's number, as the data source reports it. */
export interface MemberValue {
  /**
   * Whatever identifies the member in that source — a Discord snowflake for the
   * activity and XP families, a uuid for the snapshot ones. Only ever compared,
   * never parsed.
   */
  readonly key: string;
  /** Display name: an IGN where one is known, else a Discord mention. */
  readonly label: string;
  readonly value: number;
  /** When the reading was taken, ISO-8601. Null for values with no reading. */
  readonly at: string | null;
}

/**
 * A ranked row and a whole page are shared vocabulary — see the aliases at the
 * top of this file. `MemberValue` stays local: it is what a data source hands
 * in, and nothing outside this package ever sees an unranked value.
 */

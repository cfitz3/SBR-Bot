/**
 * The whole guild, every column at once.
 *
 * A page answers "who is top on Catacombs". A board answers the question staff
 * actually open the panel with — *how is the guild doing* — which needs every
 * metric beside every member at the same time, and needs sorting to be a click
 * rather than a request.
 *
 * Two things this has to solve that a page does not:
 *
 * - **Two identity spaces.** The Hypixel columns are keyed by uuid and the
 *   Discord ones by snowflake, and they are the same people. The roster is what
 *   joins them, and it is also what turns both keys into a name — so nothing
 *   downstream ever renders an id and calls it a member.
 * - **Unranked is not last.** A member with no networth reading has no wealth
 *   cell. Filling it with a zero would rank somebody poorest on the strength of
 *   their API being off.
 */
import { rankAll } from "./rank.js";
import type { LeaderboardSource, RosterMember } from "./ports.js";
import { CATEGORY_SPECS, type LeaderboardCategory } from "./types.js";
import type {
  LeaderboardBoardCellDTO,
  LeaderboardBoardColumnDTO,
  LeaderboardBoardDTO,
  LeaderboardBoardRowDTO,
} from "@sbr/shared-types";

/**
 * The two groupings, and why these columns are on these tabs.
 *
 * **Stats** is what the account is: five numbers that describe a SkyBlock
 * profile and change on the scale of weeks.
 *
 * **Activity** is what the member has been doing lately: four that move daily,
 * plus tenure, which is not activity but is the number staff read them against
 * — three hundred messages is a lot in a week and very little in two years.
 */
export const BOARD_TABS: Readonly<Record<string, readonly LeaderboardCategory[]>> = {
  stats: ["level", "skill-average", "slayer", "wealth", "catacombs"],
  activity: ["gexp", "discord-activity", "guild-chat", "xp", "tenure"],
};

export const BOARD_TAB_IDS: readonly string[] = ["stats", "activity"];

/** An unknown tab is the first one, not an error: it arrives from a URL. */
export function boardTabFor(raw: string): string {
  const key = raw.trim().toLowerCase();
  return BOARD_TAB_IDS.includes(key) ? key : "stats";
}

export interface BoardQuery {
  readonly guildId: string;
  readonly discordId: string;
  readonly tab: string;
  readonly windowDays: number;
}

export async function buildBoard(
  source: LeaderboardSource,
  query: BoardQuery,
): Promise<LeaderboardBoardDTO> {
  const tab = boardTabFor(query.tab);
  const categories = BOARD_TABS[tab] ?? [];

  // The roster and every column are independent reads. Serialised, a five-column
  // board would cost five round trips to answer one page load.
  const [roster, columns] = await Promise.all([
    source.roster(query.guildId).catch((): readonly RosterMember[] => []),
    Promise.all(
      categories.map(async (category) => {
        try {
          const values = await source.values(query.guildId, category, query.windowDays);
          return { category, ranked: rankAll(values, null) };
        } catch {
          // One unreadable column costs that column, not the board. A staffer
          // reading four of five is better served than one reading an error.
          return { category, ranked: [] };
        }
      }),
    ),
  ]);

  // Both keys point at the same row, which is what lets a uuid-keyed column and
  // a snowflake-keyed one land beside each other.
  const rows = new Map<string, MutableRow>();
  const byKey = new Map<string, MutableRow>();
  for (const member of roster) {
    const id = member.discordId ?? member.uuid;
    if (id === null) continue;
    const row: MutableRow = {
      id,
      discordId: member.discordId,
      uuid: member.uuid,
      name: member.name,
      guildRank: member.guildRank,
      isViewer: member.discordId === query.discordId,
      cells: {},
    };
    rows.set(id, row);
    if (member.discordId !== null) byKey.set(member.discordId, row);
    if (member.uuid !== null) byKey.set(member.uuid, row);
  }

  let oldest: string | null = null;
  const columnDTOs: LeaderboardBoardColumnDTO[] = [];

  for (const { category, ranked } of columns) {
    const spec = CATEGORY_SPECS[category];
    columnDTOs.push({
      category,
      label: spec.label,
      format: spec.format,
      windowed: spec.windowed,
      ranked: ranked.length,
    });

    for (const entry of ranked) {
      // A value whose member is not on the roster read is still a member — the
      // roster may be a scan behind. Adopting the row keeps their numbers
      // visible under the name the value itself carried.
      let row = byKey.get(entry.key);
      if (row === undefined) {
        row = {
          id: entry.key,
          discordId: null,
          uuid: null,
          name: entry.label,
          guildRank: null,
          isViewer: entry.key === query.discordId,
          cells: {},
        };
        rows.set(entry.key, row);
        byKey.set(entry.key, row);
      }
      const cell: LeaderboardBoardCellDTO = { value: entry.value, rank: entry.rank, at: entry.at };
      row.cells[category] = cell;
      if (entry.at !== null && (oldest === null || entry.at < oldest)) oldest = entry.at;
    }
  }

  // Sorted by the first column, so the board opens on something meaningful; the
  // browser re-sorts from here without asking again.
  const first = categories[0];
  const out = [...rows.values()].sort((a, b) => {
    const rankA = first === undefined ? undefined : a.cells[first]?.rank;
    const rankB = first === undefined ? undefined : b.cells[first]?.rank;
    if (rankA === rankB) return a.name.localeCompare(b.name);
    // Unranked sinks, whichever way the column is read.
    if (rankA === undefined) return 1;
    if (rankB === undefined) return -1;
    return rankA - rankB;
  });

  return {
    tab,
    columns: columnDTOs,
    rows: out as readonly LeaderboardBoardRowDTO[],
    windowDays: query.windowDays,
    oldestReadingAt: oldest,
  };
}

interface MutableRow {
  id: string;
  discordId: string | null;
  uuid: string | null;
  name: string;
  guildRank: string | null;
  isViewer: boolean;
  cells: Record<string, LeaderboardBoardCellDTO>;
}

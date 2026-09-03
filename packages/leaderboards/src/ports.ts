/**
 * The one thing this package needs from the outside: the values to rank.
 *
 * A single method rather than one per category, because the categories differ
 * only in which table they read — the domain's job starts once the numbers are
 * flat, and a port per source would push that shape difference up here.
 */
import type { LeaderboardCategory, MemberValue } from "./types.js";

export interface LeaderboardSource {
  /**
   * Every ranked-eligible member's value for a category. `windowDays` applies
   * only to the windowed categories; the others ignore it.
   *
   * Returning the whole guild rather than a page is deliberate: a guild is a
   * few hundred rows, and having all of them is what makes "you are 37th" and
   * a stable tie order possible without a second query.
   */
  values(guildId: string, category: LeaderboardCategory, windowDays: number): Promise<readonly MemberValue[]>;

  /**
   * The caller's key in a category's identity space — a uuid for the snapshot
   * categories, their own Discord id for the rest — or null when they have
   * none (unlinked, for the Hypixel-side boards).
   */
  viewerKey(guildId: string, discordId: string, category: LeaderboardCategory): Promise<string | null>;

  /**
   * Who is on the roster, in both identity spaces at once.
   *
   * The board needs this and a page does not: a page ranks one category and
   * every row in it is keyed the same way, whereas a board puts a uuid-keyed
   * column beside a snowflake-keyed one and has to know they are the same
   * person. Resolving that here also means a row is named once, so the browser
   * never has to render a snowflake and call it a member.
   */
  roster(guildId: string): Promise<readonly RosterMember[]>;
}

/** One member of the guild, as both identities and a name. */
export interface RosterMember {
  readonly discordId: string | null;
  readonly uuid: string | null;
  /** IGN where known, else the Discord username. Never a raw id. */
  readonly name: string;
  /** In-game guild rank, when the roster scan knows it. */
  readonly guildRank: string | null;
}

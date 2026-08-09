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
}

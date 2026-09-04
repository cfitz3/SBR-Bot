/**
 * The panel's read cache.
 *
 * Three of the panel's pages are expensive for the same reason: they summarise
 * the whole guild. The leaderboard board ranks every member on every metric,
 * the overview counts several tables at once, and the Discord directory is a
 * loopback call to a bot that is holding a gateway. None of them is expensive
 * because of one slow query — that half was fixed with indexes and joins — they
 * are expensive because there is genuinely a guild's worth of work in each, and
 * staff open them repeatedly while working.
 *
 * So the second half is not doing the work again for the next reader. Two rules
 * make that safe to add to a page rather than an argument to have per page:
 *
 *   1. Every entry has a short TTL. Whatever else goes wrong, a stale panel
 *      corrects itself within a minute, which is well inside the cadence of the
 *      workers that write most of what these pages read.
 *   2. Every panel write drops the whole guild's cache. Staff who change
 *      something and do not see it change will conclude the panel is broken —
 *      correctly, from where they are standing — so the write path invalidates
 *      rather than waiting for a TTL.
 *
 * The port is deliberately narrower than a cache: read-through only, no delete
 * of a single key, no reaching for a value without a way to compute it. That is
 * the whole surface those two rules can be enforced against.
 */

export interface PanelCache {
  /**
   * Serve `key` for `guildId` from cache, or run `load` and remember it.
   *
   * A cache that is down, slow or holding something unparseable must cost a
   * page nothing but the work it would have done anyway: every failure inside
   * an implementation of this is expected to fall through to `load`.
   */
  fetch<T>(guildId: string, key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T>;
  /** Stop serving everything cached for this guild. Called after every write. */
  invalidate(guildId: string): Promise<void>;
}

/**
 * How long each cached page part is worth serving.
 *
 * All short, and short for the same reason: the point is to absorb a burst of
 * reads — a staff member clicking between tabs, three moderators on the same
 * page during an incident — not to keep data for a long time. The numbers are
 * scaled to how fast what they hold actually changes.
 */
export const PANEL_CACHE_TTL = Object.freeze({
  /** Whole-roster rankings. Their inputs move on the profile refresh's cadence. */
  leaderboard: 60,
  /** Counts across several tables. Cheap to be a minute behind, costly to compute. */
  overview: 30,
  /** Discord's channel, role and member lists, via the admin bot's gateway cache. */
  directory: 120,
});

/** The no-op. What a deployment without Redis gets, and what tests get. */
export const noPanelCache: PanelCache = {
  fetch: (_guildId, _key, _ttlSeconds, load) => load(),
  invalidate: async () => {},
};

/**
 * The half of sticky messages that touches Discord: keep the configured note at
 * the bottom of its channel.
 *
 * A repost is a post followed by a delete, in that order — the sticky is
 * briefly duplicated rather than briefly missing, and a delete that fails
 * leaves a stale copy rather than an empty channel.
 *
 * Two things keep this off the hot path. The document is read once a minute per
 * guild (and dropped when config broadcasts a change), and each channel is
 * quiet for a while after a repost. The quiet window means a burst of messages
 * can leave the sticky a few lines up until someone speaks again; that is the
 * accepted trade. The alternative — a timer per channel to catch the tail of
 * every burst — buys a few seconds of tidiness for a scheduler this does not
 * otherwise need.
 */
import {
  findSticky,
  parseStickies,
  STICKY_SETTING_KEY,
  type StickyDoc,
} from "@sbr/guild-config";
import type { GuildConfigService } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";

/** How long a guild's sticky document is reused before it is re-read. */
export const STICKY_CACHE_MS = 60_000;

/** How long a channel is left alone after its sticky is reposted. */
export const STICKY_QUIET_MS = 15_000;

export interface StickyDeps {
  readonly config: Pick<GuildConfigService, "getSetting">;
  /** Post the note. Returns the new message id, or null if it did not land. */
  post(channelId: string, content: string): Promise<string | null>;
  /** Best effort: a sticky somebody already deleted is not an error. */
  remove(channelId: string, messageId: string): Promise<void>;
  readonly log: Logger;
  /** Injectable so the test does not sleep. */
  now?(): number;
}

export interface StickyKeeper {
  /**
   * A message arrived. Reposts the channel's sticky if one is configured and
   * the channel is not still quiet. Resolves to whether it reposted.
   */
  onMessage(guildId: string, channelId: string): Promise<boolean>;
  /**
   * Apply this channel's configuration now, ignoring the quiet window: post the
   * sticky, or take down the one that is no longer configured. This is what
   * `/sticky set` and `/sticky clear` call, so staff see the result of their own
   * command instead of waiting for the channel to move.
   */
  apply(guildId: string, channelId: string): Promise<boolean>;
  /** Drop a guild's cached document — its config just changed. */
  invalidate(guildId: string): void;
}

interface Cached {
  readonly doc: StickyDoc;
  readonly readAt: number;
}

interface Posted {
  readonly messageId: string;
  readonly postedAt: number;
}

export function createStickyKeeper(deps: StickyDeps): StickyKeeper {
  const now = (): number => deps.now?.() ?? Date.now();
  const cache = new Map<string, Cached>();
  /** channelId → the sticky this process last posted there. */
  const live = new Map<string, Posted>();

  async function docFor(guildId: string): Promise<StickyDoc | null> {
    const hit = cache.get(guildId);
    if (hit !== undefined && now() - hit.readAt < STICKY_CACHE_MS) return hit.doc;

    const raw = await deps.config.getSetting(guildId, STICKY_SETTING_KEY).catch(() => undefined);
    // Undefined is a failed read, not an empty document: reusing the last good
    // one keeps a database blip from quietly stopping every sticky in the fleet.
    if (raw === undefined) return hit?.doc ?? null;

    const doc = parseStickies(raw);
    cache.set(guildId, { doc, readAt: now() });
    return doc;
  }

  async function repost(channelId: string, content: string): Promise<boolean> {
    const previous = live.get(channelId);
    const messageId = await deps.post(channelId, content).catch((error: unknown) => {
      deps.log.warn("sticky did not post", { channelId, error: String(error) });
      return null;
    });
    if (messageId === null) return false;

    live.set(channelId, { messageId, postedAt: now() });
    if (previous !== undefined) await takeDown(channelId, previous.messageId);
    return true;
  }

  async function takeDown(channelId: string, messageId: string): Promise<void> {
    await deps.remove(channelId, messageId).catch((error: unknown) => {
      deps.log.debug("old sticky was not removed", { channelId, messageId, error: String(error) });
    });
  }

  return {
    async onMessage(guildId, channelId) {
      const posted = live.get(channelId);
      // Cheapest check first, and the one that runs on almost every message in a
      // sticky channel: still quiet, nothing to do, no config read.
      if (posted !== undefined && now() - posted.postedAt < STICKY_QUIET_MS) return false;

      const doc = await docFor(guildId);
      if (doc === null) return false;
      const sticky = findSticky(doc, channelId);
      if (sticky === null) {
        // Configured away while this process held one: take it down rather than
        // leave a note the guild has stopped standing behind.
        if (posted !== undefined) {
          live.delete(channelId);
          await takeDown(channelId, posted.messageId);
        }
        return false;
      }
      return repost(channelId, sticky.content);
    },

    async apply(guildId, channelId) {
      cache.delete(guildId);
      const doc = await docFor(guildId);
      if (doc === null) return false;

      const sticky = findSticky(doc, channelId);
      if (sticky === null) {
        const posted = live.get(channelId);
        if (posted === undefined) return false;
        live.delete(channelId);
        await takeDown(channelId, posted.messageId);
        return true;
      }
      return repost(channelId, sticky.content);
    },

    invalidate(guildId) {
      cache.delete(guildId);
    },
  };
}

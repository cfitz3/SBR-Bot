/**
 * Autoresponders: the guild's canned replies, fired by their own patterns.
 *
 * This sits on the message hot path, which decides almost everything about it.
 * The tag list is fetched at most once a minute per guild and the compiled
 * patterns are cached with it — compiling a regex per message, or reading the
 * database per message, would make a chatty server pay for a feature it may not
 * even use.
 *
 * The other hot-path concern is volume. A pattern that matches a common word
 * would otherwise answer every message in the channel, so each tag is rate
 * limited per channel: one answer, then quiet for a while. That is a property
 * of the feature, not a guard against a mistake — an autoresponder that repeats
 * itself is worse than one that misses a question.
 */
import { compileTags, matchTag, type CompiledTag } from "@sbr/tickets";
import type { TicketTagDTO } from "@sbr/shared-types";

/** How long a compiled tag list is reused before it is re-read. */
export const TAG_CACHE_MS = 60_000;
/** How long one tag stays quiet in one channel after firing. */
export const TAG_COOLDOWN_MS = 60_000;
/** Longer messages are not questions; skipping them keeps a paste off the regex. */
export const MAX_SCANNED_LENGTH = 500;

export interface AutoresponderDeps {
  listTags(guildId: string): Promise<readonly TicketTagDTO[]>;
  /** Injectable so the test does not sleep. */
  now?(): number;
}

export interface Autoresponder {
  /**
   * The reply this message should get, or null.
   *
   * `where` is the caller's: the bridge knows whether a channel is a ticket and
   * the matcher does not.
   */
  respond(guildId: string, channelId: string, text: string, where: "TICKET" | "SERVER"): Promise<string | null>;
  /** Drop a guild's cached tags — the panel just changed them. */
  invalidate(guildId: string): void;
}

interface Entry {
  readonly compiled: readonly CompiledTag[];
  readonly readAt: number;
}

export function createAutoresponder(deps: AutoresponderDeps): Autoresponder {
  const now = (): number => deps.now?.() ?? Date.now();
  const cache = new Map<string, Entry>();
  /** `${channelId}:${tagId}` → when it may fire again. */
  const quiet = new Map<string, number>();

  async function compiledFor(guildId: string): Promise<readonly CompiledTag[]> {
    const hit = cache.get(guildId);
    if (hit !== undefined && now() - hit.readAt < TAG_CACHE_MS) return hit.compiled;

    // A failed read reuses whatever is cached rather than falling silent: the
    // tags were right a minute ago, and a database blip is not a reason to stop
    // answering.
    const tags = await deps.listTags(guildId).catch(() => null);
    if (tags === null) return hit?.compiled ?? [];

    const compiled = compileTags(tags);
    cache.set(guildId, { compiled, readAt: now() });
    return compiled;
  }

  return {
    async respond(guildId, channelId, text, where) {
      if (text.length === 0 || text.length > MAX_SCANNED_LENGTH) return null;

      const compiled = await compiledFor(guildId);
      if (compiled.length === 0) return null;

      const hit = matchTag(compiled, text, where);
      if (hit === null) return null;

      const key = `${channelId}:${hit.id}`;
      const at = now();
      const until = quiet.get(key);
      if (until !== undefined && at < until) return null;
      quiet.set(key, at + TAG_COOLDOWN_MS);

      // Swept opportunistically: the map is bounded by channels × tags, but a
      // long-lived process on a large fleet should not hold every pair forever.
      if (quiet.size > 1_000) {
        for (const [k, expiry] of quiet) if (expiry <= at) quiet.delete(k);
      }

      return hit.content;
    },

    invalidate(guildId) {
      cache.delete(guildId);
    },
  };
}

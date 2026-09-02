/**
 * The weekly standings digest: one post per category into the guild's
 * `leaderboard` channel.
 *
 * Posted, never edited. See the reasoning in `@sbr/jobs`'s `leaderboard-post`:
 * a digest is a record of one week, and rewriting last week's message would
 * destroy the history that makes posting it worthwhile at all.
 *
 * The categories are the same four `/me` reports on, and the same four the
 * panel opens with. A digest of all thirteen would be a channel nobody reads
 * any of; a digest of four is a thing somebody scrolls past on Sunday and
 * notices they moved.
 *
 * There is no discord.js in this file. The gateway takes a port with `post` on
 * it, which is what lets the decision — which channel, which categories, what
 * to do when a board is empty — be tested without a gateway connection.
 */
import { renderLeaderboardEmbed } from "@sbr/commands-bridge";
import type { Logger } from "@sbr/observability";
import type { EmbedView, LeaderboardCategory, LeaderboardPageDTO } from "@sbr/shared-types";
import { copy } from "@sbr/brand";

const E = copy.error;

/**
 * What the digest covers, in the order it is posted.
 *
 * Deliberately a constant rather than guild config: a per-guild category list
 * is a settings page, a migration and a panel control, for a choice no operator
 * has yet asked to make. When one does, this is the single place it moves to.
 */
export const DIGEST_CATEGORIES: readonly LeaderboardCategory[] = ["level", "wealth", "catacombs", "xp"];

/** How many rows one digest board shows. A page, not the whole guild. */
export const DIGEST_PAGE_SIZE = 10;

export interface LeaderboardDigestPort {
  page(query: {
    readonly guildId: string;
    readonly category: LeaderboardCategory;
    readonly discordId: string;
    readonly pageSize?: number;
  }): Promise<LeaderboardPageDTO>;
}

export interface LeaderboardDigestDiscordPort {
  /** Post, returning true when it landed. */
  post(channelId: string, embed: EmbedView): Promise<boolean>;
}

export interface LeaderboardDigestDeps {
  readonly leaderboards: LeaderboardDigestPort;
  /** The guild's `leaderboard` channel. Null means the guild has not opted in. */
  readonly getChannel: (guildId: string) => Promise<string | null>;
  readonly discord: LeaderboardDigestDiscordPort;
  readonly log: Logger;
}

export type DigestProblem = "NO_CHANNEL" | "NOTHING_RANKED" | "NOT_POSTED";

export type DigestResult =
  | { readonly ok: true; readonly channelId: string; readonly posted: number }
  | { readonly ok: false; readonly problem: DigestProblem; readonly detail: string };

export class LeaderboardDigest {
  private readonly d: LeaderboardDigestDeps;
  private readonly log: Logger;

  constructor(deps: LeaderboardDigestDeps) {
    this.d = deps;
    this.log = deps.log.child({ component: "leaderboard-digest" });
  }

  /** Post one guild's digest. */
  async publish(guildId: string): Promise<DigestResult> {
    const channelId = await this.d.getChannel(guildId);
    if (channelId === null) {
      // Not an error and not worth a warning: binding the slot is how a guild
      // asks for this, so an unbound slot is a guild that has not asked.
      return { ok: false, problem: "NO_CHANNEL", detail: "no leaderboard channel is bound in this server" };
    }

    const pages = await Promise.all(
      DIGEST_CATEGORIES.map((category) =>
        this.d.leaderboards
          .page({
            guildId,
            category,
            // The digest has no reader, so no row is "yours". Passing an id
            // nobody has is what keeps `isViewer` false on every row rather
            // than badging whoever the first member happens to be.
            discordId: "",
            pageSize: DIGEST_PAGE_SIZE,
          })
          // One unreadable board must not cost the other three theirs.
          .catch((error: unknown) => {
            this.log.warn("digest board failed", { guildId, category, error: String(error) });
            return null;
          }),
      ),
    );

    // A board with nobody on it is left out rather than posted empty: "here are
    // the top ten" over a blank table reads as a broken bot, not as a young
    // guild. If every board is empty there is nothing to say at all.
    const live = pages.filter((page): page is LeaderboardPageDTO => page !== null && page.entries.length > 0);
    if (live.length === 0) {
      return { ok: false, problem: "NOTHING_RANKED", detail: "nobody is ranked on any board yet" };
    }

    let posted = 0;
    for (const page of live) {
      if (await this.d.discord.post(channelId, renderLeaderboardEmbed(page))) posted += 1;
    }
    if (posted === 0) {
      return {
        ok: false,
        problem: "NOT_POSTED",
        detail: E.discord.cannotPost,
      };
    }
    return { ok: true, channelId, posted };
  }
}

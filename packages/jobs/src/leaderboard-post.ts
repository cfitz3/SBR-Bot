/**
 * `leaderboard-post`: the weekly standings digest, posted into the guild's
 * `leaderboard` channel.
 *
 * Posted fresh each week rather than edited in place, which is the opposite of
 * what the event tracker board does — and deliberately. A tracker board is one
 * event's live state, so a second copy of it is a wrong copy. A weekly digest
 * is a record of where the guild stood on a particular Sunday, and editing last
 * week's message would destroy exactly the history that makes it worth posting.
 *
 * Nothing about *what* a board says lives here. This side knows which guilds
 * are due one; the bridge bot renders and posts, because it is the process
 * holding a gateway to the community server.
 */

/** A guild owed a digest, and nothing else — the bridge reads the rest. */
export interface DigestGuild {
  readonly id: string;
}

export interface LeaderboardPostJobDeps {
  /** Every active guild. Those with no `leaderboard` channel are refused below. */
  listGuilds(): Promise<readonly DigestGuild[]>;
  /**
   * Ask the bridge to post one guild's digest. False means it did not land —
   * no channel bound, no permission there, or the bridge still connecting.
   */
  publish(guild: DigestGuild): Promise<boolean>;
  onError(scope: string, error: unknown): void;
}

/** Runs one pass; returns how many digests were actually posted. */
export async function postLeaderboardDigests(deps: LeaderboardPostJobDeps): Promise<number> {
  let guilds: readonly DigestGuild[];
  try {
    guilds = await deps.listGuilds();
  } catch (error) {
    deps.onError("guild list", error);
    return 0;
  }

  let posted = 0;
  for (const guild of guilds) {
    try {
      // One guild's failure must not cost the rest theirs — the same rule the
      // board sweep keeps, and for the same reason.
      if (await deps.publish(guild)) posted += 1;
    } catch (error) {
      deps.onError(`digest ${guild.id}`, error);
    }
  }
  return posted;
}

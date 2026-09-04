/**
 * The live guild-membership probe behind `/link`.
 *
 * `inGuild` is the one auto-role fact that is not ours to know. Every other
 * fact a rule can read — a link, an XP level, a milestone, an attendance —
 * lives in our own database and is true the moment it is written. Hypixel guild
 * membership lives on Hypixel, and until this existed the only copy we had was
 * whatever the six-hourly roster scan last wrote. A member who joined the guild
 * and linked in the same minute therefore linked as a non-member, got no guild
 * role, and nothing marked them again until the scan came round.
 *
 * So the link asks. One request for the guild's roster, and the answer to both
 * halves of the gate is in it: whether this uuid is on the list, and at what
 * rank.
 *
 * It asks for the *guild*, not for the player, and that is the whole reason a
 * recruitment push does not melt the key. `guild?player=<uuid>` is a different
 * cache entry per member, so twenty people linking in a minute is twenty
 * upstream calls; `guild?id=<guildId>` is one entry that every one of them
 * reads. The two answer the same question here — the caller already names the
 * guild it is asking about, and "in some other guild" and "in no guild" were
 * always folded into the same `null` — so this is the cheaper spelling of the
 * behaviour that was already specified, not a change to it.
 *
 * On top of the client's own cache there is a single-flight map, because a cache
 * only helps the calls that arrive after the first one returns. An influx is
 * precisely the shape where they all arrive before it does.
 *
 * Structural on purpose — it takes a `getGuild` rather than a `HypixelClient`,
 * so this package still depends on nothing that speaks HTTP and a test can
 * answer it with an object literal.
 */

/** A guild as the probe needs it: an id, and members with ranks. */
export interface ProbeGuild {
  readonly id: string;
  readonly members: readonly { readonly uuid: string; readonly rank: string | null }[];
}

export interface GuildLookup {
  getGuild(
    id: string,
    by: "id" | "player" | "name",
  ): Promise<{
    readonly ok: boolean;
    readonly value?: { readonly data: ProbeGuild };
    readonly error?: { readonly state: string };
  }>;
}

/**
 * Normalize a uuid for comparison.
 *
 * Hypixel returns undashed uuids on the guild endpoint and our own records are
 * dashed, and comparing the two forms directly reads every member as absent —
 * which would revoke the guild role of the entire guild.
 */
function sameUuid(a: string, b: string): boolean {
  return a.replaceAll("-", "").toLowerCase() === b.replaceAll("-", "").toLowerCase();
}

/**
 * The three return values are the three honest answers, and the third is the
 * reason this is not a boolean: a rank string, `null` for "Hypixel answered and
 * they are not in this guild", and `undefined` for "Hypixel did not answer".
 * Only the middle one is allowed to cause a revocation.
 */
export interface GuildRankProbe {
  rank(hypixelGuildId: string, uuid: string): Promise<string | null | undefined>;
}

/** Build the probe. One roster fetch serves every member asking about it. */
export function createGuildRankProbe(hypixel: GuildLookup): GuildRankProbe {
  /**
   * Guild id → the roster fetch currently in the air for it.
   *
   * Held only while the request is outstanding. Nothing is cached here beyond
   * that: the client already caches the response, and a second memo with its
   * own TTL would be a second thing to be wrong about how stale a roster may be.
   */
  const inFlight = new Map<string, Promise<ProbeGuild | null | undefined>>();

  /**
   * Fetch one guild's roster, coalescing concurrent asks for the same guild.
   *
   * `null` means Hypixel answered and there is no such guild; `undefined` means
   * Hypixel did not answer. Only the first may lead to a revocation.
   */
  async function roster(hypixelGuildId: string): Promise<ProbeGuild | null | undefined> {
    const pending = inFlight.get(hypixelGuildId);
    if (pending !== undefined) return pending;

    const fetch = (async (): Promise<ProbeGuild | null | undefined> => {
      const result = await hypixel.getGuild(hypixelGuildId, "id").catch(() => null);
      if (result === null) return undefined;
      if (!result.ok || result.value === undefined) {
        // `MISSING_PROFILE` here is the client's word for a well-formed
        // response carrying no guild — Hypixel answered, and the answer is that
        // there is nobody in this guild to be a member of. That is a fact, and
        // it is the one that revokes the guild role of somebody who has left.
        //
        // Every other state is an outage in some costume: rate limited, key
        // rejected, upstream unreachable. None of them is evidence about the
        // member, so none of them may revoke anything.
        return result.error?.state === "MISSING_PROFILE" ? null : undefined;
      }
      return result.value.data;
    })();

    inFlight.set(hypixelGuildId, fetch);
    try {
      return await fetch;
    } finally {
      // Cleared on settle rather than on a timer: the entry exists to join
      // callers to one request, and once that request is answered the client's
      // cache is what serves the next one.
      inFlight.delete(hypixelGuildId);
    }
  }

  return {
    async rank(hypixelGuildId, uuid) {
      const guild = await roster(hypixelGuildId);
      if (guild === undefined) return undefined;
      // Hypixel answered and there is no such guild. Nobody is in it.
      if (guild === null) return null;
      // Belt and braces: the id we asked for should be the id we got, and if it
      // is not, we are holding somebody else's roster and must not judge a
      // member against it.
      if (guild.id !== hypixelGuildId) return undefined;

      const member = guild.members.find((m) => sameUuid(m.uuid, uuid));
      // Not on the roster is a confirmed fact rather than a failure, so it
      // revokes.
      if (member === undefined) return null;
      // A guild with no rank names still has members; treat a blank rank as the
      // default one rather than as absence, since `guildRank !== null` is what
      // the rules read as membership.
      return member.rank ?? "Member";
    },
  };
}

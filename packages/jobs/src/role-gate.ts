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
 * So the link asks. One request, `guild?player=<uuid>`, already cached for five
 * minutes by the client, answering both halves of the gate at once: whether
 * they are in *this* guild, and at what rank.
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
 * Build the probe.
 *
 * The three return values are the three honest answers, and the third is the
 * reason this is not a boolean: a rank string, `null` for "Hypixel answered and
 * they are not in this guild", and `undefined` for "Hypixel did not answer".
 * Only the middle one is allowed to cause a revocation.
 */
export function createGuildRankProbe(hypixel: GuildLookup): {
  rank(hypixelGuildId: string, uuid: string): Promise<string | null | undefined>;
} {
  return {
    async rank(hypixelGuildId, uuid) {
      const result = await hypixel.getGuild(uuid, "player").catch(() => null);
      if (result === null) return undefined;
      if (!result.ok || result.value === undefined) {
        // `MISSING_PROFILE` here is the client's word for a well-formed
        // response carrying no guild — Hypixel answered, and the answer is that
        // this player is in no guild at all. That is a fact, and it is the one
        // that revokes the guild role of somebody who has left.
        //
        // Every other state is an outage in some costume: rate limited, key
        // rejected, upstream unreachable. None of them is evidence about the
        // member, so none of them may revoke anything.
        return result.error?.state === "MISSING_PROFILE" ? null : undefined;
      }

      const guild = result.value.data;
      // A player in *some other* guild is, for this guild's rules, not a member
      // — and that is a confirmed fact rather than a failure, so it revokes.
      if (guild.id !== hypixelGuildId) return null;

      const member = guild.members.find((m) => sameUuid(m.uuid, uuid));
      if (member === undefined) return null;
      // A guild with no rank names still has members; treat a blank rank as the
      // default one rather than as absence, since `guildRank !== null` is what
      // the rules read as membership.
      return member.rank ?? "Member";
    },
  };
}

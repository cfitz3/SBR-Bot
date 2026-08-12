/**
 * SkyKings API types (https://api.skykings.net, v1.0.0).
 *
 * The DTOs mirror the documented payloads; the *result* types are ours, and the
 * distinction they draw is the one this package exists for: "not flagged" and
 * "we could not find out" must never collapse into the same value. Every caller
 * here is deciding whether to let a stranger into the guild, and an outage that
 * reads as an all-clear is the one failure mode worth designing against.
 */

/** Why an answer is unknown. Separated because they call for different handling. */
export type SkykingsUnknownCause =
  /** No API key configured — a deployment fact, not a transient one. */
  | "NOT_CONFIGURED"
  /** The key was rejected. Also permanent until someone fixes it. */
  | "UNAUTHORIZED"
  /** Upstream said no, briefly. Retrying later is reasonable. */
  | "RATE_LIMITED"
  /**
   * The route answered 404 — not "no record", but "no such endpoint".
   *
   * Its own cause because it is the one failure nobody on our side can fix by
   * waiting or by rotating a key: the documented path is not deployed. Kept
   * distinct from UNAVAILABLE so the report says so rather than reading as a
   * blip, and so the client can stop firing doomed requests for a while.
   */
  | "ENDPOINT_MISSING"
  /** Down, timed out, or answered something unreadable. */
  | "UNAVAILABLE";

export type SkykingsResult<T> =
  | { readonly status: "OK"; readonly data: T }
  | { readonly status: "UNKNOWN"; readonly cause: SkykingsUnknownCause; readonly detail?: string };

/**
 * The scammer verdict for one identifier.
 *
 * `CLEAR` means SkyKings answered and had nothing on file — it is not a
 * character reference, only the absence of a listing.
 */
export type ScammerCheck =
  | { readonly status: "CLEAR" }
  | { readonly status: "FLAGGED"; readonly reason: string | null; readonly message: string | null }
  | { readonly status: "UNKNOWN"; readonly cause: SkykingsUnknownCause; readonly detail?: string };

/** `/user/info` — the SkyKings link between a Minecraft account and a Discord user. */
export interface SkykingsLinkDTO {
  readonly uuid: string;
  readonly userid: string;
}

/** One profile row inside `/leaderboard/user`. */
export interface SkykingsProfileDTO {
  readonly profileName: string | null;
  readonly skyblockXp: number | null;
  readonly networth: number | null;
}

/**
 * `/leaderboard/user` — SkyKings' own tracked snapshot of a player.
 *
 * Useful at screening time as a *second opinion* that costs no Hypixel budget
 * and, unlike a live read, exists even when the player has their API settings
 * switched off. Fields are individually nullable because the tracker fills them
 * in over time; a player it has never seen is a miss, not an error.
 */
export interface SkykingsPlayerDTO {
  readonly uuid: string;
  readonly username: string | null;
  /** The guild SkyKings last saw them in — the "who are they leaving" signal. */
  readonly guild: string | null;
  readonly networth: number | null;
  readonly lilyWeight: number | null;
  readonly senitherWeight: number | null;
  readonly eliteWeight: number | null;
  readonly profiles: readonly SkykingsProfileDTO[];
  /** ISO timestamp of SkyKings' last refresh, or null when it never said. */
  readonly lastChecked: string | null;
}

export interface SkykingsGuildDTO {
  readonly name: string;
  readonly discordLink: string | null;
  readonly averageNetworth: number | null;
  readonly averageLilyWeight: number | null;
  readonly averageSenitherWeight: number | null;
  readonly memberCount: number | null;
  readonly lastChecked: string | null;
}

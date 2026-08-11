/**
 * Who Discord considers able to manage a guild.
 *
 * Extracted from the OAuth callback for the same reason as `static.ts`: the
 * callback needs a guard, and a guard is worth testing on its own. Getting this
 * wrong is invisible — a dropped guild looks exactly like a guild the platform
 * was never set up for, and the empty selector says the latter.
 *
 * `/users/@me/guilds` documents `permissions` as the user's total permissions
 * "excluding implicit permissions". ADMINISTRATOR's grant-everything behaviour
 * is precisely an implicit permission, so Discord does *not* expand it into the
 * other bits: a role with Administrator checked and Manage Server unchecked
 * comes back with 0x8 set and 0x20 clear. Testing MANAGE_GUILD alone therefore
 * refuses people Discord's own UI says can manage the server, which is a
 * disagreement the panel has no business having.
 */

/** Manage Server. */
export const MANAGE_GUILD = 0x20n;
/** Grants every permission implicitly, including MANAGE_GUILD. */
export const ADMINISTRATOR = 0x8n;

/**
 * Read one entry's `permissions` field from `/users/@me/guilds`.
 *
 * Total, not per-channel: this endpoint reports guild-level permissions with no
 * channel overwrites applied, which is the right granularity for "may this
 * person configure the guild".
 *
 * Accepts a number as well as a string. Modern API versions send the bitfield
 * as a decimal *string*, because it long ago outgrew what a JSON number can
 * hold exactly — but older versions send a number, and an unversioned request
 * gets whichever version Discord currently treats as the default. Insisting on
 * a string here is not strictness, it is a silent total rejection whenever that
 * default moves: every guild fails the gate and the panel reports, wrongly,
 * that the platform knows none of them. `DISCORD_API` pins the version so this
 * shouldn't arise; this accepts both anyway, because the failure is invisible.
 *
 * Returns false rather than throwing on anything malformed. One unparseable
 * entry in the list is not a reason to fail a login over the other guilds in it.
 */
export function canManageGuild(permissions: unknown): boolean {
  let bits: bigint;
  if (typeof permissions === "bigint") {
    bits = permissions;
  } else if (typeof permissions === "number") {
    // A non-integer or one past 2^53 didn't survive JSON parsing intact, so the
    // bits are not the bits Discord sent and no answer from them is meaningful.
    if (!Number.isSafeInteger(permissions)) return false;
    bits = BigInt(permissions);
  } else if (typeof permissions === "string") {
    try {
      bits = BigInt(permissions);
    } catch {
      return false;
    }
  } else {
    return false;
  }
  // A negative bitfield is not something Discord sends; `&` on one would test
  // two's-complement bits and can read as true for a value that means nothing.
  if (bits < 0n) return false;

  if ((bits & ADMINISTRATOR) === ADMINISTRATOR) return true;
  return (bits & MANAGE_GUILD) === MANAGE_GUILD;
}

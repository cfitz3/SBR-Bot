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
 * Returns false rather than throwing on anything malformed. Discord sends a
 * decimal string, but one unparseable entry in the list is not a reason to fail
 * a login over the other guilds in it.
 */
export function canManageGuild(permissions: unknown): boolean {
  if (typeof permissions !== "string") return false;

  let bits: bigint;
  try {
    bits = BigInt(permissions);
  } catch {
    return false;
  }
  // A negative bitfield is not something Discord sends; `&` on one would test
  // two's-complement bits and can read as true for a value that means nothing.
  if (bits < 0n) return false;

  if ((bits & ADMINISTRATOR) === ADMINISTRATOR) return true;
  return (bits & MANAGE_GUILD) === MANAGE_GUILD;
}

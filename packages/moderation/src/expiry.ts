/**
 * Whether a punishment is still in force.
 *
 * Two things can end one: a staffer lifting it, which clears the `active`
 * column, and its own clock running out, which changes nothing in the database
 * until a sweep gets round to it. A reader that trusted `active` alone would
 * therefore report a mute as live for as long as it took the sweep to run, and
 * one that trusted `expiresAt` alone would report a lifted ban as live until
 * its original expiry. The state is a function of both.
 *
 * `expiresAt` is checked first on purpose: once the clock has run out the
 * punishment ended by expiry, whatever the flag says afterwards. That keeps the
 * sweep free to clear `active` without turning every expired mute into
 * something a staffer appears to have lifted by hand.
 */
import type { ModActionType, ModerationActionDTO } from "@sbr/shared-types";

/**
 * The actor a reversal is attributed to when the clock, rather than a person,
 * ended a punishment.
 *
 * A real staffer's snowflake would be a lie — nobody chose this — and the
 * platform's own bot id is not available in every process that sweeps. Like
 * `AUTOMOD_ACTOR`, this is a system actor, exempt from the rank hierarchy for
 * the same reason: there is no rank question to answer when the guild's own
 * clock is doing the acting.
 */
export const EXPIRY_ACTOR = "expiry";

export type PunishmentState =
  /** Still being enforced right now. */
  | "ACTIVE"
  /** Ran its duration out. */
  | "EXPIRED"
  /** Ended early by a staffer (`/unmute`, `/unban`). */
  | "LIFTED"
  /** Never held enforcement state: a warning, a kick, a note, a role change. */
  | "MOMENTARY";

/**
 * The action types that hold enforcement state over time.
 *
 * A kick is punitive but instantaneous — the member is gone the moment it lands
 * and there is nothing to lift — so it belongs with notes and warnings here even
 * though it belongs with mutes and bans in `isPunitive`.
 */
const ENFORCEMENT_TYPES: ReadonlySet<ModActionType> = new Set<ModActionType>(["MUTE", "BAN"]);

export function holdsEnforcement(type: ModActionType): boolean {
  return ENFORCEMENT_TYPES.has(type);
}

export function punishmentState(
  action: Pick<ModerationActionDTO, "type" | "active" | "expiresAt">,
  now: Date = new Date(),
): PunishmentState {
  if (!holdsEnforcement(action.type)) return "MOMENTARY";
  if (action.expiresAt !== null && Date.parse(action.expiresAt) <= now.getTime()) return "EXPIRED";
  return action.active ? "ACTIVE" : "LIFTED";
}

/** Is this action being enforced at `now`? Permanent bans have no expiry and stay true. */
export function isInForce(
  action: Pick<ModerationActionDTO, "type" | "active" | "expiresAt">,
  now: Date = new Date(),
): boolean {
  return punishmentState(action, now) === "ACTIVE";
}

/** The punishments a member is currently serving, newest first (input order preserved). */
export function inForce<T extends Pick<ModerationActionDTO, "type" | "active" | "expiresAt">>(
  actions: readonly T[],
  now: Date = new Date(),
): readonly T[] {
  return actions.filter((a) => isInForce(a, now));
}

// `expiredButFlaggedActive` used to sit here: an in-memory filter for "flagged
// active, but the clock has run out". It never had a caller. The sweep asks the
// database that question directly (`listExpiredActive`), because loading every
// action row into a worker to filter it in JavaScript is not a thing this
// platform should offer a way to do.

/** Display word for the state, for embeds and the panel. */
export function describeState(state: PunishmentState): string {
  switch (state) {
    case "ACTIVE":
      return "in force";
    case "EXPIRED":
      return "expired";
    case "LIFTED":
      return "lifted";
    case "MOMENTARY":
      return "";
  }
}

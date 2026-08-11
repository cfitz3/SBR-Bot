/**
 * What a party looks like, per activity.
 *
 * This is deliberately a data table in a domain package rather than a Prisma
 * enum. Skyblock's class and role vocabulary moves with the game — Kuudra's
 * roles were named differently a year ago and will be again — and a rename
 * should be a one-line edit here, not a migration plus a backfill plus a
 * deploy ordering problem.
 *
 * Roles are stored and compared lowercase. People type these from memory in
 * guild chat, so "Healer", "healer" and "HEALER" have to be the same thing.
 */
import type { LFGActivity } from "@sbr/shared-types";

export interface ActivityShape {
  /** Seats in a party. The roster may not exceed this. */
  readonly capacity: number;
  /** Accepted role names, lowercase. Order is the order they are offered in. */
  readonly roles: readonly string[];
}

/**
 * `filler` exists for every activity on purpose: perms are formed before they
 * are staffed, and "we need a fifth, role TBD" is a real state that a strict
 * vocabulary would force people to lie about.
 */
const GENERIC_ROLES = ["carry", "member", "filler"] as const;

const SHAPES: Readonly<Record<LFGActivity, ActivityShape>> = {
  // A dungeon party is five, one per class, and that has not changed since
  // Catacombs shipped.
  DUNGEONS: { capacity: 5, roles: ["healer", "mage", "berserk", "archer", "tank", "filler"] },
  // Kuudra is four, and the roles are jobs rather than classes.
  KUUDRA: { capacity: 4, roles: ["tank", "damage", "cannoneer", "supplier", "filler"] },
  // Slayers are solo content run as a group; there is no role system, but there
  // is a meaningful carry/carried distinction worth recording.
  SLAYERS: { capacity: 6, roles: [...GENERIC_ROLES] },
  FISHING: { capacity: 6, roles: [...GENERIC_ROLES] },
  MINING: { capacity: 6, roles: [...GENERIC_ROLES] },
  OTHER: { capacity: 6, roles: [...GENERIC_ROLES] },
};

export function shapeOf(activity: LFGActivity): ActivityShape {
  return SHAPES[activity] ?? SHAPES.OTHER;
}

export function capacityOf(activity: LFGActivity): number {
  return shapeOf(activity).capacity;
}

export function rolesFor(activity: LFGActivity): readonly string[] {
  return shapeOf(activity).roles;
}

/**
 * Normalize a typed role to its canonical form, or null if the activity has no
 * such role. Handles the aliases people actually use rather than insisting on
 * the canonical spelling — `berserker` and `bers` are the same class as
 * `berserk`, and rejecting them teaches nothing.
 */
export function normalizeRole(activity: LFGActivity, raw: string): string | null {
  const key = raw.trim().toLowerCase();
  if (key === "") return null;

  const roles = rolesFor(activity);
  if (roles.includes(key)) return key;

  const alias = ALIASES[key];
  if (alias !== undefined && roles.includes(alias)) return alias;
  return null;
}

/** Alias → canonical. Only consulted when the activity actually has the target role. */
const ALIASES: Readonly<Record<string, string>> = {
  berserker: "berserk",
  bers: "berserk",
  berzerk: "berserk",
  zerk: "berserk",
  arch: "archer",
  heal: "healer",
  dps: "damage",
  dmg: "damage",
  cannon: "cannoneer",
  cannons: "cannoneer",
  supply: "supplier",
  supplies: "supplier",
  sub: "filler",
  tbd: "filler",
  any: "filler",
};

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

/**
 * Role -> the platform's metric name for that class's level.
 *
 * Dungeons is the only activity whose roles are *classes* — things a player
 * levels — and this is the seam where that fact is written down. Kuudra's roles
 * are jobs, and a job has no level, so they are absent here and the roster
 * prints nothing for them rather than inventing a number.
 *
 * `filler` is absent for the same reason: it is a seat nobody has claimed yet.
 *
 * This is also where the ctjs stats feed lands when it arrives. Splits, secrets
 * and deaths are per-role figures in exactly the way a class level is, so they
 * extend this table and the roster line that reads it, rather than needing a
 * second path through the renderer.
 */
const CLASS_METRICS: Readonly<Record<string, string>> = {
  healer: "classHealer",
  mage: "classMage",
  berserk: "classBerserk",
  archer: "classArcher",
  tank: "classTank",
};

/**
 * The metric holding this role's class level, or null where the role has none.
 *
 * Takes the activity as well as the role because `tank` is a class in Catacombs
 * and a job in Kuudra: the same word, and only one of them has a level to read.
 */
export function classMetricFor(activity: LFGActivity, role: string): string | null {
  if (activity !== "DUNGEONS") return null;
  return CLASS_METRICS[role.trim().toLowerCase()] ?? null;
}

/** The roles of this activity that are levelled classes, in offer order. */
export function classRolesFor(activity: LFGActivity): readonly string[] {
  return rolesFor(activity).filter((role) => classMetricFor(activity, role) !== null);
}

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

/**
 * The widened progression readings — the numbers a member tracks that are not
 * one of the six the platform started with.
 *
 * These are separate from `parse.ts` because they are not a DTO anybody renders
 * whole. `parse.ts` builds structured objects a command prints; this pulls single
 * numbers off the member blob, each one standing on its own. What a consumer
 * does with a scalar is the consumer's business — this file only reads it.
 *
 * Same discipline as the parsers next door: the input is `unknown`, every field
 * here has moved between API generations or is omitted outright when a profile
 * hides a section, and absent is `null` rather than `0`. A zero is a real
 * reading that a threshold can sit under; a null is "we could not see".
 */
/**
 * Just enough of a museum response to count what has been donated.
 *
 * Declared here rather than beside the provider that fetches it: this is a
 * shape the parser reads, and a parser package that owns the shapes it parses
 * is one a consumer can take without also taking the fetching layer.
 */
export interface MuseumRead {
  readonly members: Readonly<Record<string, unknown>>;
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function dig(root: unknown, ...path: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    const record = obj(cursor);
    if (!record) return undefined;
    cursor = record[key];
  }
  return cursor;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Fairy souls collected, across both API generations.
 *
 * A collection number rather than a rate: it only ever goes up, which is what
 * makes it worth charting at all — a member grinding souls sees the line move
 * on a week where nothing else did.
 */
export function fairySouls(member: unknown): number | null {
  const modern = num(dig(member, "fairy_soul", "total_collected"));
  if (modern !== null) return modern;
  return num(dig(member, "fairy_souls_collected"));
}

/** Rarity → points, as the pet menu scores them. */
const PET_SCORE_BY_TIER: Readonly<Record<string, number>> = {
  COMMON: 1,
  UNCOMMON: 2,
  RARE: 3,
  EPIC: 4,
  LEGENDARY: 5,
  MYTHIC: 6,
};

/**
 * Pet score: the best rarity held of each distinct pet, summed.
 *
 * Two Legendary Golden Dragons score once, because the game counts the *pet*
 * and not the copies — scoring the copies would let somebody inflate the number
 * by hoarding duplicates they cannot use.
 */
export function petScore(member: unknown): number | null {
  const pets = dig(member, "pets_data", "pets") ?? dig(member, "pets");
  if (!Array.isArray(pets)) return null;

  const best = new Map<string, number>();
  for (const entry of pets) {
    const pet = obj(entry);
    if (!pet) continue;
    const type = typeof pet["type"] === "string" ? pet["type"] : null;
    const tier = typeof pet["tier"] === "string" ? pet["tier"] : null;
    if (type === null || tier === null) continue;
    const score = PET_SCORE_BY_TIER[tier];
    if (score === undefined) continue;
    best.set(type, Math.max(best.get(type) ?? 0, score));
  }

  // An empty pet menu is a real zero — the member has been read and has no
  // pets — while an unreadable one returned null above.
  let total = 0;
  for (const score of best.values()) total += score;
  return total;
}

/**
 * Unique minions crafted → slots unlocked, as the game's own table awards them.
 *
 * The tiers are what Hypixel stores; the slots are what a member cares about,
 * because slots are the thing that gates income. Anything past the last
 * threshold stays at the last value rather than extrapolating a rule we would
 * be inventing.
 */
const MINION_SLOT_THRESHOLDS: readonly (readonly [crafted: number, slots: number])[] = [
  [0, 5], [5, 6], [15, 7], [30, 8], [50, 9], [75, 10], [100, 11], [125, 12],
  [150, 13], [175, 14], [200, 15], [225, 16], [250, 17], [275, 18], [300, 19],
  [350, 20], [400, 21], [450, 22], [500, 23], [550, 24], [600, 25],
];

/** Distinct minion tiers crafted — the input to the slot table. */
export function minionsCrafted(member: unknown): number | null {
  const crafted = dig(member, "crafted_generators");
  if (!Array.isArray(crafted)) return null;
  const unique = new Set(crafted.filter((c): c is string => typeof c === "string"));
  return unique.size;
}

export function minionSlots(member: unknown): number | null {
  const crafted = minionsCrafted(member);
  if (crafted === null) return null;

  let slots = MINION_SLOT_THRESHOLDS[0]![1];
  for (const [threshold, value] of MINION_SLOT_THRESHOLDS) {
    if (crafted >= threshold) slots = value;
  }
  return slots;
}

/** The essence wallet, across both API generations. */
const ESSENCE_TYPES = [
  "WITHER",
  "SPIDER",
  "UNDEAD",
  "DRAGON",
  "GOLD",
  "DIAMOND",
  "ICE",
  "CRIMSON",
] as const;

/**
 * Every essence type added together.
 *
 * A total rather than eight metrics: essence is spent from one wallet on one
 * kind of thing — upgrading gear — and eight lines on a chart would say less
 * than one. Null only when no type was readable at all, so a profile that has
 * simply never earned Crimson still reports the rest.
 */
export function essenceTotal(member: unknown): number | null {
  let total = 0;
  let seen = false;
  for (const type of ESSENCE_TYPES) {
    const modern = num(dig(member, "currencies", "essence", type, "current"));
    const legacy = num(dig(member, `essence_${type.toLowerCase()}`));
    const value = modern ?? legacy;
    if (value === null) continue;
    seen = true;
    total += value;
  }
  return seen ? total : null;
}

/**
 * Items donated to the museum, for one member of a profile.
 *
 * A count rather than a percentage, deliberately. The museum has no published
 * denominator: the set of donatable items grows with every content patch, so a
 * percentage would need a number we hardcode and that silently drifts wrong
 * between updates. "412 donated" stays true; "68% complete" quietly stops
 * being true and never says so.
 *
 * `special` items are counted alongside the regular ones because the museum
 * itself displays them together and a member who donated one expects to see it.
 */
export function museumDonations(museum: MuseumRead | null, uuid: string): number | null {
  if (!museum) return null;
  // Hypixel keys museum members by undashed uuid; accept either form rather
  // than depending on which shape the caller happens to hold.
  const key = uuid.replace(/-/g, "");
  const entry = obj(museum.members[key] ?? museum.members[uuid]);
  if (!entry) return null;

  const items = obj(entry["items"]);
  const special = entry["special"];
  const donated = (items ? Object.keys(items).length : 0) + (Array.isArray(special) ? special.length : 0);
  return donated;
}

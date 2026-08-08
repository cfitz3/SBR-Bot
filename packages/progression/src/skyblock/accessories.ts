/**
 * Accessory (talisman) analysis behind `/missing`.
 *
 * Magical power follows the game's rules: each accessory contributes by
 * rarity, a recombobulator counts as one rarity higher, and only the best
 * member of an upgrade family counts — a Bat Talisman sitting next to a Bat
 * Artifact is dead weight, which is exactly the thing `/missing` should say.
 *
 * The catalog below is deliberately *notable* rather than exhaustive: it covers
 * the accessories worth telling somebody about. An accessory outside it still
 * counts toward magical power (it is read from the bag, not from this list); it
 * simply never appears as a suggestion. `CATALOG_NOTE` states that in the
 * embed, so nobody reads an empty "missing" list as "you own everything".
 */
import { readBag, type BagItem } from "./nbt.js";

export const CATALOG_NOTE = "Suggestions cover notable accessories only, not every talisman in the game.";

export type Rarity = "COMMON" | "UNCOMMON" | "RARE" | "EPIC" | "LEGENDARY" | "MYTHIC" | "SPECIAL" | "VERY_SPECIAL";

/** Magical power granted per accessory, by rarity. */
const MAGICAL_POWER: Readonly<Record<Rarity, number>> = {
  COMMON: 3,
  UNCOMMON: 5,
  RARE: 8,
  EPIC: 12,
  LEGENDARY: 16,
  MYTHIC: 22,
  SPECIAL: 3,
  VERY_SPECIAL: 5,
};

/** Recombobulating lifts an accessory one step along this ladder. */
const LADDER: readonly Rarity[] = ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY", "MYTHIC"];

function recombobulate(rarity: Rarity): Rarity {
  const i = LADDER.indexOf(rarity);
  if (i < 0 || i === LADDER.length - 1) return rarity;
  return LADDER[i + 1] ?? rarity;
}

export interface CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly rarity: Rarity;
  /**
   * Upgrade family. Only the highest tier in a family contributes magical
   * power, so a lower tier held alongside a higher one is redundant.
   */
  readonly family?: string;
  /** Position within the family; higher is better. */
  readonly tier?: number;
  /** Why somebody would want it — shown verbatim in the embed. */
  readonly why: string;
}

/**
 * Notable accessories. Ordered roughly by how early a member should get them,
 * which is the order `/missing` suggests them in.
 */
export const CATALOG: readonly CatalogEntry[] = [
  { id: "SPEED_TALISMAN", name: "Speed Talisman", rarity: "COMMON", family: "SPEED", tier: 1, why: "+1 speed; the first step of a cheap family." },
  { id: "SPEED_RING", name: "Speed Ring", rarity: "UNCOMMON", family: "SPEED", tier: 2, why: "Replaces the Speed Talisman for +3 speed." },
  { id: "SPEED_ARTIFACT", name: "Speed Artifact", rarity: "RARE", family: "SPEED", tier: 3, why: "Top of the speed family, +5 speed." },
  { id: "WOLF_TALISMAN", name: "Wolf Talisman", rarity: "UNCOMMON", family: "WOLF", tier: 1, why: "Cheap magical power and wolf-slayer damage." },
  { id: "WOLF_RING", name: "Wolf Ring", rarity: "RARE", family: "WOLF", tier: 2, why: "Upgrade over the Wolf Talisman." },
  { id: "BAT_TALISMAN", name: "Bat Talisman", rarity: "UNCOMMON", family: "BAT", tier: 1, why: "Night-time intelligence and speed." },
  { id: "BAT_RING", name: "Bat Ring", rarity: "RARE", family: "BAT", tier: 2, why: "Upgrade over the Bat Talisman." },
  { id: "BAT_ARTIFACT", name: "Bat Artifact", rarity: "EPIC", family: "BAT", tier: 3, why: "Top of the bat family." },
  { id: "CANDY_RING", name: "Candy Ring", rarity: "RARE", family: "CANDY", tier: 1, why: "Straightforward health and magical power." },
  { id: "CANDY_ARTIFACT", name: "Candy Artifact", rarity: "EPIC", family: "CANDY", tier: 2, why: "Upgrade over the Candy Ring." },
  { id: "RED_CLAW_TALISMAN", name: "Red Claw Talisman", rarity: "UNCOMMON", family: "RED_CLAW", tier: 1, why: "+1% crit damage." },
  { id: "RED_CLAW_RING", name: "Red Claw Ring", rarity: "RARE", family: "RED_CLAW", tier: 2, why: "+2% crit damage." },
  { id: "RED_CLAW_ARTIFACT", name: "Red Claw Artifact", rarity: "EPIC", family: "RED_CLAW", tier: 3, why: "+3% crit damage; a core DPS accessory." },
  { id: "TREASURE_TALISMAN", name: "Treasure Talisman", rarity: "UNCOMMON", family: "TREASURE", tier: 1, why: "Magic find for drop hunting." },
  { id: "TREASURE_RING", name: "Treasure Ring", rarity: "RARE", family: "TREASURE", tier: 2, why: "More magic find." },
  { id: "TREASURE_ARTIFACT", name: "Treasure Artifact", rarity: "EPIC", family: "TREASURE", tier: 3, why: "Top magic-find accessory outside drops." },
  { id: "CAMPFIRE_TALISMAN_1", name: "Campfire Initiate Badge", rarity: "COMMON", family: "CAMPFIRE", tier: 1, why: "The campfire chain is free magical power over time." },
  { id: "CAMPFIRE_TALISMAN_13", name: "Campfire God Badge", rarity: "LEGENDARY", family: "CAMPFIRE", tier: 13, why: "End of the campfire chain — a large free magical power block." },
  { id: "NEW_YEAR_CAKE_BAG", name: "New Year Cake Bag", rarity: "EPIC", why: "Epic magical power for anyone who collects cakes." },
  { id: "ODGERS_BRILLIANT_ROD", name: "Odger's Brilliant Rod", rarity: "EPIC", why: "Fishing progression accessory." },
  { id: "HEGEMONY_ARTIFACT", name: "Hegemony Artifact", rarity: "LEGENDARY", why: "Doubles its own magical power — the single biggest accessory jump." },
  { id: "PARTY_HAT_CRAB", name: "Party Hat", rarity: "RARE", why: "Free event accessory, pure magical power." },
  { id: "POTION_AFFINITY_TALISMAN", name: "Potion Affinity Talisman", rarity: "UNCOMMON", family: "POTION_AFFINITY", tier: 1, why: "Longer potion durations." },
  { id: "POTION_AFFINITY_RING", name: "Potion Affinity Ring", rarity: "RARE", family: "POTION_AFFINITY", tier: 2, why: "Upgrade over the Potion Affinity Talisman." },
  { id: "POTION_AFFINITY_ARTIFACT", name: "Potion Affinity Artifact", rarity: "EPIC", family: "POTION_AFFINITY", tier: 3, why: "Top of the potion affinity family." },
  { id: "WEDDING_RING_9", name: "Dyed Wedding Ring", rarity: "LEGENDARY", why: "High magical power from a maxed best-friend ring." },
  { id: "ETHERWARP_CONDUIT", name: "Etherwarp Conduit", rarity: "EPIC", why: "Unlocks etherwarp on an Aspect of the Void — a movement upgrade, not just power." },
];

const BY_ID = new Map(CATALOG.map((e) => [e.id, e]));

export interface OwnedAccessory {
  readonly id: string;
  readonly name: string;
  readonly rarity: Rarity;
  readonly magicalPower: number;
  readonly recombobulated: boolean;
}

export interface AccessoryReport {
  /** Null when the bag could not be read at all. */
  readonly magicalPower: number | null;
  readonly tuning: string | null;
  readonly owned: readonly OwnedAccessory[];
  /** Notable accessories the member does not have, best first. */
  readonly missing: readonly CatalogEntry[];
  /** Owned at a lower tier than the family offers. */
  readonly upgradeable: readonly { readonly have: CatalogEntry; readonly to: CatalogEntry }[];
  /** Held alongside a strictly better family member, contributing nothing. */
  readonly redundant: readonly CatalogEntry[];
  /** True when the bag is unreadable — every list above is then empty. */
  readonly apiDisabled: boolean;
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

/** The member's active tuning preset, e.g. "health" — cosmetic context for the embed. */
function readTuning(member: unknown): string | null {
  const slot = dig(member, "accessory_bag_storage", "tuning", "slot_0");
  const record = obj(slot);
  if (!record) return null;
  const best = Object.entries(record)
    .filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0)
    .sort((a, b) => b[1] - a[1])[0];
  return best ? `${best[0]} ${best[1]}` : null;
}

function rarityOf(item: BagItem): Rarity {
  const base = BY_ID.get(item.id)?.rarity ?? "COMMON";
  return item.recombobulated ? recombobulate(base) : base;
}

/**
 * Analyse the talisman bag. Accessories outside the catalog are still counted
 * toward magical power at their observed rarity; they are just never suggested.
 */
export function analyseAccessories(member: unknown): AccessoryReport {
  const items =
    readBag(dig(member, "inventory", "bag_contents", "talisman_bag")) ??
    readBag(dig(member, "talisman_bag"));

  if (!items) {
    return {
      magicalPower: null,
      tuning: readTuning(member),
      owned: [],
      missing: [],
      upgradeable: [],
      redundant: [],
      apiDisabled: true,
    };
  }

  // Deduplicate: a second copy of the same accessory grants nothing.
  const bestById = new Map<string, BagItem>();
  for (const item of items) {
    const seen = bestById.get(item.id);
    if (!seen || (item.recombobulated && !seen.recombobulated)) bestById.set(item.id, item);
  }

  // Within a family only the highest tier counts.
  const bestPerFamily = new Map<string, CatalogEntry>();
  for (const id of bestById.keys()) {
    const entry = BY_ID.get(id);
    if (!entry?.family) continue;
    const held = bestPerFamily.get(entry.family);
    if (!held || (entry.tier ?? 0) > (held.tier ?? 0)) bestPerFamily.set(entry.family, entry);
  }

  const owned: OwnedAccessory[] = [];
  const redundant: CatalogEntry[] = [];
  let magicalPower = 0;

  for (const item of bestById.values()) {
    const entry = BY_ID.get(item.id);
    if (entry?.family) {
      const best = bestPerFamily.get(entry.family);
      if (best && best.id !== entry.id) {
        redundant.push(entry);
        continue;
      }
    }
    const rarity = rarityOf(item);
    // Hegemony is the game's one special case: it grants double.
    const power = MAGICAL_POWER[rarity] * (item.id === "HEGEMONY_ARTIFACT" ? 2 : 1);
    magicalPower += power;
    owned.push({
      id: item.id,
      name: entry?.name ?? item.name ?? item.id,
      rarity,
      magicalPower: power,
      recombobulated: item.recombobulated,
    });
  }

  const missing: CatalogEntry[] = [];
  const upgradeable: { have: CatalogEntry; to: CatalogEntry }[] = [];
  for (const entry of CATALOG) {
    if (bestById.has(entry.id)) continue;
    const held = entry.family ? bestPerFamily.get(entry.family) : undefined;
    if (held && (held.tier ?? 0) >= (entry.tier ?? 0)) continue; // already better
    if (held) upgradeable.push({ have: held, to: entry });
    else missing.push(entry);
  }

  return {
    magicalPower,
    tuning: readTuning(member),
    owned: owned.sort((a, b) => b.magicalPower - a.magicalPower),
    missing,
    upgradeable,
    redundant,
    apiDisabled: false,
  };
}

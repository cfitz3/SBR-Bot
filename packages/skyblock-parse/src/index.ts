/**
 * @sbr/skyblock-parse — pure parsers over a raw Skyblock member blob.
 *
 * Nothing here performs I/O, reads configuration, or knows a guild exists. The
 * input is always `unknown` — a member object straight off the API — and the
 * output is always a typed DTO or `null`. That is the whole contract, and it is
 * what lets two very different consumers share one set of numbers: the guild
 * platform's progression service, and SBR-Guide, which is submitted for API
 * review as a standalone repository and must not inherit a tracking surface to
 * get its parsers (docs/GUIDE.md).
 *
 * The defensive discipline is uniform and load-bearing: a field Hypixel omits,
 * or that a profile hides behind its API settings, becomes `null` — never `0`.
 * Zero is a real reading a threshold can sit under; null is "we could not see"
 * (HYPIXEL_DATA_LAYER.md §5).
 */
export { readBag, type BagItem } from "./nbt.js";
export {
  analyseAccessories,
  CATALOG,
  CATALOG_NOTE,
  type AccessoryReport,
  type CatalogEntry,
  type OwnedAccessory,
  type Rarity,
} from "./accessories.js";
export { bestiaryMilestone, parseDungeons, parseSkills, parseSlayers, skyblockLevel } from "./parse.js";
export {
  essenceTotal,
  fairySouls,
  minionSlots,
  minionsCrafted,
  museumDonations,
  petScore,
  type MuseumRead,
} from "./metrics.js";
export { senitherWeight } from "./weight.js";
export {
  CATACOMBS_XP,
  levelFromXp,
  RUNECRAFTING_XP,
  SKILL_XP,
  SLAYER_TIERS,
  slayerTier,
  SOCIAL_XP,
  type LevelReading,
} from "./xp.js";

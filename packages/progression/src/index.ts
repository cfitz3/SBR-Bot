/**
 * @sbr/progression — stats & progression, composing the Hypixel profile read
 * with networth valuation.
 */
export { ProgressionServiceImpl, type ProgressionServiceDeps } from "./service.js";
export type { ProfileProvider, SkyblockProfileData, UpgradePriceSource } from "./ports.js";
export { analyseAccessories, CATALOG, CATALOG_NOTE, type AccessoryReport } from "./skyblock/accessories.js";
export { readBag, type BagItem } from "./skyblock/nbt.js";
export {
  buildNextSteps,
  buildUpgradeAdvice,
  GENERIC_ADVICE,
  priceSuggestions,
  type Goal,
  type ProfileFacts,
  type Suggestion,
  type UpgradeFocus,
} from "./skyblock/advice.js";
export { parseDungeons, parseSkills, parseSlayers, skyblockLevel } from "./skyblock/parse.js";
export { senitherWeight } from "./skyblock/weight.js";
export { CATACOMBS_XP, SKILL_XP, levelFromXp, slayerTier, type LevelReading } from "./skyblock/xp.js";

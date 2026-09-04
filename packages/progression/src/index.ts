/**
 * @sbr/progression — stats & progression, composing the Hypixel profile read
 * with networth valuation.
 */
export { ProgressionServiceImpl, type ProgressionServiceDeps } from "./service.js";
export type {
  CommunityMetricsSource,
  ProfileProvider,
  SkyblockProfileData,
  UpgradePriceSource,
} from "./ports.js";
/**
 * The parsers now live in `@sbr/skyblock-parse` and are re-exported unchanged.
 *
 * Every one of these was `@sbr/progression`'s to export before the split, and a
 * consumer should not have to know the split happened. Keeping the surface here
 * is what made moving the files a refactor rather than a migration
 * (docs/PLATFORM_EXPANSION_PLAN.md §0: backward compatible).
 */
export {
  analyseAccessories,
  CATACOMBS_XP,
  CATALOG,
  CATALOG_NOTE,
  levelFromXp,
  parseDungeons,
  parseSkills,
  parseSlayers,
  readBag,
  senitherWeight,
  SKILL_XP,
  skyblockLevel,
  slayerTier,
  type AccessoryReport,
  type BagItem,
  type LevelReading,
} from "@sbr/skyblock-parse";
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

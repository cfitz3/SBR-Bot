/**
 * Browser-side copies of the platform enums these pages render options from.
 *
 * Literal declarations rather than an import of `@sbr/shared-types`, for the
 * same reason as `channel-slots.ts`: these modules are loaded by the browser,
 * and the client half has no bundler, so a runtime import of a workspace
 * package emits a bare specifier the browser cannot resolve. Unlike a view
 * model, which travels as `import type` and erases at emit, these are const
 * objects — real values at runtime — so there is nothing to erase and the
 * import survives into the served JavaScript.
 *
 * That failure is not local to the page that does it: `main.ts` imports every
 * page statically, so one unresolvable specifier fails the whole module graph
 * and the shell never gets past its `Loading…` placeholder.
 *
 * The duplication is deliberate and guarded — `enums.test.ts` runs under Node,
 * imports the real registries, and fails if any list here drifts from them.
 */

/** Metrics a milestone can be measured against (`MILESTONE_METRICS`). */
export const MILESTONE_METRICS = [
  "skyblockLevel",
  "networth",
  "skillAverage",
  "catacombsLevel",
  "slayerXp",
  "senitherWeight",
  "classHealer",
  "classMage",
  "classBerserk",
  "classArcher",
  "classTank",
  "slayerZombie",
  "slayerSpider",
  "slayerWolf",
  "slayerEnderman",
  "slayerBlaze",
  "slayerVampire",
  "bestiaryMilestone",
  "skillFarming",
  "skillMining",
  "skillCombat",
  "skillForaging",
  "skillFishing",
  "skillEnchanting",
  "skillAlchemy",
  "skillTaming",
  "skillHunting",
  "skillCarpentry",
  "fairySouls",
  "museumDonations",
  "petScore",
  "minionSlots",
  "essence",
  "eventsAttended",
  "eventPodiums",
  "guildTenureDays",
  "guildXp",
] as const;
export type MilestoneMetric = (typeof MILESTONE_METRICS)[number];

/**
 * The subset this platform counts itself (`COMMUNITY_MILESTONE_METRICS`).
 *
 * The page needs the distinction for two honest labels: these are recognised
 * from the standing rather than from a crossing, so the "adding one now will
 * not fire retroactively" warning does not apply to them, and there are no
 * recorded rows to count holders from.
 */
export const COMMUNITY_MILESTONE_METRICS = [
  "eventsAttended",
  "eventPodiums",
  "guildTenureDays",
  "guildXp",
] as const;

/** The families a metric groups under (`ACHIEVEMENT_CATEGORIES`). */
export const ACHIEVEMENT_CATEGORIES = [
  "PROGRESSION",
  "WEALTH",
  "DUNGEONS",
  "SKILLS",
  "SLAYER",
  "COMMUNITY",
  "EVENTS",
] as const;
export type AchievementCategory = (typeof ACHIEVEMENT_CATEGORIES)[number];

/** Ascending, rarest last (`ACHIEVEMENT_TIERS`). */
export const ACHIEVEMENT_TIERS = ["BRONZE", "SILVER", "GOLD", "PLATINUM"] as const;
export type AchievementTier = (typeof ACHIEVEMENT_TIERS)[number];

/**
 * Which family each metric belongs to (`CATEGORY_OF_METRIC`).
 *
 * Mirrored rather than imported for the reason at the top of this file, and
 * guarded the same way: `enums.test.ts` compares it against `categoryOfMetric`
 * for every metric in the real registry.
 */
export const CATEGORY_OF_METRIC: Readonly<Record<string, AchievementCategory>> = {
  skyblockLevel: "PROGRESSION",
  senitherWeight: "PROGRESSION",
  bestiaryMilestone: "PROGRESSION",
  networth: "WEALTH",
  catacombsLevel: "DUNGEONS",
  classHealer: "DUNGEONS",
  classMage: "DUNGEONS",
  classBerserk: "DUNGEONS",
  classArcher: "DUNGEONS",
  classTank: "DUNGEONS",
  skillAverage: "SKILLS",
  skillFarming: "SKILLS",
  skillMining: "SKILLS",
  skillCombat: "SKILLS",
  skillForaging: "SKILLS",
  skillFishing: "SKILLS",
  skillEnchanting: "SKILLS",
  skillAlchemy: "SKILLS",
  skillTaming: "SKILLS",
  skillHunting: "SKILLS",
  skillCarpentry: "SKILLS",
  fairySouls: "PROGRESSION",
  museumDonations: "PROGRESSION",
  petScore: "PROGRESSION",
  minionSlots: "PROGRESSION",
  essence: "WEALTH",
  slayerXp: "SLAYER",
  slayerZombie: "SLAYER",
  slayerSpider: "SLAYER",
  slayerWolf: "SLAYER",
  slayerEnderman: "SLAYER",
  slayerBlaze: "SLAYER",
  slayerVampire: "SLAYER",
  eventsAttended: "EVENTS",
  eventPodiums: "EVENTS",
  guildTenureDays: "COMMUNITY",
  guildXp: "COMMUNITY",
};

/**
 * What an event can score (`EVENT_METRICS`).
 *
 * The snapshot metrics and only those: an event score is the difference between
 * two readings of the same figure, and the four community counters cannot
 * produce one worth competing over. See the doc comment on `EVENT_METRICS` in
 * `@sbr/shared-types` for the per-metric reasoning.
 */
export const EVENT_METRICS = [
  "skyblockLevel",
  "networth",
  "skillAverage",
  "catacombsLevel",
  "slayerXp",
  "senitherWeight",
  "classHealer",
  "classMage",
  "classBerserk",
  "classArcher",
  "classTank",
  "slayerZombie",
  "slayerSpider",
  "slayerWolf",
  "slayerEnderman",
  "slayerBlaze",
  "slayerVampire",
  "bestiaryMilestone",
  "skillFarming",
  "skillMining",
  "skillCombat",
  "skillForaging",
  "skillFishing",
  "skillEnchanting",
  "skillAlchemy",
  "skillTaming",
  "skillHunting",
  "skillCarpentry",
  "fairySouls",
  "museumDonations",
  "petScore",
  "minionSlots",
  "essence",
] as const;
export type EventMetric = (typeof EVENT_METRICS)[number];

/**
 * The tracker's polling bounds and its named choices (`EVENT_POLL_*`).
 *
 * The floor is an hour because the Hypixel Developer API Policy allows this
 * platform one request per player per hour, and a participant is a player. A
 * shorter interval would not poll more often -- it would be refused the
 * difference and quietly clamped, which is what the panel used to do.
 */
export const EVENT_POLL_MIN_MINUTES = 60;
export const EVENT_POLL_MAX_MINUTES = 1_440;
export const EVENT_POLL_CHOICES = [60, 120, 180, 360, 720, 1_440] as const;

/** How many metrics one event may score at once (`EVENT_MAX_TRACKED_METRICS`). */
export const EVENT_MAX_TRACKED_METRICS = 5;

/** What kind of thing a milestone recognises. */
export const MilestoneType = {
  SKYBLOCK_LEVEL: "SKYBLOCK_LEVEL",
  SKILL_LEVEL: "SKILL_LEVEL",
  CATACOMBS_LEVEL: "CATACOMBS_LEVEL",
  SLAYER_TIER: "SLAYER_TIER",
  NETWORTH_THRESHOLD: "NETWORTH_THRESHOLD",
  COLLECTION: "COLLECTION",
  CUSTOM: "CUSTOM",
} as const;
export type MilestoneType = (typeof MilestoneType)[keyof typeof MilestoneType];

// `TicketCategory` used to be a fixed five-value enum copied here. Categories
// are guild-owned rows now, so the tickets page reads them from its view model
// rather than from a list baked into the browser bundle — which is the point:
// a guild that renames "Appeal" to "Ban appeal" sees its own word everywhere.

/**
 * What a member is allowed to do through the bridge. The panel offers this list
 * as an automod exemption: it is the guild-chat side's staff check, where there
 * are no Discord roles to exempt.
 */
export const BridgeCapability = {
  RELAY_MESSAGE: "RELAY_MESSAGE",
  RUN_COMMAND: "RUN_COMMAND",
  MENTION: "MENTION",
  TICKET_MANAGE: "TICKET_MANAGE",
  BYPASS_FILTER: "BYPASS_FILTER",
  BYPASS_COOLDOWN: "BYPASS_COOLDOWN",
  ADMIN: "ADMIN",
} as const;
export type BridgeCapability = (typeof BridgeCapability)[keyof typeof BridgeCapability];

/** How a wordlist rule's pattern is matched against a message. */
export const WordMatchType = {
  EXACT: "EXACT",
  SUBSTRING: "SUBSTRING",
  REGEX: "REGEX",
  WILDCARD: "WILDCARD",
} as const;
export type WordMatchType = (typeof WordMatchType)[keyof typeof WordMatchType];

/** What the relay does when a wordlist rule matches. */
export const WordAction = {
  BLOCK: "BLOCK",
  FLAG: "FLAG",
  REPLACE: "REPLACE",
  SHADOW_MUTE: "SHADOW_MUTE",
} as const;
export type WordAction = (typeof WordAction)[keyof typeof WordAction];

/** Where a canned reply's auto-pattern is allowed to fire. */
export const TagScope = {
  TICKET: "TICKET",
  SERVER: "SERVER",
  ANY: "ANY",
} as const;
export type TagScope = (typeof TagScope)[keyof typeof TagScope];

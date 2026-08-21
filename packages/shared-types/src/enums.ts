/**
 * Transport-level enums mirroring the domain model (DOMAIN_MODEL.md).
 * Declared as `const` objects so they exist at runtime AND as types.
 * These are kept in step with the Prisma enums in `@sbr/db`; Prisma remains the
 * schema source of truth, these are the wire/contract representation.
 */

export const MemberRole = {
  MEMBER: "MEMBER",
  MODERATOR: "MODERATOR",
  OFFICER: "OFFICER",
  ADMIN: "ADMIN",
  OWNER: "OWNER",
} as const;
export type MemberRole = (typeof MemberRole)[keyof typeof MemberRole];

const MEMBER_ROLE_RANK: Record<MemberRole, number> = {
  MEMBER: 0,
  MODERATOR: 1,
  OFFICER: 2,
  ADMIN: 3,
  OWNER: 4,
};

/**
 * Authority ordering for `MemberRole`.
 *
 * Lives in the contract layer because more than one service compares roles —
 * moderation for its rank-hierarchy guards, identity for capability floors — and
 * two copies of this order would eventually disagree about who outranks whom.
 *
 * Roles arrive from the database as strings, so an unrecognised value is floored
 * at MEMBER rather than producing NaN, which compares false against everything
 * and would silently grant nothing.
 */
export function rankOfRole(role: MemberRole): number {
  return MEMBER_ROLE_RANK[role] ?? 0;
}

export const MemberStatus = {
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
  LEFT: "LEFT",
  BANNED: "BANNED",
} as const;
export type MemberStatus = (typeof MemberStatus)[keyof typeof MemberStatus];

export const LinkStatus = {
  PENDING: "PENDING",
  VERIFIED: "VERIFIED",
  REJECTED: "REJECTED",
  UNLINKED: "UNLINKED",
} as const;
export type LinkStatus = (typeof LinkStatus)[keyof typeof LinkStatus];

export const SkyblockGameMode = {
  NORMAL: "NORMAL",
  IRONMAN: "IRONMAN",
  STRANDED: "STRANDED",
  BINGO: "BINGO",
} as const;
export type SkyblockGameMode = (typeof SkyblockGameMode)[keyof typeof SkyblockGameMode];

export const BridgeCapability = {
  RELAY_MESSAGE: "RELAY_MESSAGE",
  RUN_COMMAND: "RUN_COMMAND",
  MENTION: "MENTION",
  BYPASS_FILTER: "BYPASS_FILTER",
  BYPASS_COOLDOWN: "BYPASS_COOLDOWN",
  ADMIN: "ADMIN",
} as const;
export type BridgeCapability = (typeof BridgeCapability)[keyof typeof BridgeCapability];

export const InfractionType = {
  SPAM: "SPAM",
  PROFANITY: "PROFANITY",
  HARASSMENT: "HARASSMENT",
  ADVERTISING: "ADVERTISING",
  CHEATING: "CHEATING",
  RULE_BREAK: "RULE_BREAK",
  OTHER: "OTHER",
} as const;
export type InfractionType = (typeof InfractionType)[keyof typeof InfractionType];

export const InfractionSeverity = {
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
} as const;
export type InfractionSeverity = (typeof InfractionSeverity)[keyof typeof InfractionSeverity];

export const ModActionType = {
  WARN: "WARN",
  MUTE: "MUTE",
  UNMUTE: "UNMUTE",
  KICK: "KICK",
  BAN: "BAN",
  UNBAN: "UNBAN",
  NOTE: "NOTE",
  ROLE_CHANGE: "ROLE_CHANGE",
  GUILD_EXPEL: "GUILD_EXPEL",
} as const;
export type ModActionType = (typeof ModActionType)[keyof typeof ModActionType];

export const ApplicationStatus = {
  DRAFT: "DRAFT",
  SUBMITTED: "SUBMITTED",
  UNDER_REVIEW: "UNDER_REVIEW",
  ACCEPTED: "ACCEPTED",
  REJECTED: "REJECTED",
  WITHDRAWN: "WITHDRAWN",
} as const;
export type ApplicationStatus = (typeof ApplicationStatus)[keyof typeof ApplicationStatus];

export const EventStatus = {
  SCHEDULED: "SCHEDULED",
  LIVE: "LIVE",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
} as const;
export type EventStatus = (typeof EventStatus)[keyof typeof EventStatus];

export const RSVPState = {
  GOING: "GOING",
  MAYBE: "MAYBE",
  NOT_GOING: "NOT_GOING",
  WAITLIST: "WAITLIST",
} as const;
export type RSVPState = (typeof RSVPState)[keyof typeof RSVPState];

export const EventType = {
  DUNGEON: "DUNGEON",
  SLAYER: "SLAYER",
  FISHING: "FISHING",
  MINING: "MINING",
  GIVEAWAY: "GIVEAWAY",
  MEETING: "MEETING",
  CUSTOM: "CUSTOM",
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

export const LFGActivity = {
  DUNGEONS: "DUNGEONS",
  SLAYERS: "SLAYERS",
  KUUDRA: "KUUDRA",
  FISHING: "FISHING",
  MINING: "MINING",
  OTHER: "OTHER",
} as const;
export type LFGActivity = (typeof LFGActivity)[keyof typeof LFGActivity];

// `TicketCategory` was an enum here, with the five values a guild was stuck
// with. It is a model now — `TicketCategoryDTO` in `dtos.ts` — and those five
// are seeded as ordinary rows a guild can rename, reorder or delete. Nothing in
// code names them any more; `SEED_CATEGORIES` in `@sbr/tickets` is the only
// place the original wording survives, and only as a starting point.

export const TicketStatus = {
  OPEN: "OPEN",
  PENDING: "PENDING",
  RESOLVED: "RESOLVED",
  CLOSED: "CLOSED",
} as const;
export type TicketStatus = (typeof TicketStatus)[keyof typeof TicketStatus];

export const LFGStatus = {
  OPEN: "OPEN",
  FULL: "FULL",
  EXPIRED: "EXPIRED",
  CLOSED: "CLOSED",
} as const;
export type LFGStatus = (typeof LFGStatus)[keyof typeof LFGStatus];

/**
 * A perm is disbanded, never deleted: the roster is the only record of who ran
 * with whom, and it stays worth reading after the party stops running.
 */
export const PermStatus = {
  ACTIVE: "ACTIVE",
  DISBANDED: "DISBANDED",
} as const;
export type PermStatus = (typeof PermStatus)[keyof typeof PermStatus];

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

/**
 * The snapshot fields a milestone threshold can be measured against.
 *
 * Here rather than in `@sbr/jobs` beside the detector, because the panel has to
 * validate a metric arriving over HTTP and render one option per metric, and
 * the panel cannot import the workers' package. Two lists would drift into a
 * control that saves into a rejection.
 */
export const SNAPSHOT_MILESTONE_METRICS = [
  "skyblockLevel",
  "networth",
  "skillAverage",
  "catacombsLevel",
  "slayerXp",
  "senitherWeight",
  // Per-class dungeon levels. Catacombs alone says how much someone has run;
  // it says nothing about whether they can heal, and a guild recruiting for a
  // role wants the second answer. Levels rather than XP, because that is the
  // number the game shows and the number people quote at each other.
  "classHealer",
  "classMage",
  "classBerserk",
  "classArcher",
  "classTank",
  // Per-boss slayer XP. `slayerXp` is the sum, which hides the shape: 10m of
  // it spread over five bosses and 10m of it all Enderman are different
  // players, and only one of them can carry a Voidgloom lobby.
  "slayerZombie",
  "slayerSpider",
  "slayerWolf",
  "slayerEnderman",
  "slayerBlaze",
  "slayerVampire",
  // The last bestiary milestone Hypixel says the profile claimed. Read
  // straight off the profile rather than recomputed from kill counts: the
  // bracket tables move with every mob patch, and a number we derive wrongly
  // is worse than a number we simply repeat.
  "bestiaryMilestone",
] as const;
export type SnapshotMilestoneMetric = (typeof SNAPSHOT_MILESTONE_METRICS)[number];

/**
 * Metrics this platform measures itself, about a member of a specific guild.
 *
 * Kept apart from the snapshot list because they behave differently in one
 * important way: they are **not detected as crossings**. A Hypixel reading
 * needs two snapshots to know that a threshold was passed rather than always
 * having been true, which is why `detectMilestones` compares a pair. These
 * counters are ours, they only ever go up, and we can read the current value
 * at any time — so "attended 25 events" is simply true or not true, and
 * `buildAchievements` unlocks it from the reading with no stored row at all.
 *
 * The practical consequence: a community definition is recognised the moment
 * the number reaches it, retroactively, and it never announces. That is the
 * honest trade — the alternative is a detector that silently never fires.
 */
export const COMMUNITY_MILESTONE_METRICS = [
  "eventsAttended",
  "eventPodiums",
  "guildTenureDays",
  "guildXp",
] as const;
export type CommunityMilestoneMetric = (typeof COMMUNITY_MILESTONE_METRICS)[number];

export const MILESTONE_METRICS = [
  ...SNAPSHOT_MILESTONE_METRICS,
  ...COMMUNITY_MILESTONE_METRICS,
] as const;
export type MilestoneMetric = (typeof MILESTONE_METRICS)[number];

/** True for the metrics this platform counts itself — see the note above. */
export function isCommunityMetric(value: unknown): value is CommunityMilestoneMetric {
  return typeof value === "string" && (COMMUNITY_MILESTONE_METRICS as readonly string[]).includes(value);
}

/** Narrow an untrusted string — a panel body, a stored row — to a real metric. */
export function isMilestoneMetric(value: unknown): value is MilestoneMetric {
  return typeof value === "string" && (MILESTONE_METRICS as readonly string[]).includes(value);
}

/**
 * How much of a deal an achievement is, in the guild's own judgement.
 *
 * Editorial rather than arithmetic — Catacombs 50 outranks Catacombs 10 because
 * a guild says so, and two guilds of different sizes genuinely disagree about
 * where the line falls — which is why it is stored per definition rather than
 * computed from the threshold.
 */
export const ACHIEVEMENT_TIERS = ["BRONZE", "SILVER", "GOLD", "PLATINUM"] as const;
export type AchievementTier = (typeof ACHIEVEMENT_TIERS)[number];

export function isAchievementTier(value: unknown): value is AchievementTier {
  return typeof value === "string" && (ACHIEVEMENT_TIERS as readonly string[]).includes(value);
}

/** Ascending, so a sort can put the rarest last (or first, reversed). */
export function tierRank(tier: AchievementTier): number {
  return ACHIEVEMENT_TIERS.indexOf(tier);
}

/**
 * The families achievements are grouped under.
 *
 * Deliberately **not** a stored column. A category follows from the metric —
 * a networth threshold is a wealth achievement whatever anyone types — and a
 * column beside the metric it describes is a row that can contradict itself.
 * Adding a family therefore means adding a metric, which is the honest cost.
 */
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

const CATEGORY_OF_METRIC: Readonly<Record<MilestoneMetric, AchievementCategory>> = {
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
 * What a metric is called on screen, and how its value reads.
 *
 * Here beside the metric list for the same reason the list is here: the panel
 * renders one option per metric and cannot import the workers' package, and a
 * second table of labels somewhere else is a table that goes stale the first
 * time a metric is added.
 */
export const METRIC_LABELS: Readonly<Record<MilestoneMetric, string>> = {
  skyblockLevel: "SkyBlock Level",
  networth: "Networth",
  skillAverage: "Skill average",
  catacombsLevel: "Catacombs level",
  slayerXp: "Slayer XP (total)",
  senitherWeight: "Senither weight",
  classHealer: "Healer level",
  classMage: "Mage level",
  classBerserk: "Berserk level",
  classArcher: "Archer level",
  classTank: "Tank level",
  slayerZombie: "Revenant XP",
  slayerSpider: "Tarantula XP",
  slayerWolf: "Sven XP",
  slayerEnderman: "Voidgloom XP",
  slayerBlaze: "Inferno XP",
  slayerVampire: "Riftstalker XP",
  bestiaryMilestone: "Bestiary milestone",
  eventsAttended: "Events attended",
  eventPodiums: "Event podiums",
  guildTenureDays: "Days in the guild",
  guildXp: "Guild XP",
};

/**
 * The family a metric belongs to. An unknown metric — a stored row from a
 * newer deployment, a hand-written definition — lands in PROGRESSION rather
 * than throwing: an achievement in the wrong group is a presentation problem,
 * and a member's `/milestones` failing to render is not.
 */
export function categoryOfMetric(metric: string): AchievementCategory {
  return CATEGORY_OF_METRIC[metric as MilestoneMetric] ?? "PROGRESSION";
}

export const CommandSurface = {
  BRIDGE_BOT: "BRIDGE_BOT",
  ADMIN_BOT: "ADMIN_BOT",
  WEB_PANEL: "WEB_PANEL",
  INGAME: "INGAME",
} as const;
export type CommandSurface = (typeof CommandSurface)[keyof typeof CommandSurface];

export const JobStatus = {
  QUEUED: "QUEUED",
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  RETRYING: "RETRYING",
  CANCELLED: "CANCELLED",
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

/** How a wordlist rule is matched against a message (`/wordlist-add match_type:`). */
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

/** How aggressively `/antiraid-on` gates joins and caps message rates. */
export const RaidSensitivity = {
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
} as const;
export type RaidSensitivity = (typeof RaidSensitivity)[keyof typeof RaidSensitivity];

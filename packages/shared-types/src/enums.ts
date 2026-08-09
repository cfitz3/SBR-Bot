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

export const TicketCategory = {
  SUPPORT: "SUPPORT",
  REPORT: "REPORT",
  APPEAL: "APPEAL",
  APPLICATION: "APPLICATION",
  OTHER: "OTHER",
} as const;
export type TicketCategory = (typeof TicketCategory)[keyof typeof TicketCategory];

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
  SKILL_LEVEL: "SKILL_LEVEL",
  CATACOMBS_LEVEL: "CATACOMBS_LEVEL",
  SLAYER_TIER: "SLAYER_TIER",
  NETWORTH_THRESHOLD: "NETWORTH_THRESHOLD",
  COLLECTION: "COLLECTION",
  CUSTOM: "CUSTOM",
} as const;
export type MilestoneType = (typeof MilestoneType)[keyof typeof MilestoneType];

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

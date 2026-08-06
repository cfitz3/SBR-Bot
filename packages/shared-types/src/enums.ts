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

export const LFGStatus = {
  OPEN: "OPEN",
  FULL: "FULL",
  EXPIRED: "EXPIRED",
  CLOSED: "CLOSED",
} as const;
export type LFGStatus = (typeof LFGStatus)[keyof typeof LFGStatus];

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

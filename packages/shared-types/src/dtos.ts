/**
 * Data transfer objects exchanged across service boundaries. Representative set
 * for the scaffold — expanded as features land. Fields that may be unknown are
 * `T | null` (never silently 0), per HYPIXEL_DATA_LAYER.md.
 */
import type {
  ApplicationStatus,
  CommandSurface,
  EventStatus,
  InfractionSeverity,
  InfractionType,
  LinkStatus,
  MemberRole,
  MemberStatus,
  MilestoneType,
  ModActionType,
  SkyblockGameMode,
} from "./enums.js";

/** A resolved Discord ↔ Minecraft link. */
export interface LinkedIdentityDTO {
  readonly discordId: string;
  readonly minecraftUuid: string;
  readonly ign: string;
  readonly status: LinkStatus;
  readonly primary: boolean;
  readonly verifiedAt: string | null;
}

export interface MemberSummaryDTO {
  readonly guildId: string;
  readonly discordId: string;
  readonly ign: string | null;
  readonly role: MemberRole;
  readonly status: MemberStatus;
  readonly guildRank: string | null;
  readonly joinedAt: string | null;
}

/** Selected Skyblock profile summary. */
export interface ProfileSummaryDTO {
  readonly profileId: string;
  readonly cuteName: string | null;
  readonly gameMode: SkyblockGameMode;
  readonly skillAverage: number | null;
  readonly catacombsLevel: number | null;
  readonly senitherWeight: number | null;
}

/**
 * Networth breakdown. `exact` is true ONLY when every value-bearing section was
 * readable; otherwise `total` is a lower-bound estimate and `missing` lists the
 * hidden sections (partial networth is never presented as exact).
 */
export interface NetworthDTO {
  readonly total: number | null;
  readonly exact: boolean;
  readonly missing: readonly string[];
  readonly breakdown: Readonly<Record<string, number>>;
}

export interface PriceDTO {
  readonly itemId: string;
  readonly bazaarInstantSell: number | null;
  readonly bazaarInstantBuy: number | null;
  readonly lowestBin: number | null;
  readonly estimatedValue: number | null;
}

export interface InfractionDTO {
  readonly id: string;
  readonly guildId: string;
  readonly targetDiscordId: string | null;
  readonly type: InfractionType;
  readonly severity: InfractionSeverity;
  readonly reason: string;
  readonly createdAt: string;
}

/** Surfaces a moderation action swept across (cross-surface /mute). */
export type ModerationSurface = "DISCORD" | "GUILD_CHAT";

export interface ModerationActionDTO {
  readonly id: string;
  readonly guildId: string;
  readonly type: ModActionType;
  readonly actorDiscordId: string;
  readonly targetDiscordId: string | null;
  readonly reason: string;
  readonly durationSeconds: number | null;
  readonly expiresAt: string | null;
  readonly surfaces: readonly ModerationSurface[];
  readonly active: boolean;
  readonly createdAt: string;
}

export interface ApplicationDTO {
  readonly id: string;
  readonly guildId: string;
  readonly applicantDiscordId: string;
  readonly status: ApplicationStatus;
  readonly submittedAt: string | null;
}

export interface EventDTO {
  readonly id: string;
  readonly guildId: string;
  readonly title: string;
  readonly status: EventStatus;
  readonly startsAt: string;
  readonly capacity: number | null;
  readonly rsvpCount: number;
}

export interface MilestoneDTO {
  readonly id: string;
  readonly minecraftUuid: string;
  readonly type: MilestoneType;
  readonly metric: string;
  readonly thresholdValue: number;
  readonly achievedAt: string;
}

export interface CommandUsageDTO {
  readonly guildId: string | null;
  readonly discordId: string | null;
  readonly surface: CommandSurface;
  readonly command: string;
  readonly success: boolean;
  readonly latencyMs: number;
  readonly invokedAt: string;
}

/** Health probe result surfaced by the panel Health page (WEB_PANEL.md §3.11). */
export interface HealthReportDTO {
  readonly status: "ok" | "degraded" | "down";
  readonly checkedAt: string;
  readonly components: readonly ComponentHealthDTO[];
}

export interface ComponentHealthDTO {
  readonly name: string;
  readonly status: "ok" | "degraded" | "down";
  readonly latencyMs: number | null;
  readonly detail?: string;
}

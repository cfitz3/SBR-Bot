/**
 * Typed service contracts. Apps depend on these interfaces, not on package
 * internals (ARCHITECTURE.md: "modules expose typed service interfaces + DTOs").
 * Signatures only — no implementations live here.
 */
import type { HypixelResult, Result } from "./common.js";
import type { BridgeCapability, CommandSurface, ModActionType } from "./enums.js";
import type {
  ApplicationDTO,
  CommandUsageDTO,
  EventDTO,
  HealthReportDTO,
  InfractionDTO,
  LinkedIdentityDTO,
  MemberSummaryDTO,
  ModerationActionDTO,
  NetworthDTO,
  PriceDTO,
  ProfileSummaryDTO,
} from "./dtos.js";

/** Account linking + permission resolution (packages/identity). */
export interface IdentityService {
  resolveByDiscordId(discordId: string): Promise<Result<LinkedIdentityDTO | null>>;
  /** Verify via Hypixel social Discord field matching the caller's id (COMMANDS.md /link). */
  linkByIgn(discordId: string, ign: string): Promise<Result<LinkedIdentityDTO, LinkError>>;
  unlink(discordId: string, minecraftUuid: string): Promise<Result<void>>;
  hasCapability(
    guildId: string,
    discordId: string,
    capability: BridgeCapability,
  ): Promise<boolean>;
}

export type LinkError =
  | { readonly kind: "IGN_NOT_FOUND" }
  | { readonly kind: "SOCIAL_UNSET" }
  | { readonly kind: "SOCIAL_MISMATCH" }
  | { readonly kind: "ALREADY_OWNED"; readonly byDiscordId: string };

/**
 * Port: read the Hypixel in-game social Discord field for an IGN.
 * Implemented by the Hypixel client (step 2); `discordId: null` means the player
 * has not set the Discord social link in-game, so `/link` must be rejected.
 */
export interface HypixelSocialLookup {
  getLinkedDiscord(ign: string): Promise<HypixelSocialResult>;
}

export type HypixelSocialResult =
  | { readonly kind: "FOUND"; readonly uuid: string; readonly ign: string; readonly discordId: string | null }
  | { readonly kind: "IGN_NOT_FOUND" };

/**
 * Port: identity persistence. Implemented by `@sbr/db` (identityRepository) and
 * consumed by the IdentityService. Kept in the contract layer so neither side
 * depends on the other.
 */
export interface IdentityRepository {
  findPrimaryLinkByDiscordId(discordId: string): Promise<LinkedIdentityDTO | null>;
  /** discordId of the verified owner of a Minecraft account, or null if unowned. */
  findMinecraftOwnerDiscordId(uuid: string): Promise<string | null>;
  createVerifiedLink(input: {
    readonly discordId: string;
    readonly uuid: string;
    readonly ign: string;
  }): Promise<LinkedIdentityDTO>;
  unlink(discordId: string, uuid: string): Promise<boolean>;
  getUserCapabilities(guildId: string, discordId: string): Promise<readonly BridgeCapability[]>;
}

/** Hypixel-backed stats & progression (packages/progression). */
export interface ProgressionService {
  getProfileSummary(uuid: string, profileId?: string): Promise<HypixelResult<ProfileSummaryDTO>>;
  getNetworth(uuid: string, profileId?: string): Promise<HypixelResult<NetworthDTO>>;
}

/** Item valuation (packages/pricing). Reads worker-populated caches. */
export interface PricingService {
  getPrice(itemId: string): Promise<HypixelResult<PriceDTO>>;
}

/** Input to apply a moderation action; the service computes expiry/active/surfaces. */
export interface ApplyActionInput {
  readonly guildId: string;
  readonly type: ModActionType;
  readonly actorDiscordId: string;
  readonly targetDiscordId: string | null;
  readonly targetMinecraftUuid?: string | null;
  readonly reason: string;
  readonly durationSeconds?: number | null;
  readonly infractionId?: string | null;
}

/** Moderation + audit (packages/moderation). Shared by admin-bot and web-panel. */
export interface ModerationService {
  recordInfraction(
    input: Omit<InfractionDTO, "id" | "createdAt">,
  ): Promise<Result<InfractionDTO>>;
  applyAction(input: ApplyActionInput): Promise<Result<ModerationActionDTO, ModerationError>>;
  listInfractions(guildId: string, discordId: string): Promise<Result<readonly InfractionDTO[]>>;
}

export type ModerationError =
  | { readonly kind: "TARGET_OUTRANKS_ACTOR" }
  | { readonly kind: "SELF_TARGET" }
  | { readonly kind: "BOT_MISSING_PERMISSION" }
  | { readonly kind: "DURATION_REQUIRED" };

/** Guild config / feature flags (packages/config domain service). */
export interface GuildConfigService {
  get(guildId: string): Promise<Result<GuildRuntimeConfig | null>>;
  isFeatureEnabled(guildId: string, feature: string): Promise<boolean>;
}

export interface GuildRuntimeConfig {
  readonly guildId: string;
  readonly bridgeChannelId: string | null;
  readonly staffChannelId: string | null;
  readonly bridgeSuspended: boolean;
  readonly features: Readonly<Record<string, boolean>>;
}

/** Community events + membership (packages/community). */
export interface CommunityService {
  listUpcomingEvents(guildId: string): Promise<Result<readonly EventDTO[]>>;
  listMembers(guildId: string): Promise<Result<readonly MemberSummaryDTO[]>>;
  listApplications(guildId: string): Promise<Result<readonly ApplicationDTO[]>>;
}

/** Analytics capture + reporting (packages/analytics). */
export interface AnalyticsService {
  capture(usage: CommandUsageDTO): Promise<void>;
  emit(event: AnalyticsEvent): Promise<void>;
}

export interface AnalyticsEvent {
  readonly type: string;
  readonly guildId: string | null;
  readonly surface: CommandSurface | "SYSTEM";
  readonly ts: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly correlationId?: string;
}

/** A single health probe. Composed by the observability health registry. */
export interface HealthCheck {
  readonly name: string;
  check(): Promise<{ status: "ok" | "degraded" | "down"; latencyMs: number | null; detail?: string }>;
}

export interface HealthAggregator {
  register(check: HealthCheck): void;
  run(): Promise<HealthReportDTO>;
}

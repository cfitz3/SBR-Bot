/**
 * Typed service contracts. Apps depend on these interfaces, not on package
 * internals (ARCHITECTURE.md: "modules expose typed service interfaces + DTOs").
 * Signatures only — no implementations live here.
 */
import type { HypixelResult, Result } from "./common.js";
import type {
  ApplicationStatus,
  BridgeCapability,
  CommandSurface,
  EventType,
  LFGActivity,
  MemberRole,
  ModActionType,
  RaidSensitivity,
  RSVPState,
  TicketCategory,
  WordAction,
  WordMatchType,
} from "./enums.js";
import type {
  AccessoryReportDTO,
  AdviceDTO,
  AntiRaidStateDTO,
  ApplicationDTO,
  AttendanceDTO,
  AuctionsDTO,
  BazaarQuoteDTO,
  CommandUsageDTO,
  DungeonsDTO,
  EventDTO,
  FilterTestDTO,
  GuildRosterDTO,
  HealthReportDTO,
  InfractionDTO,
  ItemMatchDTO,
  LFGPostDTO,
  LinkedIdentityDTO,
  LockdownStateDTO,
  LowestBinDTO,
  MemberSummaryDTO,
  MilestoneDTO,
  ModerationActionDTO,
  NetworthDTO,
  ProgressMetric,
  ProgressSeriesDTO,
  PriceDTO,
  ProfileSummaryDTO,
  SafetyStatusDTO,
  SkillsDTO,
  SlayersDTO,
  TicketDTO,
  WordlistRuleDTO,
} from "./dtos.js";

/** Account linking + permission resolution (packages/identity). */
export interface IdentityService {
  resolveByDiscordId(discordId: string): Promise<Result<LinkedIdentityDTO | null>>;
  /** Verify via the Hypixel social Discord field matching the caller (COMMANDS.md /link). */
  linkByIgn(actor: LinkActor, ign: string): Promise<Result<LinkedIdentityDTO, LinkError>>;
  unlink(discordId: string, minecraftUuid: string): Promise<Result<void>>;
  hasCapability(
    guildId: string,
    discordId: string,
    capability: BridgeCapability,
  ): Promise<boolean>;
}

/**
 * Who is asking to link.
 *
 * The username is here because Hypixel's social field stores a *Discord
 * username*, not a snowflake — verified against the live API: modern handles
 * come back as `"refraction"`, legacy ones as `"boblovespi#9817"`. A caller that
 * can't supply one (the in-game surface knows only an IGN) passes `undefined`
 * and can then only match a player who wrote their raw id into the field.
 */
export interface LinkActor {
  readonly discordId: string;
  readonly username?: string | undefined;
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
  /**
   * discordId behind an IGN. The in-game surface only ever knows the name that
   * spoke, and resolving it through Mojang first would put a network round-trip
   * in front of every `!` command.
   */
  findDiscordIdByIgn(ign: string): Promise<string | null>;
  createVerifiedLink(input: {
    readonly discordId: string;
    readonly uuid: string;
    readonly ign: string;
  }): Promise<LinkedIdentityDTO>;
  unlink(discordId: string, uuid: string): Promise<boolean>;
  /**
   * Every capability row recorded for this user in this guild, grants and denies
   * alike. Denies are returned rather than filtered out because taking a
   * capability away from someone who holds it by role is the only thing a deny
   * row can express, and a repository that drops them makes it a silent no-op.
   */
  getCapabilityGrants(guildId: string, discordId: string): Promise<readonly CapabilityGrant[]>;
}

export interface CapabilityGrant {
  readonly capability: BridgeCapability;
  readonly allow: boolean;
}

/**
 * Port: a member's platform role in a guild (`GuildMember.role`).
 *
 * Separate from `IdentityRepository` so the identity service can read a role
 * without owning the membership table, and so the panel's existing resolver
 * satisfies it as-is.
 */
export interface MemberRoleReader {
  getRole(guildId: string, discordId: string): Promise<MemberRole>;
}

/** Hypixel-backed stats & progression (packages/progression). */
export interface ProgressionService {
  getProfileSummary(uuid: string, profileId?: string): Promise<HypixelResult<ProfileSummaryDTO>>;
  getNetworth(uuid: string, profileId?: string): Promise<HypixelResult<NetworthDTO>>;
  getSkills(uuid: string, profileId?: string): Promise<HypixelResult<SkillsDTO>>;
  getSlayers(uuid: string, profileId?: string): Promise<HypixelResult<SlayersDTO>>;
  getDungeons(uuid: string, profileId?: string): Promise<HypixelResult<DungeonsDTO>>;
  /** Every profile on the account, for `/profile` and `/setprofile` autocomplete. */
  listProfiles(uuid: string): Promise<HypixelResult<readonly ProfileSummaryDTO[]>>;
  /**
   * Milestones and progress read our own snapshot history, not Hypixel — so they
   * return a plain Result. They are empty rather than failing for a member the
   * snapshot worker has not covered yet.
   */
  getMilestones(uuid: string, limit?: number): Promise<Result<readonly MilestoneDTO[]>>;
  getProgress(uuid: string, metric: ProgressMetric, rangeDays: number): Promise<Result<ProgressSeriesDTO>>;
  /** `/setprofile` — remember which profile a member's lookups default to. */
  setSelectedProfile(uuid: string, profileId: string): Promise<Result<ProfileSummaryDTO, SelectProfileError>>;

  /**
   * `/missing` — accessory standing, read from the talisman bag. Succeeds with
   * `apiDisabled: true` when the bag is hidden rather than failing: "we can't
   * see your bag" is a useful answer, and the command still reports the
   * member's tuning.
   */
  getAccessories(uuid: string, profileId?: string): Promise<HypixelResult<AccessoryReportDTO>>;

  /**
   * `/nextupgrade` — ranked upgrades for one focus, with lowest-BIN costs where
   * the suggestion names a purchasable item.
   */
  getUpgradeAdvice(uuid: string, focus: string, profileId?: string): Promise<HypixelResult<AdviceDTO>>;

  /**
   * `/whatnext` — broad progression advice across skills, dungeons and slayers.
   * Degrades to generic advice (`generic: true`) rather than failing when the
   * profile is unreadable, per COMMANDS.md's degradation column.
   */
  getNextSteps(uuid: string, goal: string, profileId?: string): Promise<HypixelResult<AdviceDTO>>;
}

export type SelectProfileError =
  | { readonly kind: "NO_SUCH_PROFILE" }
  | { readonly kind: "UNAVAILABLE" };

/**
 * Port: snapshot history and profile-selection persistence, implemented by
 * `@sbr/db`. Lives in the contract layer so progression never imports the
 * database package.
 */
export interface ProgressionRepository {
  listMilestones(minecraftUuid: string, limit: number): Promise<readonly MilestoneDTO[]>;
  listSnapshots(
    minecraftUuid: string,
    since: Date,
  ): Promise<readonly {
    readonly captureDate: string;
    readonly networth: number | null;
    readonly skillAverage: number | null;
    readonly catacombsLevel: number | null;
    readonly senitherWeight: number | null;
  }[]>;
  /** The member's `/setprofile` choice, or null to follow their in-game selection. */
  getSelectedProfileId(minecraftUuid: string): Promise<string | null>;
  setSelectedProfile(minecraftUuid: string, profile: ProfileSummaryDTO): Promise<void>;
}

/** Port: IGN → uuid, so a lookup command can name a player it has no link for. */
export interface PlayerLookup {
  resolveIgn(ign: string): Promise<{ readonly uuid: string; readonly ign: string } | null>;
}

/** Item valuation (packages/pricing). Reads worker-populated caches. */
export interface PricingService {
  getPrice(itemId: string): Promise<HypixelResult<PriceDTO>>;
}

/**
 * Market reads for `/bazaar`, `/lowestbin` and `/auctions` (packages/pricing).
 *
 * Split from PricingService because the two answer different questions: pricing
 * gives one blended value for valuation, market gives the raw order book and
 * listings a trader asked to see.
 */
export interface MarketService {
  getBazaarQuote(itemId: string): Promise<HypixelResult<BazaarQuoteDTO>>;
  getLowestBin(itemId: string): Promise<HypixelResult<LowestBinDTO>>;
  /** A player's own active auctions — one cheap upstream call. */
  getPlayerAuctions(uuid: string): Promise<HypixelResult<AuctionsDTO>>;
  /**
   * Active listings for an item. Served from the sweep cache only: paginating
   * the whole auction house inside a command is forbidden
   * (HYPIXEL_DATA_LAYER.md), so this is empty until the sweep job has run.
   */
  getItemAuctions(itemId: string): Promise<HypixelResult<AuctionsDTO>>;
  /** Autocomplete over the item catalog. Empty rather than failing when cold. */
  searchItems(query: string, limit?: number): Promise<readonly ItemMatchDTO[]>;
  /** A typed name or id → the canonical item id, or null if nothing matches. */
  resolveItemId(query: string): Promise<string | null>;
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
  /** `/audit` — the moderation log, filtered and newest-first. */
  listActions(query: AuditQuery): Promise<Result<readonly ModerationActionDTO[]>>;
}

/**
 * Filters for `/audit`. Every field beyond `guildId` narrows the search; all
 * omitted means "everything recent", which is what an officer opening the log
 * with no arguments is asking for.
 */
export interface AuditQuery {
  readonly guildId: string;
  readonly actorDiscordId?: string | null;
  readonly targetDiscordId?: string | null;
  readonly type?: ModActionType | null;
  /** Look back this many days; omitted means no lower bound. */
  readonly sinceDays?: number | null;
  readonly limit?: number;
}

export type ModerationError =
  | { readonly kind: "TARGET_OUTRANKS_ACTOR" }
  | { readonly kind: "SELF_TARGET" }
  | { readonly kind: "BOT_MISSING_PERMISSION" }
  | { readonly kind: "DURATION_REQUIRED" };

/** Guild config / feature flags (packages/guild-config domain service). */
export interface GuildConfigService {
  get(guildId: string): Promise<Result<GuildRuntimeConfig | null>>;
  isFeatureEnabled(guildId: string, feature: string): Promise<boolean>;
  /**
   * The channel bound to a slot, or null when the guild has not set one. Goes
   * through the same cached read as `get`, so a hot path (the bridge asking
   * where to relay) costs no query.
   */
  getChannel(guildId: string, slot: ConfigChannelSlot): Promise<string | null>;
  /** `/set-channel` — assign one of the platform's well-known channels. */
  setChannel(guildId: string, slot: ConfigChannelSlot, channelId: string | null): Promise<Result<void>>;
  /** `/feature-toggle` — flip a named flag without disturbing the others. */
  setFeature(guildId: string, feature: string, enabled: boolean): Promise<Result<void>>;
  /** `/bridge-suspend` — stop relaying without taking the bot offline. */
  setBridgeSuspended(guildId: string, suspended: boolean): Promise<Result<void>>;
  /** `/set-recruitment` — open or close applications and set the entry bar. */
  setRecruitment(guildId: string, input: RecruitmentSettings): Promise<Result<void>>;
  /**
   * Admin config that isn't worth a column — embed templates, dropdown layouts,
   * per-feature payloads. Callers own the shape and validate what comes back;
   * an unreadable or absent setting is null, so a caller falls back to its
   * platform default instead of failing.
   */
  getSetting<T>(guildId: string, key: string): Promise<T | null>;
  setSetting(guildId: string, key: string, value: unknown): Promise<Result<void>>;
  /** `/set-role type:mapping` — bind a platform role to a Discord role id. */
  setRoleMapping(guildId: string, role: MemberRole, discordRoleId: string | null): Promise<Result<void>>;
}

/**
 * `/set-recruitment` input. The thresholds are tri-state on purpose: omitted
 * leaves the current bar alone, `null` clears it, a number sets it. Collapsing
 * "unspecified" and "no requirement" would silently wipe a guild's entry bar
 * every time someone toggled applications open.
 */
export interface RecruitmentSettings {
  readonly open: boolean;
  readonly minWeight?: number | null;
  readonly minNetworth?: number | null;
}

/**
 * The channels the platform knows how to use, as `/set-channel` and the panel
 * name them.
 *
 * A runtime array rather than only a type, because the panel has to validate a
 * slot name arriving over HTTP and render one control per slot — deriving both
 * from this list is what keeps "slots the API accepts" and "slots the UI offers"
 * from drifting apart, which is how a control ends up saving into nothing.
 *
 * The first five are backed by legacy columns on GuildConfig and are mirrored on
 * write until those columns are dropped; the rest live only as bindings.
 */
export const CONFIG_CHANNEL_SLOTS = [
  "bridge",
  "staff",
  "log",
  "applications",
  "events",
  "lfg",
  "tickets",
  "milestones",
  "leaderboard",
  "modlog",
] as const;

export type ConfigChannelSlot = (typeof CONFIG_CHANNEL_SLOTS)[number];

/** Narrow an untrusted string (a panel body, a command option) to a known slot. */
export function isConfigChannelSlot(value: unknown): value is ConfigChannelSlot {
  return typeof value === "string" && (CONFIG_CHANNEL_SLOTS as readonly string[]).includes(value);
}

/** Human labels for the slots, for panel controls and command replies. */
export const CONFIG_CHANNEL_SLOT_LABELS: Readonly<Record<ConfigChannelSlot, string>> = {
  bridge: "Guild bridge",
  staff: "Staff",
  log: "Bot log",
  applications: "Applications",
  events: "Events",
  lfg: "Looking for group",
  tickets: "Ticket panel",
  milestones: "Milestone announcements",
  leaderboard: "Leaderboards",
  modlog: "Moderation log",
};

export interface GuildRuntimeConfig {
  readonly guildId: string;
  /**
   * Every configured channel, keyed by slot. The canonical source: a slot with
   * no binding is absent, and the five legacy `*ChannelId` fields below are a
   * compatibility view over the same data for call sites not yet migrated.
   */
  readonly channels: Readonly<Partial<Record<ConfigChannelSlot, string>>>;
  readonly bridgeChannelId: string | null;
  readonly staffChannelId: string | null;
  readonly logChannelId: string | null;
  readonly applicationsChannelId: string | null;
  readonly eventsChannelId: string | null;
  readonly prefixes: readonly string[];
  readonly timezone: string;
  readonly applicationsOpen: boolean;
  readonly bridgeSuspended: boolean;
  readonly features: Readonly<Record<string, boolean>>;
  /** Recruitment bar; null means the guild sets no requirement on that axis. */
  readonly minWeight: number | null;
  readonly minNetworth: number | null;
  /** Platform role → Discord role id, as `/set-role type:mapping` records it. */
  readonly roleMappings: Readonly<Record<string, string>>;
}

/**
 * Live guild presence, answered by the in-game bridge.
 *
 * A port rather than a service because the only implementation is a Mineflayer
 * session asking Hypixel a question in chat — a command handler must not know
 * that, and must keep working when the bridge is down. `null` is that case:
 * "nobody can answer right now", which handlers report honestly instead of
 * presenting an empty roster as though the guild were deserted.
 */
export interface GuildRosterSource {
  online(): Promise<GuildRosterDTO | null>;
}

/** Community events + membership (packages/community). */
export interface CommunityService {
  listUpcomingEvents(guildId: string): Promise<Result<readonly EventDTO[]>>;
  listMembers(guildId: string): Promise<Result<readonly MemberSummaryDTO[]>>;
  listApplications(guildId: string): Promise<Result<readonly ApplicationDTO[]>>;
  /** `/set-role type:member` — change a member's platform role. */
  setMemberRole(guildId: string, discordId: string, role: MemberRole): Promise<Result<MemberSummaryDTO>>;

  // ── Events (`/create-event`, `/events`, `/rsvp`, `/attendance`) ──
  createEvent(input: NewEvent): Promise<Result<EventDTO, EventError>>;
  getEvent(eventId: string): Promise<Result<EventDTO | null>>;
  cancelEvent(eventId: string, actorDiscordId: string): Promise<Result<EventDTO, EventError>>;
  /** Records a response, downgrading GOING to WAITLIST when the event is full. */
  rsvp(eventId: string, discordId: string, state: RSVPState): Promise<Result<RsvpOutcome, EventError>>;
  getAttendance(eventId: string): Promise<Result<AttendanceDTO, EventError>>;

  // ── Looking for group (`/lfg`, `/runs`, `/joinrun`, `/leaverun`) ──
  createLfg(input: NewLfgPost): Promise<Result<LFGPostDTO, LfgError>>;
  listLfg(guildId: string, activity?: LFGActivity): Promise<Result<readonly LFGPostDTO[]>>;
  joinLfg(postId: string, discordId: string): Promise<Result<LFGPostDTO, LfgError>>;
  leaveLfg(postId: string, discordId: string): Promise<Result<LFGPostDTO, LfgError>>;

  // ── Tickets (`/ticket`) ──
  openTicket(input: NewTicket): Promise<Result<TicketDTO>>;
  closeTicket(ticketId: string, actorDiscordId: string, reason: string | null): Promise<Result<TicketDTO, TicketError>>;
  listTickets(guildId: string, openerDiscordId?: string): Promise<Result<readonly TicketDTO[]>>;

  // ── Applications (`/application-review`, `/accept-member`, `/deny-member`) ──
  getApplication(applicationId: string): Promise<Result<ApplicationDTO | null>>;
  /** Accept or reject; the reviewer and reason are recorded for the audit trail. */
  decideApplication(input: ApplicationDecision): Promise<Result<ApplicationDTO, ApplicationError>>;
}

export interface NewEvent {
  readonly guildId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly type: EventType;
  readonly hostDiscordId: string;
  readonly description?: string | null;
  readonly capacity?: number | null;
  readonly tracksProgression?: boolean;
}

/**
 * What the RSVP was actually recorded as, which is not always what was asked
 * for: `waitlisted` is true when a GOING response hit a full event, so the reply
 * can say so instead of implying a seat.
 */
export interface RsvpOutcome {
  readonly state: RSVPState;
  readonly waitlisted: boolean;
  readonly event: EventDTO;
}

export type EventError =
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "CLOSED" }
  | { readonly kind: "NOT_HOST" }
  | { readonly kind: "INVALID_TIME"; readonly detail: string };

export interface NewLfgPost {
  readonly guildId: string;
  readonly authorDiscordId: string;
  readonly activity: LFGActivity;
  readonly details?: string | null;
  readonly slotsTotal: number;
  readonly expiresInMinutes?: number;
}

export type LfgError =
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "FULL" }
  | { readonly kind: "CLOSED" }
  | { readonly kind: "ALREADY_JOINED" }
  | { readonly kind: "NOT_A_MEMBER" }
  | { readonly kind: "AUTHOR_CANNOT_LEAVE" }
  | { readonly kind: "INVALID_SLOTS"; readonly detail: string };

export interface NewTicket {
  readonly guildId: string;
  readonly openerDiscordId: string;
  readonly category: TicketCategory;
  readonly subject?: string | null;
  readonly channelId?: string | null;
}

export type TicketError = { readonly kind: "NOT_FOUND" } | { readonly kind: "ALREADY_CLOSED" };

export interface ApplicationDecision {
  readonly applicationId: string;
  readonly reviewerDiscordId: string;
  readonly accept: boolean;
  readonly reason?: string | null;
}

export type ApplicationError =
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "ALREADY_DECIDED"; readonly status: ApplicationStatus };

/**
 * Chat-filter administration (`/wordlist-add`, `/wordlist-remove`,
 * `/filter-test`). The same compiled matchers back the bridge relay, so a rule
 * a staffer tests here behaves identically to a rule that fires in production.
 */
export interface WordlistService {
  list(guildId: string): Promise<Result<readonly WordlistRuleDTO[]>>;
  add(input: NewWordlistRule): Promise<Result<WordlistRuleDTO, WordlistError>>;
  /** Removes by rule id or by exact pattern; null when nothing matched. */
  remove(guildId: string, ref: string): Promise<Result<WordlistRuleDTO | null>>;
  test(guildId: string, text: string): Promise<Result<FilterTestDTO>>;
}

export interface NewWordlistRule {
  readonly guildId: string;
  readonly pattern: string;
  readonly matchType: WordMatchType;
  readonly action: WordAction;
  readonly severity?: number;
  readonly addedByDiscordId: string;
  readonly note?: string | null;
}

export type WordlistError =
  | { readonly kind: "INVALID_PATTERN"; readonly detail: string }
  | { readonly kind: "DUPLICATE" };

/**
 * Server-safety postures: `/lockdown` and `/antiraid-*`.
 *
 * Every posture is time-boxed and expires on its own (ADMIN_BOT.md §6) so a
 * forgotten toggle cannot silently strangle a server. Expiry is decided by the
 * `expiresAt` inside the record, not by letting the stored key evaporate: the
 * record is what remembers which channels to reopen, so it has to outlive the
 * posture. A worker sweeps elapsed postures and performs the actual unlock.
 */
export interface SafetyService {
  lockdown(input: LockdownInput): Promise<Result<LockdownStateDTO, SafetyError>>;
  /** Ends a lockdown early; null when nothing was locked. */
  liftLockdown(guildId: string): Promise<Result<LockdownStateDTO | null>>;
  enableAntiRaid(input: AntiRaidInput): Promise<Result<AntiRaidStateDTO, SafetyError>>;
  disableAntiRaid(guildId: string): Promise<Result<AntiRaidStateDTO, SafetyError>>;
  status(guildId: string): Promise<Result<SafetyStatusDTO>>;
}

export interface LockdownInput {
  readonly guildId: string;
  readonly actorDiscordId: string;
  readonly scope: "CHANNEL" | "SERVER";
  /** Required for CHANNEL scope; ignored for SERVER. */
  readonly channelId?: string | null;
  readonly reason: string;
  readonly durationSeconds?: number | null;
}

export interface AntiRaidInput {
  readonly guildId: string;
  readonly actorDiscordId: string;
  readonly sensitivity: RaidSensitivity;
  readonly durationSeconds?: number | null;
}

export type SafetyError =
  | { readonly kind: "ALREADY_ACTIVE"; readonly until: string | null }
  | { readonly kind: "NOT_ACTIVE" }
  | { readonly kind: "CHANNEL_REQUIRED" }
  | { readonly kind: "DISCORD_FAILED"; readonly detail: string };

/**
 * Port: the Discord-side effects staff commands need. The command layer stays
 * transport-agnostic, so `/kick`, `/purge` and `/lockdown` reach Discord only
 * through this — implemented over discord.js in `apps/admin-bot`.
 */
export interface GuildEffects {
  kick(guildId: string, userId: string, reason: string): Promise<Result<void, GuildEffectError>>;
  /** Returns how many messages were actually deleted. */
  purge(input: PurgeInput): Promise<Result<number, GuildEffectError>>;
  /** Locks or unlocks a channel (or every text channel when `channelId` is null). */
  setLocked(guildId: string, channelId: string | null, locked: boolean): Promise<Result<number, GuildEffectError>>;
}

export interface PurgeInput {
  readonly guildId: string;
  readonly channelId: string;
  readonly count: number;
  /** Restrict the sweep to one author's messages. */
  readonly userId?: string | null;
}

export type GuildEffectError =
  | { readonly kind: "MISSING_PERMISSION" }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "FAILED"; readonly detail: string };

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

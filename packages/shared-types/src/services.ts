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
  AchievementsDTO,
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
  MemberRecordDTO,
  MemberSummaryDTO,
  MilestoneDTO,
  MilestoneDefinitionDTO,
  MilestoneDefinitionInput,
  ModerationActionDTO,
  NetworthDTO,
  PendingMilestoneDTO,
  PermGroupDTO,
  ProgressMetric,
  ProgressSeriesDTO,
  PriceDTO,
  ProfileSummaryDTO,
  SafetyStatusDTO,
  SkillsDTO,
  SlayersDTO,
  SnapshotMetricsDTO,
  TicketDTO,
  TicketPanelConfigDTO,
  TicketPanelConfigInput,
  TicketTypeDTO,
  TicketTypeInput,
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
  /**
   * `/milestones` — the guild's achievements with this member's standing
   * against each: what they have earned, what they are closest to, and the XP
   * it has paid. Guild-scoped because the definitions are.
   */
  getAchievements(uuid: string, guildId: string): Promise<Result<AchievementsDTO>>;
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
 * Port: read-only access to a guild's milestone definitions.
 *
 * Split out of the editing service so `/milestones` — which must know what the
 * guild recognises to say how close a member is — can depend on the reading
 * half without acquiring the panel's write surface.
 */
export interface MilestoneDefinitionReader {
  /**
   * Every definition in effect: the built-in defaults with the guild's own rows
   * layered over them by key. Disabled rows are included and flagged, because
   * the panel has to render the switch it can turn back on.
   */
  list(guildId: string): Promise<readonly MilestoneDefinitionDTO[]>;
}

/**
 * Milestone thresholds a guild recognises (packages/db + the panel).
 *
 * Configuration, not member data — which is why this one *does* have a panel
 * surface while the achievements themselves stay in the bots. Staff decide what
 * the guild celebrates; nobody edits who reached it.
 */
export interface MilestoneDefinitionService extends MilestoneDefinitionReader {
  /** Create or update by `(guildId, key)`. Editing a default shadows it. */
  upsert(guildId: string, input: MilestoneDefinitionInput): Promise<MilestoneDefinitionDTO>;
  /**
   * Remove a guild's row. A shadowed default reverts to the built-in; a purely
   * custom definition disappears. Recorded milestones are untouched either way.
   */
  remove(guildId: string, key: string): Promise<boolean>;
}

/**
 * Ticket configuration a guild owns (packages/db + the panel).
 *
 * Configuration, not member data: what may be opened and who is pulled in when
 * it is. The tickets themselves — and the people inside them — stay in the bot,
 * the same line the milestone page draws between rules and standings.
 */
export interface TicketConfigService {
  /**
   * Every type in effect: the built-ins with the guild's own rows layered over
   * them by key. Disabled rows are included and flagged, because the panel has
   * to render the switch it can turn back on.
   */
  listTypes(guildId: string): Promise<readonly TicketTypeDTO[]>;
  /** Create or update by `(guildId, key)`. Editing a built-in shadows it. */
  upsertType(guildId: string, input: TicketTypeInput): Promise<TicketTypeDTO>;
  /**
   * Remove a guild's row. A shadowed built-in reverts to its default; a custom
   * type disappears from the menu. Tickets already opened keep their category.
   */
  removeType(guildId: string, key: string): Promise<boolean>;
  /** The panel's content, filled in with defaults when never configured. */
  getPanel(guildId: string): Promise<TicketPanelConfigDTO>;
  savePanel(guildId: string, input: TicketPanelConfigInput): Promise<TicketPanelConfigDTO>;
}

/**
 * Port: the announcement queue, implemented by `@sbr/db`.
 *
 * Detection and announcement are deliberately separate processes — the workers
 * record, a bot posts — so the handover is a durable flag rather than an event.
 * A sweep is at-least-once: `markAnnounced` runs after the message lands, so a
 * bot that dies mid-post re-posts on the next pass rather than losing the
 * milestone entirely. Duplicated praise is the better failure.
 */
export interface MilestoneAnnouncerPort {
  /** Unannounced milestones for guilds, oldest first. */
  listPending(limit: number): Promise<readonly PendingMilestoneDTO[]>;
  /** Flip the flag once posted. Returns rows changed. */
  markAnnounced(ids: readonly string[]): Promise<number>;
}

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
  /**
   * The most recent snapshot's metrics, or null if the member has never been
   * snapshotted. Separate from `listSnapshots` because achievements need one
   * reading of every milestone metric — including `slayerXp`, which the charted
   * series has no use for — rather than a window of four.
   */
  latestSnapshot(minecraftUuid: string): Promise<SnapshotMetricsDTO | null>;
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

/**
 * A member's own record, and only ever their own.
 *
 * Separate from `ModerationService` on purpose. The member bot needs to answer
 * "where do I stand" on `/me`, and handing it the moderation service to do that
 * would give every member-facing handler the ability to read anybody's audit
 * history and to issue punishments. This port takes the member's own id, has no
 * write path, and returns a DTO with no ids in it — so the widest thing a
 * member surface can do with it is exactly what `/me` does.
 */
export interface MemberRecordSource {
  forMember(guildId: string, discordId: string): Promise<Result<MemberRecordDTO>>;
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
  /**
   * The punishments being enforced right now, newest first. Expiry-aware: a
   * mute whose clock has run out is not listed even if the sweep has not
   * cleared its flag yet, so the list matches what the bridge and Discord are
   * actually enforcing rather than what the column last recorded.
   */
  listInForce(guildId: string, targetDiscordId?: string | null): Promise<Result<readonly ModerationActionDTO[]>>;
  /**
   * Clear the `active` flag on punishments whose duration has run out, and
   * report how many. Enforcement itself expires on its own (Redis TTLs, Discord
   * timeouts); this only stops the audit tables claiming otherwise.
   */
  sweepExpired(now?: Date): Promise<Result<number>>;
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
  /**
   * Only punishments still being enforced. Applied in the query rather than
   * over the results, so "the newest 100 still in force" is a hundred live
   * rows and not whatever survives filtering a hundred mixed ones.
   */
  readonly inForceOnly?: boolean;
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
  /**
   * Bind the Hypixel guild this platform guild tracks, or null to unlink. Until
   * this is set, roster sync and guild scan have nothing to sync and skip.
   *
   * The id is Hypixel's own 24-character guild id, not a name — resolving a name
   * to one is the caller's job, because only the caller knows whether it can ask
   * Hypixel right now.
   */
  setHypixelGuild(guildId: string, hypixelGuildId: string | null): Promise<Result<void>>;
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
   * Every configured channel, keyed by slot, and the only way to ask for one: a
   * slot with no binding is absent. The five `*ChannelId` fields that used to
   * sit beside this as a compatibility view are gone — a channel has exactly
   * one name now, and `getChannel(guildId, slot)` is how you get it.
   */
  readonly channels: Readonly<Partial<Record<ConfigChannelSlot, string>>>;
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
  getLfg(postId: string): Promise<Result<LFGPostDTO | null>>;
  /** Edit a post after the fact. Author, or staff acting on someone's behalf. */
  editLfg(input: LfgEdit): Promise<Result<LFGPostDTO, LfgError>>;
  /** Close a post early. Author, or staff. Expiry is a separate, quieter thing. */
  closeLfg(postId: string, actorDiscordId: string, isStaff?: boolean): Promise<Result<LFGPostDTO, LfgError>>;
  /**
   * Record where a post was published, so its embed can be edited in place.
   * Called by the transport after the message lands, never by a command.
   */
  bindLfgMessage(postId: string, channelId: string, messageId: string): Promise<Result<LFGPostDTO, LfgError>>;

  // ── Tickets (`/ticket`) ──
  openTicket(input: NewTicket): Promise<Result<TicketDTO>>;
  closeTicket(ticketId: string, actorDiscordId: string, reason: string | null): Promise<Result<TicketDTO, TicketError>>;
  listTickets(guildId: string, openerDiscordId?: string): Promise<Result<readonly TicketDTO[]>>;
  /**
   * The guild's ticket menu, built-ins included and in menu order. Disabled
   * types are present and flagged, so a caller can tell "not offered here" from
   * "never existed".
   */
  listTicketTypes(guildId: string): Promise<Result<readonly TicketTypeDTO[]>>;

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
  /** Short headline for the embed. */
  readonly title?: string | null;
  /**
   * Autofill the roster from a perm.
   *
   * `true` uses the author's default perm for this activity; a string names one.
   * Absent means "just me". A named perm that does not exist is an error, but a
   * *default* that does not exist is not: `perm: true` means "bring my usual
   * party if I have one", and someone who has never made a perm asked for a
   * perfectly ordinary solo post.
   */
  readonly perm?: boolean | string;
}

/** A roster edit an author (or staff) makes after posting. */
export interface LfgEdit {
  readonly postId: string;
  readonly actorDiscordId: string;
  /** True when the actor may act on anybody's post. */
  readonly isStaff?: boolean;
  readonly title?: string | null;
  readonly details?: string | null;
  readonly slotsTotal?: number;
}

export type LfgError =
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "FULL" }
  | { readonly kind: "CLOSED" }
  | { readonly kind: "ALREADY_JOINED" }
  | { readonly kind: "NOT_A_MEMBER" }
  | { readonly kind: "AUTHOR_CANNOT_LEAVE" }
  | { readonly kind: "INVALID_SLOTS"; readonly detail: string }
  /** The actor is neither the author nor staff. */
  | { readonly kind: "NOT_YOURS" }
  /** A named perm that does not exist, or is not the actor's to use. */
  | { readonly kind: "NO_SUCH_PERM"; readonly detail: string }
  /** Shrinking a post below the number of people already in it. */
  | { readonly kind: "SLOTS_BELOW_ROSTER"; readonly detail: string };

/**
 * Perms — standing parties (packages/perms).
 *
 * Member-facing only. There is deliberately no panel surface for any of this:
 * who someone runs dungeons with is not staff configuration, and the panel's
 * scope is administration (PLATFORM_EXPANSION_PLAN.md §4).
 */
export interface PermService {
  createPerm(input: NewPermGroup): Promise<Result<PermGroupDTO, PermError>>;
  /** Resolve by id or by name (case-insensitive) within the guild. */
  getPerm(guildId: string, idOrName: string): Promise<Result<PermGroupDTO, PermError>>;
  listPerms(guildId: string, ownerDiscordId?: string): Promise<Result<readonly PermGroupDTO[]>>;
  addToRoster(input: RosterChange): Promise<Result<PermGroupDTO, PermError>>;
  removeFromRoster(input: RosterChange): Promise<Result<PermGroupDTO, PermError>>;
  disbandPerm(guildId: string, idOrName: string, actor: PermActor): Promise<Result<PermGroupDTO, PermError>>;
  setDefaultPerm(guildId: string, idOrName: string, actor: PermActor): Promise<Result<PermGroupDTO, PermError>>;
  /** What `/lfg perm:true` autofills from; null when the caller has no default. */
  defaultPermFor(guildId: string, ownerDiscordId: string, activity: LFGActivity): Promise<Result<PermGroupDTO | null>>;
}

export interface NewPermGroup {
  readonly guildId: string;
  readonly ownerDiscordId: string;
  readonly name: string;
  readonly activity: LFGActivity;
  readonly notes?: string | null;
}

/**
 * Who is asking. `isStaff` is resolved by the caller from the capability check
 * rather than re-derived here, so the rule "owner or staff" is stated once in
 * the service and enforced identically from every surface.
 */
export interface PermActor {
  readonly discordId: string;
  readonly isStaff: boolean;
}

export interface RosterChange {
  readonly guildId: string;
  readonly idOrName: string;
  readonly actor: PermActor;
  readonly ign: string;
  readonly role: string;
  readonly slot?: number | null;
}

export type PermError =
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "DISBANDED" }
  | { readonly kind: "NAME_TAKEN"; readonly name: string }
  | { readonly kind: "NOT_OWNER" }
  | { readonly kind: "FULL"; readonly capacity: number }
  | { readonly kind: "ALREADY_ON_ROSTER"; readonly ign: string }
  | { readonly kind: "NOT_ON_ROSTER"; readonly ign: string }
  | { readonly kind: "INVALID_ROLE"; readonly allowed: readonly string[] }
  | { readonly kind: "INVALID_NAME"; readonly detail: string }
  | { readonly kind: "INVALID_IGN" };

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
  /**
   * Edit an existing rule in place. Null when the guild has no such rule.
   *
   * Separate from `add` because the two answer different questions: a rule
   * being switched off, or having its severity corrected, is the same rule and
   * must keep its id — remove-and-re-add would break every reference to it and
   * reorder the list under whoever was reading it.
   */
  update(
    guildId: string,
    id: string,
    patch: WordlistRuleUpdate,
  ): Promise<Result<WordlistRuleDTO | null, WordlistError>>;
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

/**
 * A partial edit. Every field is optional and an omitted field is left alone —
 * `null` is only meaningful for `note`, where it means "clear it".
 */
export interface WordlistRuleUpdate {
  readonly pattern?: string;
  readonly matchType?: WordMatchType;
  readonly action?: WordAction;
  readonly severity?: number;
  readonly enabled?: boolean;
  readonly note?: string | null;
}

export type WordlistError =
  | { readonly kind: "INVALID_PATTERN"; readonly detail: string }
  | { readonly kind: "DUPLICATE" };

/**
 * "Is this text allowed to be said here?" and nothing else.
 *
 * The member bot needs one thing from the chat filter — a yes or no about a
 * line it is about to speak on the guild's behalf — and `WordlistService` would
 * give it the ability to rewrite the guild's rules to get a different answer.
 * Same reasoning as `MemberRecordSource`: a read-only, single-question port
 * costs one interface and removes a whole class of reachable mistake.
 */
export interface TextScreen {
  isClean(guildId: string, text: string): Promise<boolean>;
}

/**
 * A named running total, per guild and per subject.
 *
 * Exists for the joke counters (`!cringe`) and deliberately has no read, no
 * reset and no listing: a tally that can be enumerated is a leaderboard, and a
 * leaderboard about who is cringe is a different product decision than the one
 * that was made here. The store is expected to expire idle counters on its own.
 */
export interface TallyStore {
  /** Add one and return the new total. */
  bump(guildId: string, name: string, subject: string): Promise<number>;
}

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

/**
 * XP & standing (packages/xp).
 *
 * Member-facing to read, admin-facing to configure — the same split as
 * moderation. `/standing` and the leaderboards live in the bots; weights, caps
 * and manual adjustments live in the panel. Nothing here exposes another
 * member's activity counters, only the XP they produced.
 */
export interface XpService {
  /**
   * Count a message towards XP, if it counts. Returns whether it did, for
   * diagnostics — no caller is expected to branch on it, and this never throws:
   * a member's message must not fail because the bookkeeping did.
   */
  recordMessage(
    guildId: string,
    discordId: string,
    source: "DISCORD_MESSAGE" | "GUILD_CHAT_MESSAGE",
    text: string,
  ): Promise<boolean>;
  recordCommand(guildId: string, discordId: string): Promise<boolean>;
  /** Null when the member has never earned anything — not a zeroed standing. */
  standing(guildId: string, discordId: string): Promise<XpStandingDTO | null>;
  leaderboard(guildId: string, limit: number): Promise<readonly XpStandingDTO[]>;
  /**
   * A milestone reward, credited once. The dedupe key is the milestone id, so
   * re-running detection or replaying a day credits nothing twice.
   *
   * Awarded when the milestone is *recorded*, not when it is announced: the
   * announce flag governs visibility, and a guild that recognises something
   * quietly still means to pay for it.
   */
  awardMilestone(
    guildId: string,
    discordId: string,
    amount: number,
    milestoneId: string,
    label: string,
  ): Promise<boolean>;
  /** Staff adjustment, signed and always reasoned. Rebuilds the balance now. */
  adjust(
    guildId: string,
    discordId: string,
    amount: number,
    reason: string,
    byDiscordId: string,
  ): Promise<XpStandingDTO | null>;
  /**
   * The guild's configured sources. A source with no row is absent from the
   * map, which means disabled — the panel renders those as off rather than
   * inventing a default, because a guessed default is a weight nobody chose.
   */
  policy(guildId: string): Promise<Readonly<Partial<Record<XpSource, XpSourcePolicyDTO>>>>;
  setSourcePolicy(guildId: string, policy: XpSourcePolicyDTO): Promise<XpSourcePolicyDTO>;
}

/** Where a unit of XP came from. Mirrors the `XpSource` DB enum. */
export type XpSource =
  | "GEXP"
  | "DISCORD_MESSAGE"
  | "GUILD_CHAT_MESSAGE"
  | "TENURE"
  | "COMMAND_USAGE"
  | "EVENT"
  | "MILESTONE"
  | "MANUAL";

/** A member's standing, as the bots render it. */
export interface XpStandingDTO {
  readonly discordId: string;
  readonly totalXp: number;
  readonly level: number;
  /** XP into the current level, and what the next one costs. */
  readonly intoLevel: number;
  readonly levelSpan: number;
  readonly bySource: Readonly<Partial<Record<XpSource, number>>>;
  readonly tenureDays: number;
  readonly lastAwardAt: Date | null;
  /** 1-based position in the guild by total XP; null when unranked. */
  readonly rank: number | null;
}

/** Per-source weight and anti-abuse limits. Panel-configured. */
export interface XpSourcePolicyDTO {
  readonly source: XpSource;
  readonly enabled: boolean;
  /** XP per unit of raw value. Fractional: GEXP is thousands a day, XP is not. */
  readonly weight: number;
  /** Most XP this source may award one member in one day. Null = uncapped. */
  readonly dailyCap: number | null;
  /** Minimum gap between two countable actions, in seconds. */
  readonly cooldownSec: number;
  /** Minimum message length to count at all. */
  readonly minLength: number;
}

/**
 * Leaderboards (packages/leaderboards).
 *
 * Member-facing and nothing else: the bots and the in-game surface read these,
 * and the panel deliberately has no leaderboard page. Ranking the guild is
 * something the guild does, not something staff administers.
 */
export const LEADERBOARD_CATEGORIES = [
  "wealth",
  "tenure",
  "skill-average",
  "catacombs",
  "slayer",
  "discord-activity",
  "guild-chat",
  "xp",
] as const;

export type LeaderboardCategory = (typeof LEADERBOARD_CATEGORIES)[number];

/**
 * Human labels for the categories.
 *
 * Here rather than beside the specs in `@sbr/leaderboards` because the Discord
 * registration payload is built from static data — the choice list for
 * `/leaderboard` is assembled long before any page is fetched — and the bots
 * cannot reach the domain package. `CATEGORY_SPECS` reads its labels from this
 * map, so the two can't drift.
 */
export const LEADERBOARD_LABELS: Readonly<Record<LeaderboardCategory, string>> = {
  wealth: "Wealth",
  tenure: "Tenure",
  "skill-average": "Skill average",
  catacombs: "Catacombs",
  slayer: "Slayer",
  "discord-activity": "Discord activity",
  "guild-chat": "Guild chat",
  xp: "Guild XP",
};

/**
 * Spellings people actually type, mapped to the canonical id. The in-game
 * surface is the reason this exists: `!leaderboard nw` is what someone writes
 * in guild chat, and answering "unknown category" to it would be pedantry.
 */
const LEADERBOARD_ALIASES: Readonly<Record<string, LeaderboardCategory>> = {
  nw: "wealth",
  networth: "wealth",
  money: "wealth",
  coins: "wealth",
  rich: "wealth",
  days: "tenure",
  oldest: "tenure",
  sa: "skill-average",
  skills: "skill-average",
  skill: "skill-average",
  cata: "catacombs",
  dungeons: "catacombs",
  dungeon: "catacombs",
  slayers: "slayer",
  discord: "discord-activity",
  messages: "discord-activity",
  activity: "discord-activity",
  chat: "guild-chat",
  gc: "guild-chat",
  level: "xp",
  standing: "xp",
};

/** Canonical category for anything a member might type, or null. */
export function categoryFor(raw: string): LeaderboardCategory | null {
  const key = raw.trim().toLowerCase();
  const direct = LEADERBOARD_CATEGORIES.find((c) => c === key);
  if (direct !== undefined) return direct;
  // Punctuation-insensitive: "skill average", "skill_average" and "skillaverage"
  // are all the same request.
  const squashed = key.replace(/[\s_-]+/g, "");
  const canonical = LEADERBOARD_CATEGORIES.find((c) => c.replace(/-/g, "") === squashed);
  return canonical ?? LEADERBOARD_ALIASES[squashed] ?? null;
}

/**
 * Where a category's numbers come from, which is also how stale they can be.
 * `SNAPSHOT` is the only family that can lag — it reads the newest profile
 * capture, up to a snapshot cycle old.
 */
export type LeaderboardSourceKind = "SNAPSHOT" | "TENURE" | "ACTIVITY" | "XP";

/** How the transport should print a ranked value. The domain never formats. */
export type LeaderboardValueFormat = "coins" | "count" | "level" | "days";

export interface LeaderboardCategorySpec {
  readonly id: LeaderboardCategory;
  readonly label: string;
  readonly format: LeaderboardValueFormat;
  readonly source: LeaderboardSourceKind;
  /** Honest one-liner about what is being measured. */
  readonly description: string;
  /** True when the ranking covers a rolling window rather than all time. */
  readonly windowed: boolean;
}

export interface LeaderboardEntryDTO {
  /** Identity in that category's own space — a uuid or a Discord snowflake. */
  readonly key: string;
  /** An IGN where one is known, else a Discord mention. Never a raw id. */
  readonly label: string;
  readonly value: number;
  /** When the reading was taken; null for values derived at read time. */
  readonly at: string | null;
  /** 1-based competition rank: two members tied for 2nd are followed by 4th. */
  readonly rank: number;
  readonly isViewer: boolean;
}

export interface LeaderboardPageDTO {
  readonly category: LeaderboardCategory;
  readonly spec: LeaderboardCategorySpec;
  readonly entries: readonly LeaderboardEntryDTO[];
  readonly page: number;
  readonly pageCount: number;
  readonly totalRanked: number;
  /** Days covered, for windowed categories; null for the rest. */
  readonly windowDays: number | null;
  /** The caller's own row, only when it falls outside the shown page. */
  readonly viewer: LeaderboardEntryDTO | null;
  /** Oldest reading on the page: worst-case staleness, not best. */
  readonly oldestReadingAt: string | null;
}

export interface LeaderboardQuery {
  readonly guildId: string;
  readonly category: LeaderboardCategory;
  /** The caller, so their own row can be found. */
  readonly discordId: string;
  readonly page?: number;
  readonly pageSize?: number;
  readonly windowDays?: number;
}

export interface LeaderboardService {
  page(query: LeaderboardQuery): Promise<LeaderboardPageDTO>;
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

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
  EnforcementStatus,
  EventPodiumDTO,
  FilterTestDTO,
  GuildRosterDTO,
  HealthReportDTO,
  InfractionDTO,
  ItemMatchDTO,
  LFGPostDTO,
  LinkedIdentityDTO,
  LockdownStateDTO,
  LowestBinDTO,
  MarketHistoryDTO,
  MarketRange,
  MemberRecordDTO,
  MemberSummaryDTO,
  GoalDTO,
  MilestoneDTO,
  MilestoneDefinitionDTO,
  MilestoneDefinitionInput,
  ModerationActionDTO,
  NetworthDTO,
  PendingLevelUpDTO,
  ReminderDTO,
  PendingMilestoneDTO,
  PermGroupDTO,
  ProgressMetric,
  ProgressSeriesDTO,
  SavedSnapshotDTO,
  PriceDTO,
  ProfileSummaryDTO,
  SafetyStatusDTO,
  SkillsDTO,
  SlayersDTO,
  SnapshotMetricsDTO,
  TicketCategoryDTO,
  TicketCategoryInput,
  TicketDTO,
  TicketPanelDTO,
  TicketPanelInput,
  TicketSettingsDTO,
  TicketSettingsInput,
  TicketTagDTO,
  TicketTagInput,
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
  /** Null when the person is not a member of this guild — not MEMBER. */
  getRole(guildId: string, discordId: string): Promise<MemberRole | null>;
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
  /**
   * `/snapshot` — pin the member's current reading so a later one has something
   * to be compared against.
   *
   * The platform no longer keeps a history to chart, so a member who wants one
   * builds it deliberately, a marker at a time (docs/HYPIXEL_COMPLIANCE.md §1).
   * `savedBy` is the Discord id of whoever pressed save, which is always the
   * member themselves — there is no way to save on somebody else's behalf.
   */
  saveSnapshot(
    uuid: string,
    savedBy: string,
    label: string | null,
  ): Promise<Result<SavedSnapshotDTO, SaveSnapshotError>>;
  /**
   * `/goal set` — one target per member per metric, replacing any earlier one.
   *
   * Replacing rather than accumulating is the honest model of what a goal is: a
   * member has one current intention about their networth, not a queue of them,
   * and a list that grew forever would be a chore to prune rather than a thing
   * to check. The record of *reaching* a target lives in `Milestone`, which is
   * the table built to remember things.
   */
  setGoal(guildId: string, uuid: string, metric: ProgressMetric, target: number): Promise<Result<GoalDTO, GoalError>>;
  /** `/goal` — every target this member is working towards, with its standing. */
  listGoals(guildId: string, uuid: string): Promise<Result<readonly GoalDTO[]>>;
  /** `/goal clear` — drop one. False when they had no goal for that metric. */
  clearGoal(guildId: string, uuid: string, metric: ProgressMetric): Promise<Result<boolean>>;
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

export type SaveSnapshotError =
  /** Nothing has read this account yet, so there is nothing to pin. */
  | { readonly kind: "NO_READING" }
  /** Their newest save is already this same reading. */
  | { readonly kind: "ALREADY_SAVED"; readonly capturedAt: string }
  | { readonly kind: "UNAVAILABLE" };

export type SelectProfileError =
  | { readonly kind: "NO_SUCH_PROFILE" }
  | { readonly kind: "UNAVAILABLE" };

export type GoalError =
  /** No goal storage wired — the feature is not installed, not broken. */
  | { readonly kind: "UNAVAILABLE" }
  /** The member is already at or past the number they asked to reach. */
  | { readonly kind: "ALREADY_THERE"; readonly current: number }
  /** Below zero, non-finite, or absurd enough to be a typo rather than an ambition. */
  | { readonly kind: "BAD_TARGET" };

/**
 * Port: the goals a member set, implemented by `@sbr/db`.
 *
 * A port of its own rather than four more methods on `ProgressionRepository`,
 * because it is optional in the way that one is not: a deployment without goal
 * storage still charts progress, and every existing implementation of that
 * interface — including the fakes in the tests — would otherwise have to grow
 * four methods to keep compiling.
 */
export interface GoalRepository {
  /** Upsert on (member, metric). Returns the stored row. */
  setGoal(input: {
    readonly guildId: string;
    readonly minecraftUuid: string;
    readonly metric: ProgressMetric;
    readonly target: number;
    readonly startValue: number | null;
  }): Promise<StoredGoalDTO>;
  listGoals(guildId: string, minecraftUuid: string): Promise<readonly StoredGoalDTO[]>;
  clearGoal(guildId: string, minecraftUuid: string, metric: ProgressMetric): Promise<boolean>;
  /**
   * Every unachieved goal across the platform, for the job that checks them.
   * Paged by id so a guild with many members cannot starve the rest.
   */
  listUnachieved(limit: number, afterId?: string): Promise<readonly StoredGoalDTO[]>;
  /** Stamp `achievedAt`. Returns rows changed, so a double-run announces once. */
  markAchieved(ids: readonly string[], at: Date): Promise<number>;
}

/** What the store holds, before the service works out how it is going. */
export interface StoredGoalDTO {
  readonly id: string;
  readonly guildId: string;
  readonly minecraftUuid: string;
  readonly discordId: string | null;
  readonly metric: ProgressMetric;
  readonly target: number;
  readonly startValue: number | null;
  readonly createdAt: string;
  readonly achievedAt: string | null;
}

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

  /**
   * How many members hold each definition, keyed by `key`.
   *
   * Optional because it is the one question here that needs the milestone rows
   * rather than the definition rows, and a deployment that wires only the
   * config half should not be forced to answer it. A key absent from the map
   * means nobody holds it, which is the same thing zero means — callers should
   * default rather than distinguish.
   *
   * Community definitions are always absent: they are recognised from the
   * standing rather than recorded, so there are no rows to count. The panel
   * says so rather than reporting them as held by nobody.
   */
  countHolders?(guildId: string): Promise<Readonly<Record<string, number>>>;
}

/**
 * Ticket configuration a guild owns (packages/db + the panel).
 *
 * Configuration, not member data: what may be opened and who is pulled in when
 * it is. The tickets themselves — and the people inside them — stay in the bot,
 * the same line the milestone page draws between rules and standings.
 */
export interface TicketConfigService {
  /** Per-guild behaviour, filled in with defaults when never configured. */
  getSettings(guildId: string): Promise<TicketSettingsDTO>;
  saveSettings(guildId: string, input: TicketSettingsInput): Promise<TicketSettingsDTO>;

  /**
   * Every category the guild has, in menu order.
   *
   * Disabled rows are included and flagged, because the panel has to render the
   * switch it can turn back on. There are no built-ins layered underneath: the
   * five former enum values are seeded as ordinary rows, so a guild that deletes
   * one has deleted it.
   */
  listCategories(guildId: string): Promise<readonly TicketCategoryDTO[]>;
  /** Create or update by `(guildId, key)`. */
  upsertCategory(guildId: string, input: TicketCategoryInput): Promise<TicketCategoryDTO>;
  /**
   * Remove a category. Tickets already opened under it keep their history —
   * their `categoryId` goes null rather than the rows going with it.
   */
  removeCategory(guildId: string, key: string): Promise<boolean>;

  /** Every panel, whether published or not. */
  listPanels(guildId: string): Promise<readonly TicketPanelDTO[]>;
  upsertPanel(guildId: string, input: TicketPanelInput, id?: string): Promise<TicketPanelDTO>;
  removePanel(guildId: string, id: string): Promise<boolean>;
  /**
   * Record where a panel was posted, so a re-publish edits that message rather
   * than leaving a stale panel behind. Changing the channel clears the message.
   */
  setPostedMessage(guildId: string, id: string, channelId: string, messageId: string | null): Promise<void>;

  /** Canned replies and their auto-response patterns. */
  listTags(guildId: string): Promise<readonly TicketTagDTO[]>;
  upsertTag(guildId: string, input: TicketTagInput): Promise<TicketTagDTO>;
  removeTag(guildId: string, name: string): Promise<boolean>;
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
/**
 * Port: the level-up announcement queue, implemented by `@sbr/db`.
 *
 * Same shape and same reasoning as `MilestoneAnnouncerPort` — recorded by the
 * pass that rebuilds balances, posted by the member bot, handed over through a
 * durable flag. Kept as its own port rather than folded into that one because
 * they are announced into different channels and a guild may want one without
 * the other.
 */
/**
 * Reminders. Deliberately small, and member-scoped by every signature: a
 * reminder is one person's note to themselves, so there is no "list everybody's"
 * on this port at all.
 */
export interface ReminderPort {
  create(input: {
    readonly guildId: string;
    readonly discordId: string;
    readonly channelId: string;
    readonly text: string;
    readonly dueAt: Date;
  }): Promise<ReminderDTO>;
  /** Undelivered and due, oldest first. The sweeper's only read. */
  listDue(now: Date, limit: number): Promise<readonly ReminderDTO[]>;
  markDelivered(ids: readonly string[]): Promise<number>;
  /** One member's own pending reminders, soonest first. */
  listPendingFor(guildId: string, discordId: string): Promise<readonly ReminderDTO[]>;
  /**
   * Cancel one. Scoped to the owner on purpose — an id is guessable, and
   * cancelling somebody else's reminder must not be one typo away.
   */
  cancel(guildId: string, discordId: string, id: string): Promise<boolean>;
  /** How many pending reminders this member already has. Enforces the per-member cap. */
  countPendingFor(guildId: string, discordId: string): Promise<number>;
}

export interface LevelUpAnnouncerPort {
  listPending(limit: number, excludeGuildIds?: readonly string[]): Promise<readonly PendingLevelUpDTO[]>;
  markAnnounced(ids: readonly string[]): Promise<number>;
}

export interface MilestoneAnnouncerPort {
  /**
   * Unannounced milestones for guilds, oldest first.
   *
   * `excludeGuildIds` is how the announcer avoids head-of-line blocking: a
   * guild with no milestones channel keeps its rows, and asking again without
   * it is what stops those rows starving every other guild behind them.
   */
  listPending(limit: number, excludeGuildIds?: readonly string[]): Promise<readonly PendingMilestoneDTO[]>;
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
    readonly capturedAt: string;
    readonly label: string | null;
    readonly skyblockLevel: number | null;
    readonly networth: number | null;
    readonly skillAverage: number | null;
    readonly catacombsLevel: number | null;
  }[]>;
  /**
   * The member's current reading, or null if they have never been refreshed.
   *
   * A different table from `listSnapshots`, not a different slice of the same
   * one: this is the automatically-refreshed current value, while snapshots are
   * markers a member chose to save. It also carries every milestone metric —
   * including `slayerXp`, which the charted series has no use for.
   */
  latestSnapshot(minecraftUuid: string): Promise<SnapshotMetricsDTO | null>;
  /**
   * Copy the member's current reading into a snapshot they own.
   *
   * A copy rather than a fetch: saving a marker costs no upstream request at
   * all, because the value being pinned is the one the hourly refresh already
   * holds. That is what keeps an explicit, member-triggered feature from being
   * a way to poll Hypixel on demand.
   *
   * `ALREADY_SAVED` when the current reading is already the newest saved one —
   * two identical rows would chart as a flat line the member did not earn.
   * `NO_READING` when the account has never been refreshed.
   */
  saveSnapshot(
    minecraftUuid: string,
    savedBy: string,
    label: string | null,
  ): Promise<
    | { readonly kind: "SAVED"; readonly capturedAt: string; readonly savedCount: number }
    | { readonly kind: "ALREADY_SAVED"; readonly capturedAt: string }
    | { readonly kind: "NO_READING" }
  >;
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

/**
 * Price history (packages/pricing, Coflnet-backed).
 *
 * Separate from `MarketService` because the sourcing rule is different in a way
 * that has to stay visible at the call site. `MarketService` answers from our
 * own Hypixel-backed caches, which are rate-gated and which networth valuation
 * also depends on. History comes from a third party we do not run, so it has
 * its own cache and its own breaker, and it is allowed to simply not answer.
 *
 * `null` means "no history right now" — cold cache, open breaker, unknown item.
 * Never an empty series standing in for an outage: a flat chart and a missing
 * chart say opposite things about an item.
 */
export interface MarketHistoryService {
  history(itemId: string, range: MarketRange): Promise<MarketHistoryDTO | null>;
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

/**
 * A member's event placings, and only ever their own.
 *
 * Split out of `CommunityService` for the same reason `MemberRecordSource` is
 * split out of `ModerationService`: `/me` needs one read, and handing the
 * member bot the community service to get it would hand it every ticket and
 * every event mutation as well. One member, one guild, no writes.
 */
export interface MemberPodiumSource {
  forMember(guildId: string, discordId: string, recentLimit?: number): Promise<Result<EventPodiumDTO>>;
}

/** Moderation + audit (packages/moderation). Shared by admin-bot and web-panel. */
export interface ModerationService {
  recordInfraction(
    input: Omit<InfractionDTO, "id" | "createdAt">,
  ): Promise<Result<InfractionDTO>>;
  applyAction(input: ApplyActionInput): Promise<Result<ModerationActionDTO, ModerationError>>;
  listInfractions(guildId: string, discordId: string): Promise<Result<readonly InfractionDTO[]>>;
  /**
   * The guild's most recent infractions, whoever they are against.
   *
   * A separate method rather than an empty `discordId`, because "everyone" and
   * "a member whose id I failed to resolve" would otherwise be the same call
   * with very different answers — one of which quietly shows staff another
   * member's history.
   */
  listRecentInfractions(guildId: string, limit?: number): Promise<Result<readonly InfractionDTO[]>>;
  /** `/audit` — the moderation log, filtered and newest-first. */
  listActions(query: AuditQuery): Promise<Result<readonly ModerationActionDTO[]>>;
  /**
   * `/case` — one action by the id every reply and mod-log card already quotes.
   *
   * Guild-scoped: a case id is quoted in public, and one guild's id must never
   * read another guild's moderation history.
   */
  findAction(guildId: string, actionId: string): Promise<Result<ModerationActionDTO | null>>;
  /**
   * The punishments being enforced right now, newest first. Expiry-aware: a
   * mute whose clock has run out is not listed even if the sweep has not
   * cleared its flag yet, so the list matches what the bridge and Discord are
   * actually enforcing rather than what the column last recorded.
   */
  listInForce(guildId: string, targetDiscordId?: string | null): Promise<Result<readonly ModerationActionDTO[]>>;
  /**
   * Clear the `active` flag on punishments whose duration has run out, and
   * report how many.
   *
   * Bookkeeping only. The comment here used to say enforcement expires on its
   * own — true of a Discord timeout and a Redis TTL, false of a Discord ban and
   * of the Hypixel guild mute a relayed `/g mute` set. Lifting those is
   * `reverseExpired` on the implementation, which the admin bot's sweep calls;
   * this method on its own turns a temp ban into a permanent one.
   */
  sweepExpired(now?: Date): Promise<Result<number>>;
  /**
   * Correct the metadata on a case that has already been issued.
   *
   * Metadata only, and deliberately: this re-times the punishment through the
   * enforcement mirror so a shortened mute really is shorter, but it does not
   * re-run the Discord or guild-chat legs. Re-punishing somebody as a side
   * effect of fixing their case's spelling is not what anybody typing an edit
   * is asking for; `retryEnforcement` is how you ask for that.
   */
  updateAction(input: CaseEditInput): Promise<Result<ModerationActionDTO, ModerationError>>;
  /**
   * Record what a human knows that the platform does not: "I did this by hand."
   *
   * The enforcement column is only useful if the queue of FAILED rows can be
   * cleared by the person who cleared the failure. Without this, one refused
   * API call left a red row on the moderation page for ever.
   */
  setEnforcementManually(
    guildId: string,
    actionId: string,
    editorDiscordId: string,
    status: EnforcementStatus,
    note: string,
  ): Promise<Result<ModerationActionDTO, ModerationError>>;
  /** Attempt the enforcement again and restamp the row from the real result. */
  retryEnforcement(
    guildId: string,
    actionId: string,
    editorDiscordId: string,
  ): Promise<Result<ModerationActionDTO, ModerationError>>;
  /**
   * Withdraw a case: this punishment should not have happened.
   *
   * Soft, and compensating. If the case still holds enforcement — an active
   * mute or ban — voiding it also issues the matching UNMUTE or UNBAN, because
   * a log reading "voided" beside somebody who is still banned is the exact
   * shape of lie this whole surface exists to prevent.
   */
  voidAction(
    guildId: string,
    actionId: string,
    editorDiscordId: string,
    reason: string,
  ): Promise<Result<ModerationActionDTO, ModerationError>>;
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
  | { readonly kind: "DURATION_REQUIRED" }
  /** No case with that id in this guild. Never "some other guild has it". */
  | { readonly kind: "NO_SUCH_CASE" }
  /** A case can be corrected once. Voiding it again is not a second decision. */
  | { readonly kind: "ALREADY_VOID" };

/**
 * A correction to a case that has already been issued.
 *
 * Sparse: every field bar the identifiers is optional, and `undefined` means
 * "leave it". The panel writes one field per request, so a staffer fixing a
 * typo cannot silently overwrite a duration somebody else changed while the
 * page was open.
 */
export interface CaseEditInput {
  readonly guildId: string;
  readonly actionId: string;
  /** Who is making the change. Stamped on the row and quoted in the mod log. */
  readonly editorDiscordId: string;
  readonly reason?: string;
  /**
   * Re-times the punishment. `expiresAt` is recomputed from `createdAt`, not
   * from now: a two-hour mute corrected to one hour should end an hour after it
   * started, otherwise every correction silently extends the sentence.
   */
  readonly durationSeconds?: number | null;
}

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
   * Replace the whole set of Discord roles that confer one level. The set form
   * of `setRoleMapping`, which the panel's Permissions page writes; the single
   * form stays for `/set-role type:mapping`.
   */
  setRoleBinding(guildId: string, role: MemberRole, discordRoleIds: readonly string[]): Promise<Result<void>>;
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
 * `/set-recruitment` input.
 *
 * One switch, where it used to carry tri-state weight and networth bars. The
 * guild's only entry requirement is now the scam check, so there is no stat to
 * set: applications are open or they are not. The columns behind the old bars
 * are still in the schema, marked deprecated rather than dropped.
 */
export interface RecruitmentSettings {
  readonly open: boolean;
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
  "tickets",
  "milestones",
  "leaderboard",
  "modlog",
  "welcome",
  "levels",
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
  tickets: "Ticket panel",
  milestones: "Milestone announcements",
  welcome: "Welcome & farewell",
  leaderboard: "Leaderboards",
  modlog: "Moderation log",
  levels: "Level-up announcements",
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
  /**
   * Platform role → the Discord role(s) that confer it: one id as
   * `/set-role type:mapping` records it, a list as the panel's Permissions page
   * does. Read it through `parseRoleBindings` rather than by hand.
   */
  readonly roleMappings: Readonly<Record<string, string | readonly string[]>>;
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
  /** Change a scheduled event. Host, or staff acting on their behalf. */
  updateEvent(input: EventEdit): Promise<Result<EventDTO, EventError>>;
  /**
   * End an event that has run, stamping `endsAt`.
   *
   * Separate from `cancelEvent` because the two mean opposite things to
   * everyone downstream: a completed event's tracker board is rewritten once
   * more as its result card, and a cancelled one's says it was called off.
   */
  completeEvent(eventId: string, actorDiscordId: string, isStaff?: boolean): Promise<Result<EventDTO, EventError>>;
  /** Records a response, downgrading GOING to WAITLIST when the event is full. */
  rsvp(eventId: string, discordId: string, state: RSVPState): Promise<Result<RsvpOutcome, EventError>>;
  getAttendance(eventId: string): Promise<Result<AttendanceDTO, EventError>>;
  /**
   * Replace the hand-marked attendance list for an event.
   *
   * Wholesale rather than one id at a time because the question being answered
   * is "who was there", and an add/remove pair would let two people editing the
   * same list each win half of it. Rows the tracker wrote are left alone: a
   * correction should never quietly discard what the poller actually observed.
   */
  markAttendance(input: AttendanceEdit): Promise<Result<AttendanceDTO, EventError>>;

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

  // ── Tickets ──
  //
  // Every mutating call takes the actor, not just the ticket id. That is the
  // fix for the old surface, where `closeTicket(id)` asked nobody's permission.
  openTicket(input: NewTicket): Promise<Result<TicketDTO, TicketError>>;
  closeTicket(ticketId: string, actor: TicketActor, reason: string | null): Promise<Result<TicketDTO, TicketError>>;
  requestTicketClose(ticketId: string, actor: TicketActor): Promise<Result<TicketDTO, TicketError>>;
  claimTicket(ticketId: string, actor: TicketActor): Promise<Result<TicketDTO, TicketError>>;
  releaseTicket(ticketId: string, actor: TicketActor): Promise<Result<TicketDTO, TicketError>>;
  transferTicket(ticketId: string, actor: TicketActor, toDiscordId: string): Promise<Result<TicketDTO, TicketError>>;
  setTicketTopic(ticketId: string, actor: TicketActor, topic: string): Promise<Result<TicketDTO, TicketError>>;
  getTicket(ticketId: string): Promise<Result<TicketDTO | null>>;
  /** The ticket a channel belongs to, or null — how the in-channel commands resolve. */
  getTicketByChannel(channelId: string): Promise<Result<TicketDTO | null>>;
  listTickets(guildId: string, openerDiscordId?: string): Promise<Result<readonly TicketDTO[]>>;
  /**
   * The guild's ticket menu, in menu order. Disabled categories are present and
   * flagged, so a caller can tell "not offered here" from "never existed".
   */
  listTicketCategories(guildId: string): Promise<Result<readonly TicketCategoryDTO[]>>;

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
  /**
   * The tracker's settings, at creation rather than only afterwards.
   *
   * These used to be edit-only, so every contest was created with the defaults
   * and had to be corrected in a second step — and an event that went LIVE
   * before somebody remembered captured its baselines against the wrong metric
   * list, which cannot be fixed after the fact.
   */
  readonly endsAt?: string | null;
  readonly trackedMetrics?: readonly string[];
  readonly pollIntervalMinutes?: number;
  readonly prize?: string | null;
}

/**
 * A change to an event that has not happened yet.
 *
 * Every field but the id is optional and absent means "leave it alone", the
 * same contract as `LfgEdit`: the panel's form submits only what the operator
 * touched, so a host editing a start time cannot blank a description they never
 * opened. `isStaff` exists for the same reason it does on LFG — the host owns
 * their event, and staff act above that rather than around it.
 */
/** Who was actually there, as decided by a person rather than by the poller. */
export interface AttendanceEdit {
  readonly eventId: string;
  readonly actorDiscordId: string;
  /** True when the actor may mark anybody's event. */
  readonly isStaff?: boolean;
  /** The complete hand-marked list. An empty array clears it. */
  readonly discordIds: readonly string[];
}

export interface EventEdit {
  readonly eventId: string;
  readonly actorDiscordId: string;
  /** True when the actor may edit anybody's event. */
  readonly isStaff?: boolean;
  readonly title?: string;
  readonly description?: string | null;
  readonly startsAt?: string;
  readonly capacity?: number | null;
  /** Metric keys the tracker scores. An empty array turns scoring off. */
  readonly trackedMetrics?: readonly string[];
  readonly pollIntervalMinutes?: number;
  readonly tracksProgression?: boolean;
  /**
   * Editable while the event is scheduled *and* while it is LIVE — a contest
   * that is running long is a normal thing, and the alternative is completing
   * it early to change one field. `null` clears it back to open-ended.
   *
   * Moving it never touches a baseline: baselines are tied to when tracking
   * started, not to when the event is scheduled to stop.
   */
  readonly endsAt?: string | null;
  readonly prize?: string | null;
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

/**
 * Who is asking, for every ticket operation.
 *
 * `isStaff` is the resolved `TICKET_MANAGE` capability, not a role list — the
 * caller does the lookup once and the service never re-derives it.
 */
export interface TicketActor {
  readonly discordId: string;
  readonly isStaff: boolean;
}

export interface NewTicket {
  readonly guildId: string;
  readonly openerDiscordId: string;
  /** The category row's id. Null when the guild has deleted it since. */
  readonly categoryId: string | null;
  readonly topic?: string | null;
  /** Answers to the category's questions, keyed by question id. */
  readonly answers?: Readonly<Record<string, string>>;
  readonly channelId?: string | null;
}

/**
 * Why a ticket operation was refused.
 *
 * `FORBIDDEN` is the one that matters: the old command took an id and checked
 * neither ownership nor rank, so any member could close anyone's ticket.
 */
export type TicketError =
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "ALREADY_CLOSED" }
  | { readonly kind: "FORBIDDEN" }
  | { readonly kind: "NOT_ELIGIBLE"; readonly reason: string; readonly detail: string };

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
  /**
   * Ban and unban. These are the half of `/ban` that removes a person, as
   * opposed to the half that writes a row about it — the two were separated
   * for long enough that a ban could be logged and never served.
   */
  ban(guildId: string, userId: string, reason: string): Promise<Result<void, GuildEffectError>>;
  unban(guildId: string, userId: string, reason: string): Promise<Result<void, GuildEffectError>>;
  /**
   * Discord's own communication timeout, which is the only server-wide silence
   * Discord offers. `durationSeconds` is clamped to Discord's 28-day ceiling by
   * the implementation rather than refused, since a longer silence is a ban's
   * job and the platform mirror holds the full duration regardless.
   */
  timeout(
    guildId: string,
    userId: string,
    durationSeconds: number,
    reason: string,
  ): Promise<Result<void, GuildEffectError>>;
  /** Lift a timeout early. Succeeds when there was none to lift. */
  untimeout(guildId: string, userId: string, reason: string): Promise<Result<void, GuildEffectError>>;
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
  /**
   * The most recent hand-entered adjustments, newest first.
   *
   * Optional because it is a panel affordance rather than something the engine
   * needs: every other read here is on a path a bot command takes, and a
   * deployment whose XP service predates the page should keep compiling. Absent
   * means "no history to show", which is what the page renders — not zero
   * adjustments, and not an error.
   *
   * Only MANUAL rows. Derived awards are the engine explaining itself and are
   * already visible as a standing; what needs a record is the write that
   * bypassed the rules, and who made it.
   */
  recentAdjustments?(guildId: string, limit: number): Promise<readonly XpAdjustmentDTO[]>;
}

/** One hand-entered adjustment, as the panel lists it. */
export interface XpAdjustmentDTO {
  readonly discordId: string;
  /** Signed: an adjustment may take XP away. */
  readonly amount: number;
  /** Always present in the write path; empty only for a row written before it. */
  readonly reason: string;
  /** Who made it. Null when the meta blob does not name anybody. */
  readonly byDiscordId: string | null;
  /** ISO 8601. A string rather than a Date because this crosses the panel's
   * HTTP boundary, where a Date becomes a string anyway — typing it as one
   * keeps the client from calling Date methods on something that is not one. */
  readonly at: string;
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
  "level",
  "wealth",
  "tenure",
  "skill-average",
  "catacombs",
  "slayer",
  "discord-activity",
  "guild-chat",
  "xp",
  "gexp",
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
  level: "SkyBlock Level",
  wealth: "Wealth",
  tenure: "Tenure",
  "skill-average": "Skill average",
  catacombs: "Catacombs",
  slayer: "Slayer",
  "discord-activity": "Discord activity",
  "guild-chat": "Guild chat",
  xp: "Guild XP",
  gexp: "In-game GEXP",
};

/**
 * Spellings people actually type, mapped to the canonical id. The in-game
 * surface is the reason this exists: `!leaderboard nw` is what someone writes
 * in guild chat, and answering "unknown category" to it would be pedantry.
 */
const LEADERBOARD_ALIASES: Readonly<Record<string, LeaderboardCategory>> = {
  sb: "level",
  sblevel: "level",
  skyblocklevel: "level",
  lvl: "level",
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
  // `level` used to alias to guild XP. It is now a category of its own — the
  // SkyBlock one, which is what someone typing it in guild chat means — and the
  // direct match wins here anyway. `standing` still reaches guild XP.
  standing: "xp",
  guildxp: "xp",
  // Hypixel's own guild experience, which is a different number from the XP
  // this platform awards. `guildxp` above stays pointed at ours because that is
  // what someone reading our own levels means by it.
  gxp: "gexp",
  guildexp: "gexp",
  guildexperience: "gexp",
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
export type LeaderboardSourceKind = "SNAPSHOT" | "TENURE" | "ACTIVITY" | "XP" | "GEXP";

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

/**
 * One category a member appears on, for the profile card.
 *
 * Deliberately not a page: `/me` wants "3rd of 42 on Catacombs" and has no use
 * for the rows around it.
 */
export interface LeaderboardPositionDTO {
  readonly category: LeaderboardCategory;
  readonly label: string;
  readonly format: LeaderboardValueFormat;
  /** 1-based competition rank, tied the same way a page ties. */
  readonly rank: number;
  readonly value: number;
  /** How many members are ranked at all, so a rank can be read in proportion. */
  readonly totalRanked: number;
}

export interface LeaderboardService {
  page(query: LeaderboardQuery): Promise<LeaderboardPageDTO>;
  /**
   * Where one member places across the categories asked for.
   *
   * A category the member is not ranked in is absent rather than reported last:
   * a member with no networth reading has no wealth rank, and inventing one
   * would be a claim about their coins rather than about our data.
   */
  positions(
    guildId: string,
    discordId: string,
    categories?: readonly LeaderboardCategory[],
  ): Promise<readonly LeaderboardPositionDTO[]>;
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

/**
 * Somewhere to say "this member's auto-roles may be stale".
 *
 * Declared here because half a dozen services need it and none of them should
 * have to know it is a Redis set. Implementations must be forgiving: a mark is
 * a promptness hint, and the auto-role reconciler's daily full sweep is what
 * makes the answer correct regardless of whether the mark ever landed. Nothing
 * should fail a user's action because this failed.
 */
export interface RoleDirtyMarker {
  mark(guildId: string, discordIds: readonly string[]): Promise<void>;
}

/**
 * One Discord account, as this server sees it.
 *
 * Deliberately a flat snapshot rather than a live object: the handler layer is
 * transport-agnostic and must never hold a discord.js structure, which would
 * tie a pure function to a gateway connection it cannot have in a test.
 *
 * `member` is null for a user Discord knows but this server does not — someone
 * who has left, or an id typed in from elsewhere. That is a different answer
 * from "no such user", and the card says so.
 */
export interface DiscordUserInfo {
  readonly id: string;
  readonly username: string;
  /** The name the server shows: nickname, then display name, then username. */
  readonly displayName: string;
  readonly bot: boolean;
  readonly avatarUrl: string | null;
  /** Account creation, epoch ms. Derived from the snowflake, so always known. */
  readonly createdAt: number;
  readonly member: DiscordMemberInfo | null;
}

/** The same account's membership of *this* server. */
export interface DiscordMemberInfo {
  readonly nickname: string | null;
  /** Epoch ms. Null when Discord itself has no record — rare, but it happens. */
  readonly joinedAt: number | null;
  readonly boostingSince: number | null;
  /** Highest first, `@everyone` excluded — it is on everybody and says nothing. */
  readonly roleIds: readonly string[];
  /** Timed out until, epoch ms; null when not. */
  readonly timedOutUntil: number | null;
}

/** The server itself, for `/serverinfo`. */
export interface DiscordGuildInfo {
  readonly id: string;
  readonly name: string;
  readonly iconUrl: string | null;
  readonly createdAt: number;
  readonly ownerId: string | null;
  /**
   * Counts rather than lists. A card cannot show 900 members, and asking the
   * gateway to page every one of them to print a number it already has is the
   * kind of request that gets a bot rate-limited.
   */
  readonly memberCount: number;
  readonly channelCount: number;
  readonly roleCount: number;
  readonly emojiCount: number;
  readonly boostTier: number;
  readonly boostCount: number;
}

/**
 * What the member bot can see of the Discord server it is sitting in.
 *
 * A port on the handler layer because only a surface with a gateway connection
 * can answer it: the in-game bridge and the panel wire the same handlers and
 * have no Discord client, so this is optional and its commands say "not here"
 * rather than inventing an answer.
 *
 * Read-only by construction. Handing member commands a way to *look up* a
 * member is not the same authority as handing them a way to change one, and
 * keeping the port to two questions is what makes that obvious at the wiring.
 */
export interface DiscordDirectory {
  /** Null when Discord has no such user at all. */
  lookupUser(guildId: string, userId: string): Promise<DiscordUserInfo | null>;
  /** Null when the bot is not in that server — a fresh install mid-restart. */
  guildInfo(guildId: string): Promise<DiscordGuildInfo | null>;
}

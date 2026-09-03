/**
 * Data transfer objects exchanged across service boundaries. Representative set
 * for the scaffold — expanded as features land. Fields that may be unknown are
 * `T | null` (never silently 0), per HYPIXEL_DATA_LAYER.md.
 */
import type {
  ApplicationStatus,
  CommandSurface,
  EventStatus,
  EventType,
  InfractionSeverity,
  InfractionType,
  LFGActivity,
  LFGStatus,
  LinkStatus,
  MemberRole,
  MemberStatus,
  AchievementCategory,
  AchievementTier,
  MilestoneType,
  ModActionType,
  PermStatus,
  RaidSensitivity,
  RSVPState,
  SkyblockGameMode,
  SnapshotMilestoneMetric,
  TicketStatus,
  WordAction,
  WordMatchType,
} from "./enums.js";
import type { ViewColor } from "./views.js";

/** A resolved Discord ↔ Minecraft link. */
export interface LinkedIdentityDTO {
  readonly discordId: string;
  readonly minecraftUuid: string;
  readonly ign: string;
  readonly status: LinkStatus;
  readonly primary: boolean;
  readonly verifiedAt: string | null;
  /**
   * Set by `/link` only, and only when the immediate role pass could not
   * confirm Hypixel guild membership — so any guild-gated role is still
   * outstanding and will be applied by the retry or the next sweep.
   *
   * Optional because it is a property of one *act* of linking rather than of
   * the link: every read path omits it, and its absence means nothing was left
   * hanging rather than "unknown".
   */
  readonly rolesPending?: boolean;
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

/** One guild rank and the members of it currently online. */
export interface RosterRankDTO {
  /** The rank as Hypixel names it — "Guild Master", "Officer", "Member", … */
  readonly rank: string;
  readonly members: readonly string[];
}

/**
 * Who is online in the Hypixel guild right now.
 *
 * Read from the in-game bridge's own `/g online`, not from the Hypixel API:
 * the guild endpoint lists members but says nothing about presence, and
 * answering that with a `/status` call per member would be a hundred requests
 * for one command.
 *
 * `online` and `total` are the counts Hypixel itself reported rather than
 * derived from `ranks`, so a roster clipped by a slow chat window still shows
 * an honest headline number.
 */
export interface GuildRosterDTO {
  readonly guildName: string | null;
  readonly ranks: readonly RosterRankDTO[];
  readonly online: number | null;
  readonly total: number | null;
  readonly fetchedAt: string;
}

/** Selected Skyblock profile summary. */
export interface ProfileSummaryDTO {
  readonly profileId: string;
  readonly cuteName: string | null;
  readonly gameMode: SkyblockGameMode;
  /**
   * SkyBlock Level, fractional. The headline number on the profile card and the
   * one metric that moves for everyone: skills plateau, dungeons are a
   * sub-community, and networth swings with the market, but levelling advances
   * for anyone who plays at all. The fraction is progress within the current
   * level and is kept for the same reason catacombs keeps its own — it is real
   * information, and rounding it away makes a week of play look like nothing.
   */
  readonly skyblockLevel: number | null;
  readonly skillAverage: number | null;
  readonly catacombsLevel: number | null;
  /**
   * Total slayer XP across every boss. Already parsed for the Senither weight,
   * so carrying it costs nothing and saves the snapshot job a second read.
   */
  readonly slayerXp: number | null;
  readonly senitherWeight: number | null;
  /**
   * The last bestiary milestone Hypixel says the profile claimed.
   *
   * Repeated rather than derived. A bestiary "level" is a function of kill
   * counts against bracket tables that move with every mob patch, and a number
   * we compute from a stale table is confidently wrong where this one is merely
   * coarse. Null when the profile has never claimed one, or hides the field.
   */
  readonly bestiaryMilestone: number | null;
}

/**
 * One skill's standing. `level` is null when the profile hides its skill API —
 * a hidden skill is unknown, not level 0 (HYPIXEL_DATA_LAYER.md §5).
 */
export interface SkillDTO {
  readonly name: string;
  readonly level: number | null;
  readonly maxLevel: number;
  readonly experience: number | null;
  /** XP still needed for the next level; null at cap or when unknown. */
  readonly xpToNext: number | null;
  /** 0–1 through the current level, for progress bars. Null when unknown. */
  readonly progress: number | null;
}

export interface SkillsDTO {
  readonly skills: readonly SkillDTO[];
  /**
   * Mean level across the skills that count toward it — cosmetic skills
   * (Runecrafting, Social, Carpentry) are excluded, as the game does.
   */
  readonly average: number | null;
  /** True when the profile's skill API is off, so everything above is unknown. */
  readonly apiDisabled: boolean;
}

export interface SlayerBossDTO {
  readonly boss: string;
  readonly experience: number;
  readonly tier: number;
  readonly maxTier: number;
  /** Kill counts keyed by tier ("1".."5"), as the profile reports them. */
  readonly kills: Readonly<Record<string, number>>;
}

export interface SlayersDTO {
  readonly bosses: readonly SlayerBossDTO[];
  readonly totalExperience: number;
}

export interface DungeonClassDTO {
  readonly name: string;
  readonly level: number;
  readonly experience: number;
}

export interface DungeonFloorDTO {
  readonly floor: string;
  readonly completions: number;
  /** Fastest S+ clear in ms, or null if never cleared S+. */
  readonly fastestSPlusMs: number | null;
}

export interface DungeonsDTO {
  readonly catacombsLevel: number | null;
  readonly catacombsExperience: number | null;
  /** XP still needed for the next Catacombs level; null at cap or unknown. */
  readonly catacombsXpToNext: number | null;
  /** 0–1 through the current Catacombs level. Null when the level is unknown. */
  readonly catacombsProgress: number | null;
  readonly selectedClass: string | null;
  readonly classAverage: number | null;
  readonly classes: readonly DungeonClassDTO[];
  readonly floors: readonly DungeonFloorDTO[];
  readonly masterFloors: readonly DungeonFloorDTO[];
  /** True when the profile has no dungeon data at all. */
  readonly played: boolean;
}

/**
 * Networth breakdown. `exact` is true ONLY when every value-bearing section was
 * readable; otherwise `total` is a lower-bound estimate and `missing` lists the
 * hidden sections (partial networth is never presented as exact).
 */
export interface NetworthItemDTO {
  readonly name: string;
  readonly price: number;
}

export interface NetworthDTO {
  readonly total: number | null;
  readonly exact: boolean;
  readonly missing: readonly string[];
  readonly breakdown: Readonly<Record<string, number>>;
  /**
   * The few most valuable items in each category, keyed as `breakdown` is.
   * Empty when the valuation engine reports totals only — an absent category
   * here never means the category is empty.
   */
  readonly topItems: Readonly<Record<string, readonly NetworthItemDTO[]>>;
}

/** One accessory the member holds, with the magical power it actually contributes. */
export interface AccessoryDTO {
  readonly id: string;
  readonly name: string;
  readonly rarity: string;
  readonly magicalPower: number;
  readonly recombobulated: boolean;
}

/** A notable accessory the member is missing, or could upgrade into. */
export interface AccessorySuggestionDTO {
  readonly id: string;
  readonly name: string;
  readonly rarity: string;
  readonly why: string;
  /** The lesser accessory this would replace, when it is an upgrade rather than a gap. */
  readonly replaces: string | null;
  /** Lowest BIN in coins, or null when the item is unpriced or the sweep is cold. */
  readonly estimatedCost: number | null;
}

/**
 * `/missing` — accessory standing. `magicalPower` is null when the talisman bag
 * could not be read: an unreadable bag is unknown, not zero, and every list is
 * then empty rather than claiming the member owns nothing.
 */
export interface AccessoryReportDTO {
  readonly magicalPower: number | null;
  readonly tuning: string | null;
  readonly owned: readonly AccessoryDTO[];
  readonly missing: readonly AccessorySuggestionDTO[];
  readonly upgradeable: readonly AccessorySuggestionDTO[];
  /** Held alongside a strictly better family member, so contributing nothing. */
  readonly redundant: readonly AccessoryDTO[];
  readonly apiDisabled: boolean;
  /** Scope caveat for the embed footer — the catalog is notable, not exhaustive. */
  readonly note: string;
}

export type AdvicePriority = "HIGH" | "MEDIUM" | "LOW";

export interface AdviceItemDTO {
  readonly title: string;
  readonly detail: string;
  readonly priority: AdvicePriority;
  readonly category: string;
  /** Coins, when the suggestion names a purchasable item; null otherwise. */
  readonly estimatedCost: number | null;
}

/**
 * `/nextupgrade` and `/whatnext`. `generic` is true when profile data was
 * unavailable and the advice is the same anyone would get — the embed says so,
 * rather than presenting boilerplate as if it were personalized.
 */
export interface AdviceDTO {
  readonly focus: string;
  readonly items: readonly AdviceItemDTO[];
  readonly generic: boolean;
}

export interface PriceDTO {
  readonly itemId: string;
  readonly bazaarInstantSell: number | null;
  readonly bazaarInstantBuy: number | null;
  readonly lowestBin: number | null;
  readonly estimatedValue: number | null;
}

/** One item as the catalog knows it — what `/price` autocomplete offers. */
export interface ItemMatchDTO {
  readonly itemId: string;
  readonly displayName: string;
}

export interface BazaarQuoteDTO {
  readonly itemId: string;
  readonly displayName: string | null;
  /** Coins to buy one unit right now; null when nobody is selling. */
  readonly instantBuy: number | null;
  /** Coins received selling one unit right now; null when nobody is buying. */
  readonly instantSell: number | null;
  readonly buyVolume: number | null;
  readonly sellVolume: number | null;
  /** Buy minus sell. Null when either side is unknown — a one-sided book has
   *  no spread, and reporting the known side as the spread would mislead. */
  readonly spread: number | null;
}

export interface LowestBinDTO {
  readonly itemId: string;
  readonly displayName: string | null;
  /** Null when no BIN is currently listed, which is different from a price of 0. */
  readonly price: number | null;
  /** How many BINs backed this reading, so a lone outlier is visible as such. */
  readonly listings: number;
}

export interface AuctionListingDTO {
  readonly auctionId: string;
  readonly itemName: string | null;
  readonly price: number | null;
  readonly bin: boolean;
  /** ISO timestamp, or null when the end time is unreadable. */
  readonly endsAt: string | null;
  /** Highest bid so far; null when nobody has bid. */
  readonly highestBid: number | null;
  /** True once the seller has collected the coins or the item back. */
  readonly claimed: boolean;
}

/**
 * A player's auction house standing.
 *
 * `listings` is every auction, unsplit — `/auctions item:` uses it, and it is
 * what the DTO has always carried. The three buckets below classify a *player's*
 * auctions, which is a different question: what is still running, what sold and
 * is waiting to be collected, and what came back unsold.
 */
export interface AuctionsDTO {
  readonly listings: readonly AuctionListingDTO[];
  /** Still running. */
  readonly active: readonly AuctionListingDTO[];
  /** Ended with a winning bid, coins not yet collected. */
  readonly unclaimed: readonly AuctionListingDTO[];
  /** Ended with no bids — the item itself is waiting to be taken back. */
  readonly expired: readonly AuctionListingDTO[];
  /**
   * Coins sitting in `unclaimed`. Null when nothing sold, which is different
   * from a sale worth nothing.
   */
  readonly claimValue: number | null;
}

/** How far back a history series reaches. Three, because a chart needs a scale. */
export type MarketRange = "DAY" | "WEEK" | "MONTH";

/**
 * One bucket of a price series.
 *
 * Every field is nullable because the upstream buckets are: a quiet hour has no
 * trades, and a bucket with no trades has no price. Rendering that as zero would
 * put a cliff in the chart where nothing happened.
 */
export interface MarketPointDTO {
  /** ISO timestamp of the bucket start. */
  readonly at: string;
  readonly min: number | null;
  readonly max: number | null;
  readonly avg: number | null;
  readonly volume: number | null;
}

/**
 * A price series, as far as we could read it.
 *
 * `points` may be empty — a brand-new item has no past, and an item nobody has
 * ever traded has no prices to have a past of. That is a real answer, and it is
 * distinct from the history source being unreachable, which is reported as
 * `null` by the service that produces this.
 */
export interface MarketHistoryDTO {
  readonly itemId: string;
  readonly range: MarketRange;
  readonly points: readonly MarketPointDTO[];
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
  /**
   * What staff call this case: `CASE-DrJay-a1b2c3d4-2`.
   *
   * Always present, because every reader needs something to show: rows issued
   * before the scheme existed fall back to their cuid, which is what they were
   * always called. `id` remains the key every write addresses.
   */
  readonly caseCode: string;
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
  /**
   * Whether the punishment this row describes was actually carried out.
   *
   * Separate from `active` on purpose: `active` says the platform still
   * *intends* to enforce, and this says whether the enforcement ever landed.
   * A ban written to the log while Discord refused the API call is
   * `active: true, enforcement: "FAILED"` — the state that used to be
   * indistinguishable from a successful ban, and the reason a member could be
   * "banned" in the audit log and still sitting in the server.
   */
  readonly enforcement: EnforcementStatus;
  /** Why enforcement failed, verbatim, for the staff alert and the audit page. */
  readonly enforcementDetail: string | null;
  /**
   * How many times the platform has tried to carry this out.
   *
   * The number is what separates "still pending" from "truly failed". A case on
   * its first attempt and a case on its last read identically without it, and
   * staff were being alerted about the first as though it were the second.
   */
  readonly enforcementAttempts: number;
  /** When the last attempt was made. Null only for rows older than the counter. */
  readonly enforcementAt: string | null;
  /**
   * When a person last corrected this case, or null while it stands as issued.
   *
   * Not "when the row last changed": the service stamping an enforcement
   * verdict is it finishing its own work, and a case that reads as edited
   * because the platform did its job would make every real edit unfindable.
   */
  readonly updatedAt: string | null;
  /** Who made that edit. An edit with no author is a rumour. */
  readonly editedByDiscordId: string | null;
  /**
   * When the case was voided, or null. Soft, and deliberately: the record of a
   * punishment that should not have happened is worth keeping, and deleting the
   * row would dangle its id in every mod-log card that already quoted it.
   */
  readonly voidedAt: string | null;
  readonly voidReason: string | null;
}

/**
 * One attempt on one surface, as the panel shows it.
 *
 * Append-only, so a case that took three tries can be read as a story rather
 * than as its last line. `outcome` is the surface's own verdict and `detail` is
 * whatever it said in words — usually the Hypixel guild-chat line.
 */
export interface EnforcementAttemptDTO {
  readonly attempt: number;
  readonly surface: "DISCORD" | "GAME";
  readonly outcome: string;
  readonly detail: string | null;
  readonly createdAt: string;
}

/**
 * The life of an enforcement attempt.
 *
 * `NOT_REQUIRED` is the honest answer for a note or a warning: nothing was
 * supposed to reach Discord, so neither "confirmed" nor "failed" would be true.
 * `PENDING` exists for the window between writing the row and hearing back, and
 * is what a row is left on if the process dies mid-action — which is itself
 * worth seeing rather than assuming.
 */
export type EnforcementStatus = "NOT_REQUIRED" | "PENDING" | "CONFIRMED" | "FAILED";

/**
 * What a member is told about their own record on `/me`.
 *
 * Deliberately smaller than the audit row it is derived from: no ids, no actor,
 * no history of served punishments. A member asking "where do I stand" is
 * asking about now — what is being enforced, how many warnings still count, and
 * what the next one would cost. Everything else is staff's view of them, and
 * `/infractions` is where staff read it.
 */
export interface MemberRecordDTO {
  /** Warnings inside the escalation window — the count the ladder acts on. */
  readonly warnings: number;
  /** How far back that count reaches, so the number can be read honestly. */
  readonly windowDays: number;
  /** Punishments being enforced right now, soonest to end first. */
  readonly inForce: readonly MemberPunishmentDTO[];
  /**
   * The rung the *next* warning would land on, or null when the ladder is off,
   * or when the next warning falls between rungs. Shown because a warning that
   * quietly moves someone one step from a ban is not much of a warning.
   */
  readonly nextEscalation: MemberEscalationDTO | null;
}

export interface MemberPunishmentDTO {
  readonly type: ModActionType;
  /**
   * The reason staff typed. Shown to the member it is about: a punishment
   * nobody explains is one they can only guess how to avoid repeating.
   */
  readonly reason: string;
  /** Null means it does not expire on its own. */
  readonly expiresAt: string | null;
}

export interface MemberEscalationDTO {
  readonly warns: number;
  readonly action: Extract<ModActionType, "MUTE" | "BAN">;
  readonly durationSeconds: number | null;
}

/**
 * A member's placings in this guild's tracked events, for their own card.
 *
 * Only *tracked* events count. An event with no scored metric has no order to
 * come first in, so counting attendance at one as a podium would quietly turn
 * "turned up" into "won".
 */
export interface EventPodiumDTO {
  /** Events this member is recorded as having attended, tracked or not. */
  readonly attended: number;
  readonly gold: number;
  readonly silver: number;
  readonly bronze: number;
  /** Newest first, capped by the caller. Podium finishes only. */
  readonly recent: readonly EventPlacingDTO[];
}

export interface EventPlacingDTO {
  readonly eventTitle: string;
  /** The metric that was raced, as the event recorded it. */
  readonly metric: string;
  /** 1, 2 or 3. Ties share a place, exactly as a leaderboard does. */
  readonly place: number;
  /** How much the member gained. Rendered by the surface, never here. */
  readonly delta: number;
  /** When the event ended, ISO-8601. Null for one still running. */
  readonly at: string | null;
}

export interface ApplicationDTO {
  readonly id: string;
  readonly guildId: string;
  readonly applicantDiscordId: string;
  readonly status: ApplicationStatus;
  readonly submittedAt: string | null;
  readonly reviewerDiscordId?: string | null;
  readonly decisionReason?: string | null;
  readonly decidedAt?: string | null;
}

export interface EventDTO {
  readonly id: string;
  readonly guildId: string;
  readonly title: string;
  readonly status: EventStatus;
  readonly startsAt: string;
  readonly capacity: number | null;
  readonly rsvpCount: number;
  readonly description?: string | null;
  readonly type?: EventType;
  readonly endsAt?: string | null;
  readonly hostDiscordId?: string | null;
  /**
   * What the winner gets, as free text. Informational everywhere it appears —
   * nothing on this platform pays it out, and awarding one is a staff action
   * through the manual-adjustment ledger.
   */
  readonly prize?: string | null;
  /** Metric keys this event scores. Empty for an event that is not a contest. */
  readonly trackedMetrics?: readonly string[];
  readonly pollIntervalMinutes?: number;
}

/** One member's response, for `/attendance` and the event roster. */
export interface RsvpEntryDTO {
  readonly discordId: string;
  readonly state: RSVPState;
  readonly respondedAt: string;
}

/**
 * One person who turned up. `TRACKED` means the poller scored them during the
 * event; `MARKED` means somebody said so afterwards, which is the only way an
 * unlinked member or a walk-in is ever recorded.
 */
export interface AttendedEntryDTO {
  readonly discordId: string;
  readonly source: "TRACKED" | "MARKED";
  readonly recordedBy: string | null;
  readonly recordedAt: string;
}

/**
 * `/attendance` — who answered an event and how, and who actually came. Counts
 * are computed from the roster rather than stored, so they cannot drift from the
 * entries beneath them.
 *
 * `attended` is deliberately not a subset of `going`: somebody who never
 * answered can still walk in, and somebody who said yes can still not show.
 */
export interface AttendanceDTO {
  readonly event: EventDTO;
  readonly going: readonly RsvpEntryDTO[];
  readonly maybe: readonly RsvpEntryDTO[];
  readonly declined: readonly RsvpEntryDTO[];
  readonly waitlist: readonly RsvpEntryDTO[];
  readonly attended: readonly AttendedEntryDTO[];
}

/**
 * `/lfg` and `/runs` — an open call for a group. `slotsFilled` counts the author,
 * so a fresh 5-slot post shows 1/5 rather than 0/5.
 */
export interface LFGPostDTO {
  readonly id: string;
  readonly guildId: string;
  readonly authorDiscordId: string;
  readonly activity: LFGActivity;
  readonly details: string | null;
  readonly slotsTotal: number;
  readonly slotsFilled: number;
  readonly status: LFGStatus;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  /** Everyone currently holding a slot, author first. */
  readonly members: readonly string[];
  /** Short headline for the embed, or null when the author gave none. */
  readonly title: string | null;
  /**
   * Where this post was published. Null until it lands — publishing can fail,
   * and a post with no message is recoverable in a way that the reverse is not.
   */
  readonly channelId: string | null;
  readonly messageId: string | null;
  /** The perm the roster was autofilled from, if any. */
  readonly permGroupId: string | null;
  readonly closedAt: string | null;
  readonly closedByDiscordId: string | null;
}

/**
 * One seat in a perm.
 *
 * `ign` is the identity that always exists; `discordId` and `uuid` are filled in
 * where we happen to know them. A perm is formed in-game, and most of a Hypixel
 * guild has never linked a Discord account — requiring one would make the
 * feature unusable for the people it is for.
 */
export interface PermMemberDTO {
  readonly ign: string;
  readonly role: string;
  readonly slot: number;
  readonly discordId: string | null;
  readonly uuid: string | null;
  /**
   * Whether the member is still in the in-game guild, per the 6h member cache.
   * Null when the cache has no reading at all (cold start), which is different
   * from a confident "they left" and is rendered differently.
   */
  readonly inGuild: boolean | null;
  /** From the newest ProfileSnapshot, when one exists. No live Hypixel call. */
  readonly catacombsLevel: number | null;
  readonly skillAverage: number | null;
  /**
   * Their level in the class this seat is played as — healer level for the
   * healer, tank level for the tank.
   *
   * Catacombs level says how much dungeon somebody has run; it says nothing
   * about whether they have run it in the class they are sitting in. A cata 42
   * player seated as healer with healer 14 is the single most useful thing a
   * party roster can tell you, and until this field existed the card could not.
   *
   * Null for a seat whose activity has no classes (Kuudra jobs, a fishing
   * lobby), for an unlinked player, and for a class level we have never read.
   */
  readonly roleLevel: number | null;
}

/** `/perm info` — a standing party and its roster. */
export interface PermGroupDTO {
  readonly id: string;
  readonly guildId: string;
  readonly ownerDiscordId: string;
  readonly name: string;
  readonly activity: LFGActivity;
  readonly status: PermStatus;
  readonly isDefault: boolean;
  readonly notes: string | null;
  readonly createdAt: string;
  /** Seats in slot order. Empty on a freshly created perm. */
  readonly members: readonly PermMemberDTO[];
  /** Party size for the activity — how many seats the roster may hold. */
  readonly capacity: number;
}

export interface TicketDTO {
  readonly id: string;
  readonly guildId: string;
  /** Per-guild sequence. What staff and members call the ticket out loud. */
  readonly number: number;
  readonly openerDiscordId: string;
  readonly assigneeDiscordId: string | null;
  /** Null when the category it was opened under has since been deleted. */
  readonly categoryId: string | null;
  readonly categoryKey: string | null;
  readonly categoryName: string | null;
  readonly status: TicketStatus;
  readonly channelId: string | null;
  readonly subject: string | null;
  readonly topic: string | null;
  readonly claimedByDiscordId: string | null;
  readonly claimedAt: string | null;
  readonly closeRequestedByDiscordId: string | null;
  readonly closeRequestedAt: string | null;
  readonly lastMessageAt: string | null;
  /** Null until staff answer. Rendered as "—", never as zero. */
  readonly firstStaffReplyAt: string | null;
  readonly feedbackRating: number | null;
  readonly transcriptReady: boolean;
  readonly closeReason: string | null;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

/**
 * One question a category asks before the ticket opens.
 *
 * Rendered as a Discord modal, which takes at most five inputs — that cap is
 * why `TicketCategoryDTO.questions` is bounded rather than open-ended.
 */
export interface TicketQuestionDTO {
  readonly id: string;
  readonly label: string;
  readonly placeholder: string | null;
  readonly style: "SHORT" | "PARAGRAPH";
  readonly required: boolean;
  readonly maxLength: number | null;
}

/**
 * One kind of ticket a member can open.
 *
 * `key` is the stable identifier the panel button carries and a guild never
 * edits; `name` beside it is free text an admin can reword at will. Everything
 * else is per-category on purpose — the settings that actually differ between a
 * staff application and a ban appeal are exactly these.
 */
export interface TicketCategoryDTO {
  readonly id: string;
  readonly guildId: string;
  readonly key: string;
  readonly name: string;
  /** Shown in a select menu, where Discord caps the description at 100 chars. */
  readonly description: string;
  readonly emoji: string | null;
  readonly position: number;
  readonly enabled: boolean;
  /** `{num}`, `{name}` and `{nick}` are expanded when the channel is created. */
  readonly channelNameTemplate: string;
  readonly parentChannelId: string | null;
  readonly staffRoleIds: readonly string[];
  /** The member needs *all* of these, not any. */
  readonly requiredRoleIds: readonly string[];
  readonly pingRoleIds: readonly string[];
  readonly openingMessage: string;
  readonly image: string | null;
  readonly claiming: boolean;
  readonly cooldownSeconds: number | null;
  readonly memberLimit: number;
  readonly totalLimit: number;
  readonly slowModeSeconds: number | null;
  readonly requireTopic: boolean;
  /** At most five. Questions take precedence over `requireTopic` when both are set. */
  readonly questions: readonly TicketQuestionDTO[];
}

/** What the panel may set. `key` identifies the category and is never edited. */
export interface TicketCategoryInput {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly emoji: string | null;
  readonly position: number;
  readonly enabled: boolean;
  readonly channelNameTemplate: string;
  readonly parentChannelId: string | null;
  readonly staffRoleIds: readonly string[];
  readonly requiredRoleIds: readonly string[];
  readonly pingRoleIds: readonly string[];
  readonly openingMessage: string;
  readonly image: string | null;
  readonly claiming: boolean;
  readonly cooldownSeconds: number | null;
  readonly memberLimit: number;
  readonly totalLimit: number;
  readonly slowModeSeconds: number | null;
  readonly requireTopic: boolean;
  readonly questions: readonly TicketQuestionDTO[];
}

/** One open/close window, in the guild's timezone. */
export interface TicketWorkingHoursDayDTO {
  readonly open: string;
  readonly close: string;
}

/** Keyed `"0"`–`"6"`, Sunday first. An absent day means closed all day. */
export type TicketWorkingHoursDTO = Readonly<Record<string, TicketWorkingHoursDayDTO>>;

/** Per-guild ticket behaviour. */
export interface TicketSettingsDTO {
  readonly guildId: string;
  readonly archiveEnabled: boolean;
  readonly logChannelId: string | null;
  readonly blocklistRoleIds: readonly string[];
  readonly primaryColor: ViewColor;
  readonly successColor: ViewColor;
  readonly errorColor: ViewColor;
  readonly footer: string | null;
  /** Silence after which a ticket is stale. Null disables the clock. */
  readonly staleAfterMinutes: number | null;
  readonly autoCloseAfterMinutes: number;
  readonly closeButton: boolean;
  readonly claimButton: boolean;
  readonly workingHours: TicketWorkingHoursDTO;
  readonly updatedAt: string | null;
}

/** What the panel may set. `guildId` comes from the route, not the body. */
export type TicketSettingsInput = Omit<TicketSettingsDTO, "guildId" | "updatedAt">;

export type TicketPanelStyle = "BUTTONS" | "SELECT";

/**
 * A posted message members open tickets from.
 *
 * `channelId`/`messageId` record where it was last posted so a re-publish edits
 * that message instead of leaving a stale panel behind. Both null until posted.
 */
export interface TicketPanelDTO {
  readonly id: string;
  readonly guildId: string;
  readonly name: string;
  readonly channelId: string | null;
  readonly messageId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly image: string | null;
  readonly thumbnail: string | null;
  readonly style: TicketPanelStyle;
  /** Category keys, in the order they appear on the panel. */
  readonly categoryKeys: readonly string[];
  readonly updatedAt: string | null;
}

/** What the panel may set. Publishing is a separate, explicit action. */
export type TicketPanelInput = Omit<TicketPanelDTO, "id" | "guildId" | "messageId" | "updatedAt">;

/** A canned reply, optionally auto-sent when a message matches its pattern. */
export interface TicketTagDTO {
  readonly id: string;
  readonly guildId: string;
  readonly name: string;
  readonly content: string;
  readonly autoPattern: string | null;
  /**
   * Where `autoPattern` may fire. `TICKET` for a staff canned reply, `SERVER`
   * for an autoresponder in open channels, `ANY` for both.
   *
   * Named by scope rather than by a pair of booleans because the three states
   * are the whole space, and two booleans would admit a fourth that means
   * "compiled, enabled, and fires nowhere".
   */
  readonly scope: TagScope;
  readonly enabled: boolean;
}

/** @see TicketTagDTO.scope */
export type TagScope = "TICKET" | "SERVER" | "ANY";

/** For an exhaustive selector; the panel renders them in this order. */
export const TAG_SCOPES: readonly TagScope[] = ["TICKET", "SERVER", "ANY"];

/** What the panel may set. `name` identifies the tag and is never edited. */
export type TicketTagInput = Omit<TicketTagDTO, "id" | "guildId">;

/** One attachment on a captured message. */
export interface TicketAttachmentDTO {
  readonly name: string;
  readonly size: number;
  readonly contentType: string | null;
  /**
   * Discord signs CDN links now, so this expires. The transcript records what
   * was attached rather than pretending to archive the bytes.
   */
  readonly url: string;
}

/** One captured message, as the transcript viewer renders it. */
export interface TicketMessageDTO {
  readonly id: string;
  readonly authorDiscordId: string;
  readonly authorTag: string;
  readonly content: string;
  readonly attachments: readonly TicketAttachmentDTO[];
  readonly editedAt: string | null;
  /** Set rather than the row being removed: a transcript that silently loses a deleted message is worse than none. */
  readonly deletedAt: string | null;
  readonly createdAt: string;
}

export interface MilestoneDTO {
  readonly id: string;
  readonly minecraftUuid: string;
  readonly type: MilestoneType;
  readonly metric: string;
  readonly thresholdValue: number;
  readonly achievedAt: string;
  /** The definition's label where one recognised it, else null. */
  readonly label: string | null;
}

/**
 * A recorded milestone waiting to be posted.
 *
 * Carries the name and mention the announcement needs rather than ids to
 * resolve: the sweep runs minutes to hours after detection, and re-deriving a
 * member's IGN then would credit the wrong name to anyone who has since changed
 * it. `discordId` is null for an account with no verified link — still worth
 * announcing, just without a mention.
 */
/**
 * A level a member has climbed to, waiting to be announced.
 *
 * `fromLevel` is carried rather than assumed to be `toLevel - 1`: a milestone
 * award or a backfilled day can move somebody two levels at once, and a card
 * that said "reached level 7" when they went from 5 to 7 would be quietly
 * wrong about the thing it exists to celebrate.
 */
/** A reminder a member set for themselves, as every surface sees it. */
export interface ReminderDTO {
  readonly id: string;
  readonly guildId: string;
  readonly discordId: string;
  readonly channelId: string;
  readonly text: string;
  /** ISO. When it is meant to fire, not when it was set. */
  readonly dueAt: string;
}

export interface PendingLevelUpDTO {
  readonly id: string;
  readonly guildId: string;
  readonly discordId: string;
  readonly fromLevel: number;
  readonly toLevel: number;
  readonly totalXp: number;
  readonly achievedAt: string;
}

export interface PendingMilestoneDTO {
  readonly id: string;
  readonly guildId: string;
  readonly discordId: string | null;
  readonly ign: string | null;
  readonly label: string;
  readonly type: MilestoneType;
  readonly metric: string;
  readonly thresholdValue: number;
  readonly achievedAt: string;
}

/**
 * A guild-configured milestone threshold, as the panel edits it.
 *
 * `source` distinguishes the two rows the panel shows in one list: a `DEFAULT`
 * is not stored anywhere and has no id, so the panel's edit action on one is a
 * *create* that shadows it by key. Collapsing that distinction would let the
 * panel issue an update against an id that does not exist.
 */
export interface MilestoneDefinitionDTO {
  readonly id: string | null;
  readonly guildId: string;
  readonly key: string;
  readonly label: string;
  readonly description: string | null;
  readonly type: MilestoneType;
  readonly metric: string;
  readonly threshold: number;
  readonly xpReward: number;
  readonly announce: boolean;
  readonly enabled: boolean;
  readonly tier: AchievementTier;
  /** A single emoji shown before the label; null falls back to the tier's. */
  readonly icon: string | null;
  /** Unlisted while locked. Detection, announcement and XP are unaffected. */
  readonly hidden: boolean;
  readonly source: "DEFAULT" | "GUILD";
}

/** What the panel may set. `key` identifies the definition and is never edited. */
export interface MilestoneDefinitionInput {
  readonly key: string;
  readonly label: string;
  readonly description?: string | null;
  readonly type: MilestoneType;
  readonly metric: string;
  readonly threshold: number;
  readonly xpReward: number;
  readonly announce: boolean;
  readonly enabled: boolean;
  /** Optional so a client written before tiers existed still stores a definition. */
  readonly tier?: AchievementTier;
  readonly icon?: string | null;
  readonly hidden?: boolean;
}

/**
 * One reading of every metric a milestone can be defined against.
 *
 * Keys match `SNAPSHOT_MILESTONE_METRICS` exactly so a definition's `metric`
 * indexes this directly — the alternative, a switch per metric, is one place to
 * forget when a metric is added.
 *
 * The widened readings are optional rather than nullable-required. A snapshot
 * captured before they existed genuinely does not carry them, and `undefined`
 * says that, where a `null` we invented at read time would claim the profile
 * was read and found empty.
 */
export interface SnapshotMetricsDTO {
  /** ISO-8601 of the capture, for "as of" in the reply. */
  readonly capturedAt: string;
  readonly skyblockLevel: number | null;
  readonly networth: number | null;
  readonly skillAverage: number | null;
  readonly catacombsLevel: number | null;
  readonly slayerXp: number | null;
  readonly senitherWeight: number | null;
  readonly classHealer?: number | null;
  readonly classMage?: number | null;
  readonly classBerserk?: number | null;
  readonly classArcher?: number | null;
  readonly classTank?: number | null;
  readonly slayerZombie?: number | null;
  readonly slayerSpider?: number | null;
  readonly slayerWolf?: number | null;
  readonly slayerEnderman?: number | null;
  readonly slayerBlaze?: number | null;
  readonly slayerVampire?: number | null;
  readonly bestiaryMilestone?: number | null;
  readonly skillFarming?: number | null;
  readonly skillMining?: number | null;
  readonly skillCombat?: number | null;
  readonly skillForaging?: number | null;
  readonly skillFishing?: number | null;
  readonly skillEnchanting?: number | null;
  readonly skillAlchemy?: number | null;
  readonly skillTaming?: number | null;
  readonly skillHunting?: number | null;
  readonly skillCarpentry?: number | null;
  readonly fairySouls?: number | null;
  readonly museumDonations?: number | null;
  readonly petScore?: number | null;
  readonly minionSlots?: number | null;
  readonly essence?: number | null;
}

/**
 * One freshly-read value for every metric the tracker stores.
 *
 * The difference from `SnapshotMetricsDTO` is direction: that one is a row read
 * back out of the database, where a metric can be absent because the row predates
 * it. This is a reading taken now, so every metric in the catalog is present —
 * `null` where the profile did not expose it, never missing. Deriving both from
 * `SnapshotMilestoneMetric` is what keeps "what we can store" and "what we
 * actually capture" from drifting apart, which is exactly what happened while the
 * capture list was hand-written in the workers app.
 */
export type TrackedReadingDTO = Readonly<Record<SnapshotMilestoneMetric, number | null>> & {
  /** The profile the reading came from, so the caller need not resolve it twice. */
  readonly profileId: string;
};

/**
 * One reading of every metric this platform counts about a member itself.
 *
 * Guild-scoped, unlike a snapshot: a member of two guilds has two tenures and
 * two XP totals, and there is no account-wide answer to give. That is why these
 * do not live on `ProfileSnapshot` — see `COMMUNITY_MILESTONE_METRICS` for why
 * they are also never detected as crossings.
 */
export interface CommunityMetricsDTO {
  readonly eventsAttended: number | null;
  readonly eventPodiums: number | null;
  readonly guildTenureDays: number | null;
  readonly guildXp: number | null;
}

/**
 * One recognised achievement, seen from a member's side.
 *
 * The same shape carries an earned and an unearned one: what a member wants
 * from `/milestones` is a single list of what the guild rewards and where they
 * stand against it, and splitting the two into different types would force the
 * renderer to say the same thing twice. `achievedAt` is the discriminator.
 *
 * `current` is null when the metric has never been measured for this member —
 * distinct from a measured zero, which is real progress against a threshold.
 */
export interface AchievementDTO {
  readonly key: string;
  readonly label: string;
  readonly description: string | null;
  readonly type: MilestoneType;
  readonly metric: string;
  readonly threshold: number;
  /** Guild XP the definition pays. Zero is normal — most defaults pay nothing. */
  readonly xpReward: number;
  readonly current: number | null;
  /** `current / threshold`, clamped to 0–1. Null whenever `current` is. */
  readonly progress: number | null;
  /** ISO-8601 when first reached, or null while outstanding. */
  readonly achievedAt: string | null;
  readonly tier: AchievementTier;
  readonly icon: string | null;
  /** Derived from `metric`, never stored — see `categoryOfMetric`. */
  readonly category: AchievementCategory;
  /**
   * True for an achievement the member is not meant to see coming. An unearned
   * hidden entry never appears in `upcoming`; it is counted in `hiddenLocked`
   * instead, so the total still adds up.
   */
  readonly hidden: boolean;
}

/** A member's standing against every achievement their guild recognises. */
export interface AchievementsDTO {
  /** Newest first. */
  readonly earned: readonly AchievementDTO[];
  /** Closest first, by fraction of the threshold reached. */
  readonly upcoming: readonly AchievementDTO[];
  readonly earnedCount: number;
  readonly totalCount: number;
  /**
   * How many hidden achievements are still locked. Named as a number rather
   * than listed, because naming them is the one thing hidden means.
   */
  readonly hiddenLocked: number;
  /** Guild XP the earned set has paid out. */
  readonly xpEarned: number;
  /** When the snapshot behind `current` was taken; null if never snapshotted. */
  readonly measuredAt: string | null;
  /**
   * False when no definitions could be read at all — the guild has achievements
   * switched off, or the service was wired without them. Lets the reply say
   * "off here" instead of "you have earned nothing", which is a different claim.
   */
  readonly configured: boolean;
}

/**
 * The tracked metrics `/progress` can chart, keyed as `ProfileSnapshot` stores them.
 *
 * `senitherWeight` was here and is not any more (Part III decision 1). The
 * figure is still stored and still printed on `/stats`; it is simply not one of
 * the four tracks a member is offered to chart, because it is frozen at v1 and
 * a month spent on a skill it does not score reads as a flat line.
 */
/**
 * Anything a member can chart or aim a goal at.
 *
 * This used to be four hand-picked tracks while everything else in the catalog
 * was detected-only. The split never survived contact with the question people
 * actually ask — "is my Mining going anywhere?" is the same question as "is my
 * networth going anywhere", and answering one and not the other was an
 * implementation detail leaking into the product. Every metric a snapshot
 * records is now a metric a member can watch; which ones the card *offers* is a
 * guild setting rather than a type.
 */
export type ProgressMetric = SnapshotMilestoneMetric;

export interface ProgressPointDTO {
  /** ISO-8601 of the moment the reading was taken. */
  readonly date: string;
  /** What the member called this save, when they named it. */
  readonly label: string | null;
  readonly value: number | null;
}

/**
 * How many saved snapshots one account keeps.
 *
 * A cap rather than a sweep interval: the explicit path has to be bounded too,
 * or "save it yourself" becomes the same unbounded history by a slower route
 * (docs/HYPIXEL_COMPLIANCE.md §1). Two dozen is more comparison points than any
 * member has asked a chart for, and the oldest falls off on the next save.
 */
export const SAVED_SNAPSHOT_LIMIT = 24;

/** The confirmation `/snapshot` reads back after storing one. */
export interface SavedSnapshotDTO {
  /** ISO-8601 of the reading that was saved — the refresh's time, not now. */
  readonly capturedAt: string;
  readonly label: string | null;
  /** How many the member now holds, after the cap was applied. */
  readonly savedCount: number;
  readonly limit: number;
}

export interface ProgressSeriesDTO {
  readonly metric: ProgressMetric;
  readonly rangeDays: number;
  readonly points: readonly ProgressPointDTO[];
  /**
   * Last minus first over the window. Null when fewer than two readings exist —
   * a single snapshot cannot show change, and reporting 0 would imply it did.
   */
  readonly change: number | null;
  /**
   * Change divided by the days actually spanned, not by `rangeDays`.
   *
   * The distinction matters for anyone the snapshot worker started covering
   * mid-window: dividing three days of gain by a thirty-day range reports a
   * tenth of the real pace, and every projection built on it is then wrong by
   * the same factor. Null whenever `change` is.
   */
  readonly perDay: number | null;
}

/**
 * A target a member set for themselves, with the platform's read on how it is
 * going (COMMANDS.md §11).
 *
 * The projection is deliberately the plainest arithmetic that can be defended —
 * recent pace, extended — rather than a fit. Skyblock progress is lumpy enough
 * that a curve would be a confident lie, and a member reading "about 12 days at
 * your recent pace" understands exactly how much to trust it.
 */
export interface GoalDTO {
  readonly id: string;
  readonly metric: ProgressMetric;
  readonly target: number;
  /** Where they were when they set it, so the bar has a floor to fill from. */
  readonly startValue: number | null;
  /** Latest snapshot reading, or null if they have never been snapshotted. */
  readonly current: number | null;
  /**
   * 0–1 of the way from `startValue` to `target`. Null when there is no
   * reading, and clamped at both ends: a member who went backwards is at 0 and
   * one who overshot is at 1, because a bar is not the place to learn you lost
   * ground.
   */
  readonly progress: number | null;
  /** Recent pace in units/day, from the same window `/progress` charts. */
  readonly perDay: number | null;
  /**
   * Days to the target at that pace, rounded up. Null when the pace is unknown,
   * zero, or negative — "never, at this rate" is true but useless, and a
   * negative ETA reads as a date in the past.
   */
  readonly etaDays: number | null;
  readonly createdAt: string;
  /** Set once the target is met; the row is kept as a record, not deleted. */
  readonly achievedAt: string | null;
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

/**
 * The member-facing view of `HealthReportDTO` — what `/health` is allowed to say.
 *
 * A separate shape rather than a filter applied at render time, because the
 * filtering is the security property. `ComponentHealthDTO.detail` carries
 * whatever a probe threw: a connection string, a hostname, a Prisma error naming
 * our schema. None of that should be one slash command away from any member of
 * the guild, and a renderer that merely *chose* not to print it would be one
 * refactor away from printing it.
 *
 * So the curation happens once, in `curateStatus`, and what comes out has no
 * field for a detail to live in.
 */
export interface PlatformStatusDTO {
  readonly overall: "ok" | "degraded" | "down";
  readonly checkedAt: string;
  /** The named rows, in a fixed order — the same rows every time, up or down. */
  readonly lines: readonly StatusLineDTO[];
  /**
   * Components that are not member-facing and are not healthy, counted rather
   * than named. A member does not need to know we run Postgres; they do need to
   * know something behind the curtain is why their command was slow.
   */
  readonly otherUnhealthy: number;
}

export interface StatusLineDTO {
  /** Already in the member's terms — "Guild chat", not "bridge".  */
  readonly label: string;
  readonly status: "ok" | "degraded" | "down";
}

/** One compiled chat-filter rule (`/wordlist-add`, `/wordlist-remove`). */
export interface WordlistRuleDTO {
  readonly id: string;
  readonly guildId: string;
  readonly pattern: string;
  readonly matchType: WordMatchType;
  readonly action: WordAction;
  readonly severity: number;
  readonly enabled: boolean;
}

/**
 * Result of `/filter-test`. `action` is the verdict the relay would reach for
 * the whole message, which is not simply the first match: BLOCK and SHADOW_MUTE
 * outrank REPLACE, which outranks FLAG.
 */
export interface FilterTestDTO {
  readonly text: string;
  readonly matched: readonly WordlistRuleDTO[];
  readonly action: WordAction | "ALLOW";
  /** Present only when the verdict is REPLACE — the censored text as relayed. */
  readonly replacement: string | null;
}

/**
 * An active `/lockdown`. Everything here is time-boxed (ADMIN_BOT.md §6): a
 * null `expiresAt` means an indefinite lock, which the command warns about.
 */
export interface LockdownStateDTO {
  readonly guildId: string;
  readonly scope: "CHANNEL" | "SERVER";
  /** The locked channel, or null when the whole server is locked. */
  readonly channelId: string | null;
  readonly reason: string;
  readonly actorDiscordId: string;
  readonly startedAt: string;
  readonly expiresAt: string | null;
  /**
   * Exactly the channels this lockdown closed, so lifting it opens exactly
   * those and no others.
   *
   * Without it, lifting a server-wide lock meant "unlock every channel that is
   * currently locked", which reopens the ones the server had deliberately kept
   * shut long before the raid started — a permission grant nobody made, applied
   * at the worst possible moment. A channel that was already locked when the
   * lockdown engaged is absent here and stays shut on lift.
   *
   * `null` is a record written by a build that did not track this; the service
   * falls back to the old scope-shaped unlock rather than guessing.
   */
  readonly lockedChannelIds: readonly string[] | null;
  /**
   * Set on a server lock that superseded a channel lock, naming the channel it
   * absorbed. The channel's own record is gone — one guild holds one lockdown —
   * so without this the earlier lock would vanish from the log with no trace of
   * having been folded in.
   */
  readonly absorbedChannelId?: string | null;
}

/** An active `/antiraid-on` posture. */
export interface AntiRaidStateDTO {
  readonly guildId: string;
  readonly sensitivity: RaidSensitivity;
  readonly actorDiscordId: string;
  readonly startedAt: string;
  readonly expiresAt: string | null;
}

/** Combined safety posture, as `/lockdown` and `/antiraid-*` report it. */
export interface SafetyStatusDTO {
  readonly lockdown: LockdownStateDTO | null;
  readonly antiRaid: AntiRaidStateDTO | null;
}

/**
 * What a trigger rule watches for.
 *
 * A tagged union rather than a bag of optional fields, so a rule cannot be half
 * a reaction count and half a phrase — and so adding a condition later is a
 * variant the compiler makes every consumer handle rather than another `if` in
 * a matcher somebody forgets to update.
 */
export type TriggerCondition =
  | { readonly kind: "REACTION_COUNT"; readonly emoji: string; readonly threshold: number }
  | { readonly kind: "MESSAGE_CONTAINS"; readonly phrase: string };

/** What happens when it does. Same reasoning as `TriggerCondition`. */
export type TriggerAction =
  | { readonly kind: "REPOST"; readonly channelId: string }
  | { readonly kind: "PIN" }
  | { readonly kind: "REPLY"; readonly text: string };

/**
 * One rule: a condition, an action and the scope both apply in.
 *
 * A starboard is the pairing `REACTION_COUNT(⭐, 3) → REPOST(#starboard)`. It
 * has no type of its own here on purpose — see `@sbr/triggers`.
 */
export interface TriggerRule {
  readonly id: string;
  /** What staff called it. Shown in the panel and in the log line when it fires. */
  readonly label: string;
  readonly enabled: boolean;
  readonly when: TriggerCondition;
  readonly then: TriggerAction;
  /** Where it applies. Empty means everywhere the bot can see. */
  readonly channels: readonly string[];
  /** Where it never applies, even if `channels` is empty. */
  readonly exemptChannels: readonly string[];
  /** Whether a bot's message can trip it. Off by default. */
  readonly includeBots: boolean;
  /** Whether the author's own reaction counts toward the threshold. Off by default. */
  readonly includeSelf: boolean;
}

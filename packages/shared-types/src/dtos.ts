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
  MilestoneType,
  ModActionType,
  PermStatus,
  RaidSensitivity,
  RSVPState,
  SkyblockGameMode,
  TicketCategory,
  TicketStatus,
  WordAction,
  WordMatchType,
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
  readonly skillAverage: number | null;
  readonly catacombsLevel: number | null;
  readonly senitherWeight: number | null;
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
export interface NetworthDTO {
  readonly total: number | null;
  readonly exact: boolean;
  readonly missing: readonly string[];
  readonly breakdown: Readonly<Record<string, number>>;
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
}

export interface AuctionsDTO {
  readonly listings: readonly AuctionListingDTO[];
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
}

/** One member's response, for `/attendance` and the event roster. */
export interface RsvpEntryDTO {
  readonly discordId: string;
  readonly state: RSVPState;
  readonly respondedAt: string;
}

/**
 * `/attendance` — who answered an event and how. Counts are computed from the
 * roster rather than stored, so they cannot drift from the entries beneath them.
 */
export interface AttendanceDTO {
  readonly event: EventDTO;
  readonly going: readonly RsvpEntryDTO[];
  readonly maybe: readonly RsvpEntryDTO[];
  readonly declined: readonly RsvpEntryDTO[];
  readonly waitlist: readonly RsvpEntryDTO[];
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
  readonly openerDiscordId: string;
  readonly assigneeDiscordId: string | null;
  readonly category: TicketCategory;
  readonly status: TicketStatus;
  readonly subject: string | null;
  readonly closeReason: string | null;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

export interface MilestoneDTO {
  readonly id: string;
  readonly minecraftUuid: string;
  readonly type: MilestoneType;
  readonly metric: string;
  readonly thresholdValue: number;
  readonly achievedAt: string;
}

/** The tracked metrics `/progress` can chart, keyed as `ProfileSnapshot` stores them. */
export type ProgressMetric = "networth" | "skillAverage" | "catacombsLevel" | "senitherWeight";

export interface ProgressPointDTO {
  /** Snapshot day, `YYYY-MM-DD`. */
  readonly date: string;
  readonly value: number | null;
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

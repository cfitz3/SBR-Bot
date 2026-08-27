/**
 * Fixed data for every card the platform can send.
 *
 * Fixtures rather than live reads, deliberately: the gallery has to run in CI,
 * on a laptop with no database, no Hypixel key and no gateway. That is the
 * difference between "check every card" being a command and being an audit
 * somebody schedules and then doesn't do.
 *
 * The numbers are chosen to be awkward on purpose — a null where a null is
 * legal, a stale envelope, an empty list, a name long enough to crowd a field —
 * because a gallery built only from tidy data proves the renderers work on data
 * we never see.
 */
import type { EventBoardView, EventReminderView } from "@sbr/commands-bridge";
import type {
  AccessoryReportDTO,
  AuctionListingDTO,
  AchievementsDTO,
  DiscordGuildInfo,
  PendingLevelUpDTO,
  DiscordUserInfo,
  AdviceDTO,
  ApplicationDTO,
  AttendanceDTO,
  AuctionsDTO,
  BazaarQuoteDTO,
  DataEnvelope,
  DungeonsDTO,
  EventDTO,
  FilterTestDTO,
  GoalDTO,
  GuildRosterDTO,
  HypixelFailureState,
  HypixelResult,
  InfractionDTO,
  EventPodiumDTO,
  LeaderboardPageDTO,
  LeaderboardPositionDTO,
  LinkedIdentityDTO,
  LFGPostDTO,
  LowestBinDTO,
  MemberRecordDTO,
  ModerationActionDTO,
  NetworthDTO,
  PendingMilestoneDTO,
  PermGroupDTO,
  PriceDTO,
  ProfileSummaryDTO,
  ProgressSeriesDTO,
  SafetyStatusDTO,
  SkillsDTO,
  SlayersDTO,
  TicketDTO,
  WordlistRuleDTO,
  XpStandingDTO,
} from "@sbr/shared-types";

/** The clock every fixture is written against, so the cards are reproducible. */
export const NOW = Date.parse("2026-08-13T18:00:00.000Z");

/** The same instant as a `Date`, for renderers that take one. */
export const NOW_DATE = new Date(NOW);

/** A fresh read. */
export function live<T>(data: T): HypixelResult<T> {
  return {
    ok: true,
    value: { data, freshness: "LIVE", fetchedAt: new Date(NOW - 60_000).toISOString(), source: "LIVE" },
  };
}

/** A read served from cache past its freshness window — the footer changes. */
export function stale<T>(data: T): HypixelResult<T> {
  const value: DataEnvelope<T> = {
    data,
    freshness: "STALE",
    fetchedAt: new Date(NOW - 3 * 3600_000).toISOString(),
    source: "CACHE",
  };
  return { ok: true, value };
}

/** Every failure state gets a card too; they are the ones nobody looks at. */
export function failed<T>(state: HypixelFailureState): HypixelResult<T> {
  return { ok: false, error: { state } };
}

const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

// ── Progression ─────────────────────────────────────────────────────────────

export const PROFILE: ProfileSummaryDTO = {
  profileId: "a1b2c3d4-0000-4000-8000-000000000001",
  cuteName: "Papaya",
  gameMode: "IRONMAN",
  skyblockLevel: 287.6,
  skillAverage: 51.3,
  catacombsLevel: 42,
  slayerXp: 2_640_000,
  senitherWeight: 8420.5,
  bestiaryMilestone: 7,
};

export const PROFILE_LIST: readonly ProfileSummaryDTO[] = [
  PROFILE,
  {
    profileId: "a1b2c3d4-0000-4000-8000-000000000002",
    cuteName: "Zucchini",
    gameMode: "NORMAL",
    skyblockLevel: 94.2,
    skillAverage: 33.8,
    // Never played dungeons on this profile — null, not zero.
    catacombsLevel: null,
    slayerXp: 0,
    senitherWeight: 1204,
    bestiaryMilestone: null,
  },
];

export const SKILLS: SkillsDTO = {
  average: 51.3,
  apiDisabled: false,
  skills: [
    { name: "Combat", level: 57, maxLevel: 60, experience: 88_400_000, xpToNext: 12_400_000, progress: 0.41 },
    { name: "Farming", level: 60, maxLevel: 60, experience: 111_600_000, xpToNext: null, progress: 1 },
    { name: "Mining", level: 48, maxLevel: 60, experience: 21_300_000, xpToNext: 3_900_000, progress: 0.62 },
    { name: "Foraging", level: 39, maxLevel: 50, experience: 5_100_000, xpToNext: 900_000, progress: 0.18 },
    // A skill Hypixel has not backfilled: level known, xp unreadable.
    { name: "Fishing", level: 44, maxLevel: 50, experience: null, xpToNext: null, progress: null },
  ],
};

export const SKILLS_OFF: SkillsDTO = { average: null, apiDisabled: true, skills: [] };

export const SLAYERS: SlayersDTO = {
  totalExperience: 2_640_000,
  bosses: [
    { boss: "Zombie", experience: 1_200_000, tier: 5, maxTier: 5, kills: { "1": 400, "4": 210, "5": 96 } },
    { boss: "Spider", experience: 640_000, tier: 4, maxTier: 4, kills: { "3": 180, "4": 61 } },
    { boss: "Wolf", experience: 500_000, tier: 4, maxTier: 4, kills: { "4": 44 } },
    { boss: "Enderman", experience: 300_000, tier: 3, maxTier: 4, kills: { "2": 30, "3": 12 } },
    { boss: "Blaze", experience: 0, tier: 0, maxTier: 4, kills: {} },
  ],
};

export const DUNGEONS: DungeonsDTO = {
  catacombsLevel: 42,
  catacombsExperience: 61_400_000,
  catacombsXpToNext: 8_100_000,
  catacombsProgress: 0.36,
  selectedClass: "Mage",
  classAverage: 38.4,
  played: true,
  classes: [
    { name: "Healer", level: 35, experience: 12_000_000 },
    { name: "Mage", level: 44, experience: 40_100_000 },
    { name: "Berserk", level: 37, experience: 15_600_000 },
    { name: "Archer", level: 39, experience: 19_200_000 },
    { name: "Tank", level: 37, experience: 15_100_000 },
  ],
  floors: [
    { floor: "F5", completions: 210, fastestSPlusMs: 224_000 },
    { floor: "F6", completions: 640, fastestSPlusMs: 301_000 },
    { floor: "F7", completions: 1_204, fastestSPlusMs: 402_500 },
  ],
  masterFloors: [
    { floor: "M3", completions: 88, fastestSPlusMs: 260_000 },
    // Run, but never S+: the record is unknown, not zero.
    { floor: "M6", completions: 12, fastestSPlusMs: null },
  ],
};

export const DUNGEONS_UNPLAYED: DungeonsDTO = {
  catacombsLevel: null,
  catacombsExperience: null,
  catacombsXpToNext: null,
  catacombsProgress: null,
  selectedClass: null,
  classAverage: null,
  played: false,
  classes: [],
  floors: [],
  masterFloors: [],
};

export const NETWORTH: NetworthDTO = {
  total: 8_240_000_000,
  exact: false,
  missing: ["Wardrobe", "Pets"],
  breakdown: { Purse: 140_000_000, Bank: 2_100_000_000, Inventory: 900_000_000, Storage: 5_100_000_000 },
  topItems: {
    Storage: [
      { name: "Hyperion", price: 1_100_000_000 },
      { name: "Necron's Chestplate ✪✪✪✪✪", price: 640_000_000 },
    ],
    Inventory: [{ name: "Terminator", price: 420_000_000 }],
  },
};

export const ACCESSORIES: AccessoryReportDTO = {
  magicalPower: 1_204,
  tuning: "Strength",
  apiDisabled: false,
  note: "Reforges are read from the bag; unreforged pieces count at base power.",
  owned: [
    { id: "HEGEMONY_ARTIFACT", name: "Hegemony Artifact", rarity: "LEGENDARY", magicalPower: 32, recombobulated: true },
    { id: "WEDDING_RING_9", name: "Ring of Love", rarity: "RARE", magicalPower: 12, recombobulated: false },
  ],
  missing: [
    {
      id: "SHADOW_FURY_TALISMAN",
      name: "Shadow Fury Talisman",
      rarity: "LEGENDARY",
      why: "Adds 32 magical power and unlocks the shadow line.",
      replaces: null,
      estimatedCost: 24_000_000,
    },
  ],
  upgradeable: [
    {
      id: "TITANIUM_TALISMAN",
      name: "Titanium Talisman",
      rarity: "UNCOMMON",
      why: "The ring version is a straight upgrade at the same slot cost.",
      replaces: "Titanium Talisman",
      estimatedCost: 3_400_000,
    },
  ],
  redundant: [
    { id: "SPEED_TALISMAN", name: "Speed Talisman", rarity: "COMMON", magicalPower: 3, recombobulated: false },
  ],
};

export const ADVICE: AdviceDTO = {
  focus: "Catacombs",
  generic: false,
  items: [
    {
      title: "Finish Catacombs 45",
      detail: "Three more M6 clears at your current pace, and it unlocks the class bonus you are short of.",
      priority: "HIGH",
      category: "Dungeons",
      estimatedCost: null,
    },
    {
      title: "Reforge the talisman bag",
      detail: "Roughly 340 magical power is sitting unreforged.",
      priority: "MEDIUM",
      category: "Accessories",
      estimatedCost: 12_000_000,
    },
  ],
};

export const ADVICE_GENERIC: AdviceDTO = {
  focus: "General",
  generic: true,
  items: [
    {
      title: "Turn your inventory API on",
      detail: "Nothing about your gear is readable while it is off.",
      priority: "HIGH",
      category: "Setup",
      estimatedCost: null,
    },
  ],
};

export const PROGRESS: ProgressSeriesDTO = {
  metric: "networth",
  rangeDays: 30,
  perDay: 1_250_000,
  change: 1_240_000_000,
  points: [
    { date: "2026-07-14", label: null, value: 7_000_000_000 },
    { date: "2026-07-21", label: null, value: 7_400_000_000 },
    // A day with no snapshot is a gap, never a zero.
    { date: "2026-07-28", label: null, value: null },
    { date: "2026-08-04", label: null, value: 8_100_000_000 },
    { date: "2026-08-11", label: null, value: 8_240_000_000 },
  ],
};

/** Two goals in different shapes: one moving, one that has stalled. */
export const GOALS: GoalDTO[] = [
  {
    id: "goal-1",
    metric: "networth",
    target: 10_000_000_000,
    startValue: 7_000_000_000,
    current: 8_240_000_000,
    progress: 0.413,
    perDay: 41_333_333,
    etaDays: 43,
    createdAt: "2026-07-14T00:00:00.000Z",
    achievedAt: null,
  },
  {
    // No pace, so no ETA — the card says so rather than inventing one.
    id: "goal-2",
    metric: "catacombsLevel",
    target: 45,
    startValue: 42,
    current: 42,
    progress: 0,
    perDay: null,
    etaDays: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    achievedAt: null,
  },
];

export const ACHIEVEMENTS: AchievementsDTO = {
  configured: true,
  earnedCount: 2,
  totalCount: 6,
  // One the member cannot see coming. The card has to say the number without
  // saying the name, which is the only thing worth testing about hidden.
  hiddenLocked: 1,
  xpEarned: 750,
  measuredAt: iso(-6 * 3600_000),
  earned: [
    {
      key: "cata-40",
      label: "Catacombs 40",
      description: "Reach catacombs level 40.",
      type: "CATACOMBS_LEVEL",
      metric: "catacombsLevel",
      threshold: 40,
      xpReward: 500,
      current: 42,
      progress: 1,
      achievedAt: iso(-9 * 86_400_000),
      tier: "GOLD",
      icon: "⚔️",
      category: "DUNGEONS",
      hidden: false,
    },
    {
      key: "sa-50",
      label: "Skill average 50",
      description: null,
      type: "SKILL_LEVEL",
      metric: "skillAverage",
      threshold: 50,
      xpReward: 250,
      current: 51.3,
      progress: 1,
      achievedAt: iso(-40 * 86_400_000),
      tier: "SILVER",
      icon: null,
      category: "SKILLS",
      hidden: false,
    },
  ],
  upcoming: [
    {
      key: "nw-10b",
      label: "Ten billion",
      description: "Networth of 10b.",
      type: "NETWORTH_THRESHOLD",
      metric: "networth",
      threshold: 10_000_000_000,
      xpReward: 1000,
      current: 8_240_000_000,
      progress: 0.824,
      achievedAt: null,
      tier: "PLATINUM",
      icon: null,
      category: "WEALTH",
      hidden: false,
    },
    {
      key: "slayer-3m",
      label: "Three million slayer",
      description: null,
      type: "SLAYER_TIER",
      metric: "slayerXp",
      threshold: 3_000_000,
      xpReward: 300,
      // Never measured — distinct from measured zero, and the card must say so.
      current: null,
      progress: null,
      achievedAt: null,
      tier: "BRONZE",
      icon: null,
      category: "SLAYER",
      hidden: false,
    },
  ],
};

export const ACHIEVEMENTS_OFF: AchievementsDTO = {
  configured: false,
  hiddenLocked: 0,
  earned: [],
  upcoming: [],
  earnedCount: 0,
  totalCount: 0,
  xpEarned: 0,
  measuredAt: null,
};

// ── Market ──────────────────────────────────────────────────────────────────

export const PRICE: PriceDTO = {
  itemId: "HYPERION",
  bazaarInstantSell: null,
  bazaarInstantBuy: null,
  lowestBin: 1_090_000_000,
  estimatedValue: 1_100_000_000,
};

export const BAZAAR: BazaarQuoteDTO = {
  itemId: "ENCHANTED_DIAMOND_BLOCK",
  displayName: "Enchanted Diamond Block",
  instantBuy: 1_940_000,
  instantSell: 1_820_000,
  buyVolume: 340_000,
  sellVolume: 512_000,
  spread: 120_000,
};

export const LOWEST_BIN: LowestBinDTO = {
  itemId: "NECRON_HANDLE",
  displayName: "Necron's Handle",
  price: 480_000_000,
  listings: 7,
};

export const LOWEST_BIN_NONE: LowestBinDTO = {
  itemId: "PARTY_HAT_CRAB",
  displayName: null,
  price: null,
  listings: 0,
};

const AUCTION_RUNNING: AuctionListingDTO = {
  auctionId: "auc-1",
  itemName: "Necron's Chestplate ✪✪✪✪✪",
  price: 640_000_000,
  bin: true,
  endsAt: iso(4 * 3600_000),
  highestBid: null,
  claimed: false,
};

const AUCTION_SOLD: AuctionListingDTO = {
  auctionId: "auc-2",
  itemName: "Juju Shortbow",
  price: 120_000_000,
  bin: false,
  endsAt: iso(-2 * 3600_000),
  highestBid: 132_000_000,
  claimed: false,
};

const AUCTION_EXPIRED: AuctionListingDTO = {
  auctionId: "auc-3",
  // An item name Hypixel did not return: the row still exists.
  itemName: null,
  price: null,
  bin: true,
  endsAt: null,
  highestBid: null,
  claimed: true,
};

/**
 * The buckets overlap `listings` by design — `active`/`unclaimed`/`expired` are
 * views of the same rows, not a partition into different ones.
 */
export const AUCTIONS: AuctionsDTO = {
  listings: [AUCTION_RUNNING, AUCTION_SOLD, AUCTION_EXPIRED],
  active: [AUCTION_RUNNING],
  unclaimed: [AUCTION_SOLD],
  expired: [AUCTION_EXPIRED],
  claimValue: 132_000_000,
};

export const AUCTIONS_EMPTY: AuctionsDTO = {
  listings: [],
  active: [],
  unclaimed: [],
  expired: [],
  // Nothing sold — which is not a sale worth nothing.
  claimValue: null,
};

// ── Guild ───────────────────────────────────────────────────────────────────

export const ROSTER: GuildRosterDTO = {
  guildName: "SkyBlock Rejects",
  online: 14,
  total: 118,
  fetchedAt: new Date(NOW - 20_000).toISOString(),
  ranks: [
    { rank: "Guild Master", members: ["Aria"] },
    { rank: "Officer", members: ["Bramble", "Cinder", "Dune"] },
    {
      rank: "Member",
      members: ["Elm", "Fern", "Gale", "Holly", "Iris", "Juniper", "Kestrel", "Larch", "Moss", "Nettle"],
    },
    // A rank with nobody online in it still exists on the roster.
    { rank: "Trial", members: [] },
  ],
};

export const STANDING: XpStandingDTO = {
  discordId: "100000000000000001",
  totalXp: 48_200,
  level: 24,
  intoLevel: 1_200,
  levelSpan: 3_000,
  tenureDays: 412,
  lastAwardAt: new Date(NOW - 7 * 3600_000),
  rank: 6,
  bySource: {
    GEXP: 30_000,
    DISCORD_MESSAGE: 9_400,
    GUILD_CHAT_MESSAGE: 5_100,
    TENURE: 3_000,
    MILESTONE: 700,
    COMMAND_USAGE: 0,
  },
};

export const STANDING_NEW: XpStandingDTO = {
  discordId: "100000000000000002",
  totalXp: 0,
  level: 1,
  intoLevel: 0,
  levelSpan: 500,
  tenureDays: 0,
  lastAwardAt: null,
  rank: null,
  bySource: {},
};

// ── The member's own card ───────────────────────────────────────────────────

export const PODIUM: EventPodiumDTO = {
  attended: 14,
  gold: 2,
  silver: 1,
  // Nobody has ever come third here, and the card must not print a zero for it.
  bronze: 0,
  recent: [
    { eventTitle: "Catacombs push", metric: "catacombsLevel", place: 1, delta: 1.4, at: iso(-2 * 86_400_000) },
    { eventTitle: "Slayer weekend", metric: "slayerXp", place: 2, delta: 412_000, at: iso(-9 * 86_400_000) },
    // A metric nobody has hard-coded a label for, and an event with no end date.
    { eventTitle: "Mining marathon", metric: "skill:mining", place: 1, delta: 3.1, at: null },
  ],
};

/** Attended events, never placed. The medals row has to disappear entirely. */
export const PODIUM_NO_MEDALS: EventPodiumDTO = {
  attended: 3,
  gold: 0,
  silver: 0,
  bronze: 0,
  recent: [],
};

export const POSITIONS: readonly LeaderboardPositionDTO[] = [
  { category: "level", label: "SkyBlock Level", format: "level", rank: 3, value: 312, totalRanked: 42 },
  { category: "wealth", label: "Wealth", format: "coins", rank: 7, value: 8_240_000_000, totalRanked: 40 },
  { category: "catacombs", label: "Catacombs", format: "level", rank: 12, value: 42, totalRanked: 38 },
  { category: "xp", label: "Guild XP", format: "count", rank: 6, value: 48_200, totalRanked: 51 },
];

export const LEADERBOARD: LeaderboardPageDTO = {
  category: "wealth",
  spec: {
    id: "wealth",
    label: "Wealth",
    format: "coins",
    source: "SNAPSHOT",
    description: "Networth from the most recent snapshot of each member.",
    windowed: false,
  },
  page: 1,
  pageCount: 12,
  totalRanked: 118,
  windowDays: null,
  oldestReadingAt: iso(-14 * 3600_000),
  viewer: {
    key: "aa000000-0000-4000-8000-0000000000ff",
    label: "Nettle",
    value: 900_000_000,
    at: iso(-14 * 3600_000),
    rank: 41,
    isViewer: true,
  },
  entries: [
    { key: "u1", label: "Aria", value: 14_200_000_000, at: iso(-2 * 3600_000), rank: 1, isViewer: false },
    { key: "u2", label: "Bramble", value: 9_100_000_000, at: iso(-3 * 3600_000), rank: 2, isViewer: false },
    // A tie: two 3rds are followed by a 5th, and the card must not renumber them.
    { key: "u3", label: "Cinder", value: 8_240_000_000, at: iso(-3 * 3600_000), rank: 3, isViewer: false },
    { key: "u4", label: "Dune", value: 8_240_000_000, at: iso(-4 * 3600_000), rank: 3, isViewer: false },
    { key: "u5", label: "<@100000000000000009>", value: 6_400_000_000, at: null, rank: 5, isViewer: false },
  ],
};

export const LEADERBOARD_EMPTY: LeaderboardPageDTO = {
  ...LEADERBOARD,
  category: "xp",
  spec: {
    id: "xp",
    label: "Guild XP",
    format: "count",
    source: "XP",
    description: "Guild XP earned across every source.",
    windowed: false,
  },
  entries: [],
  viewer: null,
  page: 1,
  pageCount: 1,
  totalRanked: 0,
  oldestReadingAt: null,
};

// ── Moderation ──────────────────────────────────────────────────────────────

export const MEMBER_RECORD: MemberRecordDTO = {
  warnings: 2,
  windowDays: 90,
  inForce: [
    { type: "MUTE", reason: "Advertising in guild chat", expiresAt: iso(6 * 3600_000) },
    { type: "ROLE_CHANGE", reason: "Trial rank pending review", expiresAt: null },
  ],
  nextEscalation: { warns: 3, action: "MUTE", durationSeconds: 86_400 },
};

export const MEMBER_RECORD_CLEAN: MemberRecordDTO = {
  warnings: 0,
  windowDays: 90,
  inForce: [],
  nextEscalation: null,
};

export const INFRACTIONS: readonly InfractionDTO[] = [
  {
    id: "inf-1",
    guildId: "g1",
    targetDiscordId: "100000000000000001",
    type: "ADVERTISING",
    severity: "HIGH",
    reason: "Posted a competing guild's invite in guild chat.",
    createdAt: iso(-3 * 86_400_000),
  },
  {
    id: "inf-2",
    guildId: "g1",
    targetDiscordId: "100000000000000001",
    type: "SPAM",
    severity: "LOW",
    reason: "Repeated the same message six times.",
    createdAt: iso(-30 * 86_400_000),
  },
];

export const AUDIT: readonly ModerationActionDTO[] = [
  {
    id: "act-1",
    guildId: "g1",
    type: "MUTE",
    actorDiscordId: "200000000000000001",
    targetDiscordId: "100000000000000001",
    reason: "Advertising",
    durationSeconds: 21_600,
    expiresAt: iso(6 * 3600_000),
    surfaces: ["DISCORD", "GUILD_CHAT"],
    active: true,
    enforcement: "CONFIRMED",
    enforcementDetail: null,
    updatedAt: null,
    editedByDiscordId: null,
    voidedAt: null,
    voidReason: null,
    createdAt: iso(-1 * 3600_000),
  },
  {
    id: "act-2",
    guildId: "g1",
    type: "GUILD_EXPEL",
    actorDiscordId: "200000000000000002",
    // Expelled in-game, never linked: there is no snowflake to name.
    targetDiscordId: null,
    reason: "Inactive 60 days",
    durationSeconds: null,
    expiresAt: null,
    surfaces: ["GUILD_CHAT"],
    active: false,
    // Reconstructed from Hypixel's own guild-chat notice: the platform did not
    // enforce it and has nothing to confirm.
    enforcement: "NOT_REQUIRED",
    enforcementDetail: null,
    updatedAt: null,
    editedByDiscordId: null,
    voidedAt: null,
    voidReason: null,
    createdAt: iso(-5 * 86_400_000),
  },
];

const RULE_INVITE: WordlistRuleDTO = {
  id: "w1",
  guildId: "g1",
  pattern: "discord.gg/",
  matchType: "SUBSTRING",
  action: "BLOCK",
  severity: 3,
  enabled: true,
};

const RULE_SLUR: WordlistRuleDTO = {
  id: "w2",
  guildId: "g1",
  pattern: "\\bn[o0]{2,}b\\b",
  matchType: "REGEX",
  action: "FLAG",
  severity: 1,
  enabled: true,
};

export const WORDLIST: readonly WordlistRuleDTO[] = [
  RULE_INVITE,
  RULE_SLUR,
  {
    id: "w3",
    guildId: "g1",
    pattern: "free*carry",
    matchType: "WILDCARD",
    action: "REPLACE",
    severity: 2,
    enabled: false,
  },
];

/** Two rules match; BLOCK outranks FLAG, and the card has to show both. */
export const FILTER_TEST_HIT: FilterTestDTO = {
  text: "join discord.gg/example, no0b",
  matched: [RULE_INVITE, RULE_SLUR],
  action: "BLOCK",
  replacement: null,
};

export const FILTER_TEST_CLEAR: FilterTestDTO = {
  text: "anyone up for f7?",
  matched: [],
  action: "ALLOW",
  replacement: null,
};

export const SAFETY_ON: SafetyStatusDTO = {
  lockdown: {
    guildId: "g1",
    scope: "CHANNEL",
    channelId: "300000000000000001",
    reason: "Raid in progress",
    actorDiscordId: "200000000000000001",
    startedAt: iso(-20 * 60_000),
    expiresAt: iso(40 * 60_000),
  },
  antiRaid: {
    guildId: "g1",
    sensitivity: "HIGH",
    actorDiscordId: "200000000000000001",
    startedAt: iso(-20 * 60_000),
    expiresAt: null,
  },
};

export const SAFETY_OFF: SafetyStatusDTO = { lockdown: null, antiRaid: null };

export const APPLICATION: ApplicationDTO = {
  id: "app-1",
  guildId: "g1",
  applicantDiscordId: "100000000000000003",
  status: "UNDER_REVIEW",
  submittedAt: iso(-2 * 86_400_000),
  reviewerDiscordId: "200000000000000001",
};

export const APPLICATIONS: readonly ApplicationDTO[] = [
  APPLICATION,
  {
    id: "app-2",
    guildId: "g1",
    applicantDiscordId: "100000000000000004",
    status: "ACCEPTED",
    submittedAt: iso(-9 * 86_400_000),
    reviewerDiscordId: "200000000000000002",
    decisionReason: "Passed the scam check and knows two officers.",
    decidedAt: iso(-8 * 86_400_000),
  },
  {
    id: "app-3",
    guildId: "g1",
    applicantDiscordId: "100000000000000005",
    // A draft has never been submitted: the timestamp is genuinely absent.
    status: "DRAFT",
    submittedAt: null,
  },
];

// ── Community ───────────────────────────────────────────────────────────────

export const EVENT: EventDTO = {
  id: "evt-1",
  guildId: "g1",
  title: "Catacombs push weekend",
  status: "LIVE",
  type: "DUNGEON",
  startsAt: iso(-4 * 3600_000),
  endsAt: iso(44 * 3600_000),
  capacity: 40,
  rsvpCount: 27,
  hostDiscordId: "200000000000000001",
  description: "Fractional catacombs levels gained over the weekend. Bring a class you actually play.",
};

export const EVENT_REMINDER: EventReminderView = {
  eventId: EVENT.id,
  title: EVENT.title,
  startsAt: iso(15 * 60_000),
  offsetMinutes: 15,
};

export const EVENT_BOARD: EventBoardView = {
  eventId: EVENT.id,
  title: EVENT.title,
  status: "LIVE",
  startsAt: iso(-90 * 60_000),
  endsAt: iso(3 * 60 * 60_000),
  prize: "500k coins and the winner's pick of next week's event",
  participantCount: 27,
  // Two metrics, because one was the shape that hid the other: the gallery is
  // where a renderer's multi-column case is meant to be visible.
  metrics: [
    {
      metric: "catacombsLevel",
      standings: [
        { discordId: "200000000000000001", delta: 4.82 },
        { discordId: "200000000000000002", delta: 3.11 },
        { discordId: "200000000000000003", delta: 2.4 },
        { discordId: "200000000000000004", delta: 0.75 },
      ],
    },
    {
      metric: "slayerEnderman",
      standings: [
        { discordId: "200000000000000002", delta: 1_842_000 },
        { discordId: "200000000000000001", delta: 960_500 },
      ],
    },
  ],
  unlinked: [{ discordId: "200000000000000009" }],
  updatedAt: iso(-4 * 60_000),
};

export const EVENT_BOARD_FINAL: EventBoardView = {
  ...EVENT_BOARD,
  status: "COMPLETED",
  endsAt: iso(-5 * 60_000),
  updatedAt: iso(-5 * 60_000),
};

export const EVENTS: readonly EventDTO[] = [
  EVENT,
  {
    id: "evt-2",
    guildId: "g1",
    title: "Guild meeting",
    status: "SCHEDULED",
    startsAt: iso(3 * 86_400_000),
    // Uncapped, and the card must not print "27/0".
    capacity: null,
    rsvpCount: 5,
  },
];

export const ATTENDANCE: AttendanceDTO = {
  event: EVENT,
  // One of the two who said yes turned up, and one person who never answered
  // did: the card has to be able to show both, or it flatters the RSVP list.
  attended: [
    { discordId: "100000000000000001", source: "TRACKED", recordedBy: null, recordedAt: iso(0) },
    { discordId: "100000000000000009", source: "MARKED", recordedBy: "100000000000000002", recordedAt: iso(0) },
  ],
  going: [
    { discordId: "100000000000000001", state: "GOING", respondedAt: iso(-2 * 86_400_000) },
    { discordId: "100000000000000002", state: "GOING", respondedAt: iso(-1 * 86_400_000) },
  ],
  maybe: [{ discordId: "100000000000000003", state: "MAYBE", respondedAt: iso(-1 * 86_400_000) }],
  declined: [{ discordId: "100000000000000004", state: "NOT_GOING", respondedAt: iso(-1 * 86_400_000) }],
  waitlist: [],
};

export const LFG: LFGPostDTO = {
  id: "lfg-1",
  guildId: "g1",
  authorDiscordId: "100000000000000001",
  activity: "DUNGEONS",
  details: "M6 chill runs, no rush, bring a healer.",
  slotsTotal: 5,
  slotsFilled: 3,
  status: "OPEN",
  expiresAt: iso(90 * 60_000),
  createdAt: iso(-30 * 60_000),
  members: ["100000000000000001", "100000000000000002", "100000000000000003"],
  title: "M6 x5",
  channelId: "300000000000000002",
  messageId: "400000000000000001",
  permGroupId: null,
  closedAt: null,
  closedByDiscordId: null,
};

export const LFG_LIST: readonly LFGPostDTO[] = [
  LFG,
  {
    ...LFG,
    id: "lfg-2",
    activity: "KUUDRA",
    details: null,
    title: null,
    slotsFilled: 4,
    status: "FULL",
    expiresAt: null,
  },
];

export const PERM: PermGroupDTO = {
  id: "perm-1",
  guildId: "g1",
  ownerDiscordId: "100000000000000001",
  name: "M7 Tuesdays",
  activity: "DUNGEONS",
  status: "ACTIVE",
  isDefault: true,
  notes: "Runs at 8pm UK. Ping before swapping classes.",
  createdAt: iso(-60 * 86_400_000),
  capacity: 5,
  members: [
    { ign: "Aria", role: "Mage", slot: 1, discordId: "100000000000000001", uuid: "u1", inGuild: true, catacombsLevel: 48, skillAverage: 51.3 },
    { ign: "Bramble", role: "Healer", slot: 2, discordId: "100000000000000002", uuid: "u2", inGuild: true, catacombsLevel: 45, skillAverage: 44.1 },
    // Unlinked and no longer in the guild: three separate unknowns on one row.
    { ign: "Cinder", role: "Tank", slot: 3, discordId: null, uuid: null, inGuild: null, catacombsLevel: null, skillAverage: null },
  ],
};

export const PERMS: readonly PermGroupDTO[] = [
  PERM,
  { ...PERM, id: "perm-2", name: "Kuudra alts", activity: "KUUDRA", isDefault: false, notes: null, status: "DISBANDED" },
];

export const TICKET: TicketDTO = {
  id: "tkt-1",
  guildId: "g1",
  number: 41,
  openerDiscordId: "100000000000000003",
  assigneeDiscordId: "200000000000000001",
  categoryId: "cat-report",
  categoryKey: "REPORT",
  categoryName: "Report",
  status: "OPEN",
  channelId: "300000000000000041",
  subject: null,
  topic: "Member advertising in guild chat",
  claimedByDiscordId: "200000000000000001",
  claimedAt: iso(-4 * 3600_000),
  closeRequestedByDiscordId: null,
  closeRequestedAt: null,
  lastMessageAt: iso(-30 * 60_000),
  firstStaffReplyAt: iso(-4 * 3600_000),
  feedbackRating: null,
  transcriptReady: false,
  closeReason: null,
  createdAt: iso(-5 * 3600_000),
  closedAt: null,
};

export const TICKETS: readonly TicketDTO[] = [
  TICKET,
  {
    ...TICKET,
    id: "tkt-2",
    number: 42,
    categoryId: "cat-appeal",
    categoryKey: "APPEAL",
    categoryName: "Appeal",
    status: "CLOSED",
    assigneeDiscordId: null,
    claimedByDiscordId: null,
    claimedAt: null,
    // Never answered by staff, so the card has to render "—" here rather than a
    // zero — the whole point of the field being nullable.
    firstStaffReplyAt: null,
    topic: null,
    transcriptReady: true,
    closeReason: "Appeal upheld; mute lifted.",
    closedAt: iso(-2 * 3600_000),
  },
];

export const MILESTONE: PendingMilestoneDTO = {
  id: "ms-1",
  guildId: "g1",
  discordId: "100000000000000001",
  ign: "Aria",
  label: "Catacombs 45",
  type: "CATACOMBS_LEVEL",
  metric: "catacombsLevel",
  thresholdValue: 45,
  achievedAt: iso(-40 * 60_000),
};

export const MILESTONE_UNLINKED: PendingMilestoneDTO = {
  ...MILESTONE,
  id: "ms-2",
  // Reached in-game by somebody who never linked: a mention is impossible.
  discordId: null,
  label: "Skill average 55",
  type: "SKILL_LEVEL",
  metric: "skillAverage",
  thresholdValue: 55,
};

/**
 * `/whois` on a long-standing member: a nickname, a boost, and more roles
 * than the card lists, which is where the "+N more" tail comes from.
 */
export const DISCORD_USER: DiscordUserInfo = {
  id: "900000000000000001",
  username: "nettleandsage",
  displayName: "Nettle",
  bot: false,
  avatarUrl: "https://cdn.discordapp.com/avatars/900000000000000001/abc.png?size=512",
  createdAt: Date.parse("2019-11-02T09:14:00.000Z"),
  member: {
    nickname: "Nettle",
    joinedAt: Date.parse("2023-02-17T20:41:00.000Z"),
    boostingSince: Date.parse("2025-12-01T12:00:00.000Z"),
    roleIds: Array.from({ length: 15 }, (_, i) => `70000000000000000${String(i)}`),
    timedOutUntil: null,
  },
};

/** The link behind `DISCORD_USER`, for the `/whois` card's link row. */
export const LINKED: LinkedIdentityDTO = {
  discordId: "900000000000000001",
  minecraftUuid: "4d9a51f6a1b7482c9e0b1d3c5f7a9b2e",
  ign: "Aria",
  status: "VERIFIED",
  primary: true,
  verifiedAt: iso(-400 * 24 * 3600_000),
};

/** Somebody Discord knows and this server does not — a different card, not a blank one. */
export const DISCORD_USER_OUTSIDER: DiscordUserInfo = {
  id: "900000000000000002",
  username: "passerby",
  displayName: "passerby",
  bot: false,
  avatarUrl: null,
  createdAt: Date.parse("2026-08-01T00:00:00.000Z"),
  member: null,
};

/** `/serverinfo` on a server with an owner, boosts and no icon set. */
export const DISCORD_GUILD: DiscordGuildInfo = {
  id: "800000000000000001",
  name: "Skyblock and Relax",
  iconUrl: null,
  createdAt: Date.parse("2021-06-09T15:30:00.000Z"),
  ownerId: "900000000000000009",
  memberCount: 1_482,
  channelCount: 47,
  roleCount: 31,
  emojiCount: 88,
  boostTier: 2,
  boostCount: 9,
};

/** A single-level climb, the ordinary case. */
export const LEVEL_UP: PendingLevelUpDTO = {
  id: "levelup-1",
  guildId: "guild-1",
  discordId: "900000000000000001",
  fromLevel: 11,
  toLevel: 12,
  totalXp: 18_400,
  achievedAt: "2026-08-19T21:04:00.000Z",
};

/** A rebuild after a backfill: several levels at once, which the card must say. */
export const LEVEL_UP_JUMP: PendingLevelUpDTO = {
  ...LEVEL_UP,
  id: "levelup-2",
  fromLevel: 12,
  toLevel: 15,
  totalXp: 31_250,
};

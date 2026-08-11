/**
 * Hypixel-facing DTOs and raw upstream response shapes. Domain packages consume
 * the normalized DTOs; the raw shapes never leak past normalization.
 */

/** Normalized player projection (minimal for this slice). Unknown fields are null. */
export interface HypixelPlayerDTO {
  readonly uuid: string;
  readonly ign: string | null;
  /** The Discord identifier set in the in-game social field, or null if unset. */
  readonly discordSocial: string | null;
  /**
   * First and last time Hypixel saw them log in, in epoch milliseconds. Null
   * when the account hides it or has never logged in — never coerced to zero,
   * because "we can't see it" and "brand new account" are different answers to
   * a screening question about account age.
   *
   * Kept as numbers rather than `Date` because this DTO is cached through
   * Redis as JSON: a Date would come back as a string on every cache hit while
   * still typing as a Date, which is the kind of bug that only shows up in
   * production.
   */
  readonly firstLoginMs: number | null;
  readonly lastLoginMs: number | null;
}

// ── Raw upstream shapes (loosely typed; validated during normalization) ──

export interface RawMojangProfile {
  readonly id?: string;
  readonly name?: string;
}

export interface RawHypixelPlayerResponse {
  readonly success?: boolean;
  readonly player?: RawHypixelPlayer | null;
  readonly cause?: string;
}

export interface RawHypixelPlayer {
  readonly uuid?: string;
  readonly displayname?: string;
  readonly socialMedia?: {
    readonly links?: {
      readonly DISCORD?: string;
    };
  };
  /** Epoch milliseconds, as Hypixel sends them. */
  readonly firstLogin?: number;
  readonly lastLogin?: number;
}

/** Normalized Skyblock profile projection with the member blob for networth. */
export interface SkyblockProfileDTO {
  readonly profileId: string;
  readonly cuteName: string | null;
  readonly gameMode: "NORMAL" | "IRONMAN" | "STRANDED" | "BINGO";
  /** True for the profile the player currently has loaded in-game. */
  readonly selected: boolean;
  /** Raw member object for this uuid (fed to the networth engine). */
  readonly member: unknown;
  readonly bankBalance: number | null;
  /** Which value-bearing sections we could read (drives networth honesty). */
  readonly readableSections: readonly string[];
}

export interface RawSkyblockProfilesResponse {
  readonly success?: boolean;
  readonly profiles?: readonly RawSkyblockProfile[] | null;
}

export interface RawSkyblockProfile {
  readonly profile_id?: string;
  readonly cute_name?: string;
  readonly game_mode?: string;
  readonly selected?: boolean;
  readonly banking?: { readonly balance?: number };
  readonly members?: Record<string, Record<string, unknown>>;
}

// ── Museum ──────────────────────────────────────────────────────────────────

/**
 * Museum contents for a profile. The member blobs stay raw: they exist only to
 * be handed to the networth engine, and re-shaping them here would mean
 * tracking every item format Hypixel ships.
 */
export interface MuseumDTO {
  readonly profileId: string;
  /** Keyed by member uuid. Absent members simply have no entry. */
  readonly members: Readonly<Record<string, unknown>>;
}

export interface RawMuseumResponse {
  readonly success?: boolean;
  readonly members?: Record<string, unknown> | null;
}

// ── Bazaar ──────────────────────────────────────────────────────────────────

/**
 * One product's quick-status. Hypixel names these from the *player's* point of
 * view, which is the opposite of the order book's: `buyPrice` is what you pay to
 * instant-buy, so it maps to our `instantBuy`.
 */
export interface BazaarProductDTO {
  readonly productId: string;
  /** Coins to instantly buy one unit, or null when there are no sell offers. */
  readonly instantBuy: number | null;
  /** Coins received instantly selling one unit, or null when there are no buy orders. */
  readonly instantSell: number | null;
  readonly buyVolume: number | null;
  readonly sellVolume: number | null;
}

export interface BazaarDTO {
  readonly lastUpdated: number | null;
  readonly products: Readonly<Record<string, BazaarProductDTO>>;
}

export interface RawBazaarResponse {
  readonly success?: boolean;
  readonly lastUpdated?: number;
  readonly products?: Record<string, RawBazaarProduct> | null;
}

export interface RawBazaarProduct {
  readonly product_id?: string;
  readonly quick_status?: {
    readonly buyPrice?: number;
    readonly sellPrice?: number;
    readonly buyVolume?: number;
    readonly sellVolume?: number;
  };
}

// ── Auction house ───────────────────────────────────────────────────────────

export interface AuctionDTO {
  readonly auctionId: string;
  readonly sellerUuid: string | null;
  readonly itemName: string | null;
  readonly tier: string | null;
  readonly category: string | null;
  readonly bin: boolean;
  /** Ask price for a BIN, current highest bid otherwise. Null if unreadable. */
  readonly price: number | null;
  readonly endsAt: number | null;
  /** Highest bid so far; null when nobody has bid. Zero would read as a 0-coin bid. */
  readonly highestBid: number | null;
  /** True once the seller has collected it — Hypixel keeps such rows for a while. */
  readonly claimed: boolean;
}

export interface AuctionPageDTO {
  readonly page: number;
  readonly totalPages: number;
  readonly totalAuctions: number;
  readonly lastUpdated: number | null;
  readonly auctions: readonly AuctionDTO[];
}

export interface RawAuctionsResponse {
  readonly success?: boolean;
  readonly page?: number;
  readonly totalPages?: number;
  readonly totalAuctions?: number;
  readonly lastUpdated?: number;
  readonly auctions?: readonly RawAuction[] | null;
}

export interface RawAuction {
  readonly uuid?: string;
  readonly auctioneer?: string;
  readonly item_name?: string;
  readonly tier?: string;
  readonly category?: string;
  readonly bin?: boolean;
  readonly starting_bid?: number;
  readonly highest_bid_amount?: number;
  readonly end?: number;
  readonly claimed?: boolean;
}

export interface EndedAuctionDTO {
  readonly auctionId: string;
  readonly sellerUuid: string | null;
  readonly buyerUuid: string | null;
  readonly price: number | null;
  readonly bin: boolean;
  readonly soldAt: number | null;
  /**
   * Item identity, decoded from the NBT blob the endpoint returns. Null when the
   * blob is absent or unreadable � the sale is then real but unattributable, and
   * pricing skips it rather than guessing.
   */
  readonly itemId: string | null;
  readonly itemName: string | null;
  /** Stack size, so a bulk sale can be priced per unit. */
  readonly count: number;
}

export interface EndedAuctionsDTO {
  readonly lastUpdated: number | null;
  readonly auctions: readonly EndedAuctionDTO[];
}

export interface RawEndedAuctionsResponse {
  readonly success?: boolean;
  readonly lastUpdated?: number;
  readonly auctions?: readonly RawEndedAuction[] | null;
}

export interface RawEndedAuction {
  readonly auction_id?: string;
  readonly seller?: string;
  readonly buyer?: string;
  readonly price?: number;
  readonly bin?: boolean;
  readonly timestamp?: number;
  /** base64(gzip(NBT)) � the only place the item's identity appears. */
  readonly item_bytes?: string;
}

// ── Global Skyblock state ───────────────────────────────────────────────────

export interface MayorDTO {
  readonly key: string | null;
  readonly name: string | null;
  readonly perks: readonly string[];
}

export interface ElectionCandidateDTO {
  readonly name: string | null;
  readonly votes: number | null;
}

export interface ElectionDTO {
  readonly lastUpdated: number | null;
  /** The mayor currently in office, or null between terms. */
  readonly mayor: MayorDTO | null;
  readonly ministerName: string | null;
  readonly electionYear: number | null;
  readonly candidates: readonly ElectionCandidateDTO[];
}

export interface RawElectionResponse {
  readonly success?: boolean;
  readonly lastUpdated?: number;
  readonly mayor?: RawMayor | null;
  readonly current?: { readonly year?: number; readonly candidates?: readonly RawMayor[] } | null;
}

export interface RawMayor {
  readonly key?: string;
  readonly name?: string;
  readonly votes?: number;
  readonly perks?: readonly { readonly name?: string }[];
  readonly minister?: { readonly name?: string } | null;
}

export interface FiresaleDTO {
  readonly itemId: string | null;
  readonly startsAt: number | null;
  readonly endsAt: number | null;
  readonly amount: number | null;
  /** Price in gems, as Hypixel reports it. */
  readonly price: number | null;
}

export interface FiresalesDTO {
  readonly sales: readonly FiresaleDTO[];
}

export interface RawFiresalesResponse {
  readonly success?: boolean;
  readonly sales?: readonly RawFiresale[] | null;
}

export interface RawFiresale {
  readonly item_id?: string;
  readonly start?: number;
  readonly end?: number;
  readonly amount?: number;
  readonly price?: number;
}

export interface BingoGoalDTO {
  readonly id: string | null;
  readonly name: string | null;
  readonly lore: string | null;
  /** Community goals carry a target; personal goals don't. */
  readonly requiredAmount: number | null;
}

export interface BingoDTO {
  readonly id: number | null;
  readonly name: string | null;
  readonly startsAt: number | null;
  readonly endsAt: number | null;
  readonly goals: readonly BingoGoalDTO[];
}

export interface RawBingoResponse {
  readonly success?: boolean;
  readonly id?: number;
  readonly name?: string;
  readonly start?: number;
  readonly end?: number;
  readonly goals?: readonly RawBingoGoal[] | null;
}

export interface RawBingoGoal {
  readonly id?: string;
  readonly name?: string;
  readonly lore?: string;
  readonly requiredAmount?: number;
}

/**
 * Reference data (`skills`, `collections`, `items`, …). The payloads differ per
 * resource and are consumed as lookup tables, so the body is passed through
 * untouched rather than modelled once per resource.
 */
export interface ResourceDTO {
  readonly name: string;
  readonly lastUpdated: number | null;
  readonly data: Readonly<Record<string, unknown>>;
}

// ── Guild ───────────────────────────────────────────────────────────────────

export interface GuildMemberDTO {
  readonly uuid: string;
  readonly rank: string | null;
  readonly joinedAt: number | null;
  /**
   * GEXP by `YYYY-MM-DD`, exactly as Hypixel reports it: a rolling ~7-day
   * window, keyed in UTC, and *not* cumulative — each value is that day's
   * earnings. Today's entry is still climbing when read.
   */
  readonly expHistory: Readonly<Record<string, number>>;
  /** Sum of `expHistory`. The number guild leaderboards are usually ranked on. */
  readonly weeklyGexp: number;
}

export interface GuildDTO {
  readonly id: string;
  readonly name: string | null;
  readonly tag: string | null;
  readonly tagColor: string | null;
  readonly createdAt: number | null;
  readonly members: readonly GuildMemberDTO[];
  /** Rank names ordered by priority, highest first. */
  readonly ranks: readonly string[];
}

export interface RawGuildResponse {
  readonly success?: boolean;
  readonly guild?: RawGuild | null;
}

export interface RawGuild {
  readonly _id?: string;
  readonly name?: string;
  readonly tag?: string;
  readonly tagColor?: string;
  readonly created?: number;
  readonly members?: readonly RawGuildMember[] | null;
  readonly ranks?: readonly { readonly name?: string; readonly priority?: number }[] | null;
}

export interface RawGuildMember {
  readonly uuid?: string;
  readonly rank?: string;
  readonly joined?: number;
  readonly expHistory?: Readonly<Record<string, unknown>> | null;
}

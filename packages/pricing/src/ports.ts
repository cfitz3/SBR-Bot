/**
 * Injectable collaborators for pricing/networth.
 *   - PriceSource: worker-populated cache of item prices (commands read only).
 *   - NetworthEngine: the valuation engine (skyhelper-networth seam), injected so
 *     the honesty logic can be tested without the real library.
 */
import type { HypixelResult, PriceDTO } from "@sbr/shared-types";

export interface PriceLookup {
  readonly price: PriceDTO;
  readonly stale: boolean;
}

export interface PriceSource {
  /** Returns the cached price (fresh or stale), or null if we have no data at all. */
  getItem(itemId: string): Promise<PriceLookup | null>;
}

/** One valued item, as the engine costed it. */
export interface NetworthItem {
  readonly name: string;
  readonly price: number;
}

export interface NetworthComputation {
  readonly total: number | null;
  readonly breakdown: Readonly<Record<string, number>>;
  /**
   * Items per category, most valuable first is not assumed — the honesty layer
   * sorts. Absent when the engine cannot itemise (a total-only engine), which
   * is different from a category that genuinely holds nothing.
   */
  readonly items?: Readonly<Record<string, readonly NetworthItem[]>>;
}

export interface NetworthEngineInput {
  readonly profile: unknown;
  readonly museum?: unknown;
  readonly bankBalance?: number | null;
}

/** Wraps skyhelper-networth (or equivalent). Returns raw totals; honesty is ours. */
export interface NetworthEngine {
  compute(input: NetworthEngineInput): Promise<NetworthComputation>;
}

// ── Market ports (`/bazaar`, `/lowestbin`, `/auctions`) ─────────────────────

export interface BazaarProductQuote {
  readonly productId: string;
  readonly instantBuy: number | null;
  readonly instantSell: number | null;
  readonly buyVolume: number | null;
  readonly sellVolume: number | null;
}

export interface BazaarSnapshot {
  readonly lastUpdated: number | null;
  readonly products: Readonly<Record<string, BazaarProductQuote>>;
}

/**
 * The whole bazaar in one read. This is a single upstream request that the
 * Hypixel client already caches, so unlike the auction house it is safe to
 * serve a command from directly.
 */
export interface BazaarProvider {
  getBazaar(): Promise<HypixelResult<BazaarSnapshot>>;
}

export interface BinListing {
  readonly auctionId: string;
  readonly itemName: string | null;
  readonly price: number | null;
  readonly bin: boolean;
  readonly endsAt: number | null;
  /** Highest bid so far; null when nobody has bid. Absent from sweep data. */
  readonly highestBid?: number | null;
  /** True once the seller collected it. Absent from sweep data, where every row is live. */
  readonly claimed?: boolean;
}

export interface BinEntry {
  readonly price: number | null;
  /** Listings the sweep saw for this item, so a single outlier is visible. */
  readonly listings: number;
  /** The cheapest few, for `/auctions item:`. */
  readonly cheapest: readonly BinListing[];
  readonly fetchedAt: number;
}

/**
 * Lowest-BIN readings from the auction-house sweep job. Read-only: a command
 * may not paginate the AH itself (HYPIXEL_DATA_LAYER.md), so a cold cache
 * yields null and the command says it has no data yet.
 */
export interface BinSource {
  get(itemId: string): Promise<BinEntry | null>;
}

/** A player's own active auctions — one cheap upstream call. */
export interface PlayerAuctionProvider {
  getPlayerAuctions(uuid: string): Promise<HypixelResult<readonly BinListing[]>>;
}

/** Reference data (`resources/skyblock/items`) backing the item catalog. */
export interface ItemResourceProvider {
  getResources(name: string): Promise<HypixelResult<{ readonly data: Record<string, unknown> }>>;
}

/**
 * Injectable collaborators for pricing/networth.
 *   - PriceSource: worker-populated cache of item prices (commands read only).
 *   - NetworthEngine: the valuation engine (skyhelper-networth seam), injected so
 *     the honesty logic can be tested without the real library.
 */
import type { HypixelResult, MarketRange, PriceDTO } from "@sbr/shared-types";

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

// ── History ports (the Coflnet layer behind `/price`) ─────────────────────

/**
 * The raw series, as a history source hands it over.
 *
 * Epoch millis rather than the DTO's ISO string: this is the shape adapters
 * work in, and one conversion at the service boundary is cheaper than every
 * adapter formatting dates.
 */
export interface HistoryPoint {
  readonly at: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly avg: number | null;
  readonly volume: number | null;
}

/**
 * A price-history source.
 *
 * Returning `null` is the contract for "I could not answer", and an adapter must
 * use it rather than throwing: the service above wraps this in a breaker, and a
 * breaker that has to catch exceptions to count failures is one `finally` away
 * from miscounting them. An empty `points` array means the source answered and
 * the item genuinely has no recorded past.
 */
export interface PriceHistoryProvider {
  history(itemId: string, range: MarketRange): Promise<readonly HistoryPoint[] | null>;
}

/**
 * Minimal HTTP port for the history adapter.
 *
 * Declared here rather than imported from `@sbr/hypixel` or `@sbr/skykings` for
 * the reason their own copies give: TypeScript is structural, so wiring hands
 * this the same `fetchHttp` — with its timeout and its network-failure-as-504
 * behaviour — without this package depending on a Hypixel client to borrow one
 * interface.
 */
export interface HistoryHttp {
  get(url: string, headers?: Readonly<Record<string, string>>): Promise<{
    readonly status: number;
    readonly json: unknown;
  }>;
}

/** Cache port for history. No stale-if-error: see `history.ts` for why. */
export interface HistoryCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
}

/** In-memory history cache, for single-process wiring and tests. */
export class InMemoryHistoryCache implements HistoryCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async get<T>(key: string): Promise<T | null> {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return hit.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }
}

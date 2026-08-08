/**
 * Market refresh work — the producers behind `/price`, `/bazaar`, `/lowestbin`
 * and `/auctions`.
 *
 * These live in a worker precisely so commands never do this: an auction-house
 * sweep is hundreds of paginated requests, which HYPIXEL_DATA_LAYER.md forbids
 * inside a command handler. Commands read only what these leave in cache.
 */

export interface BazaarProductLike {
  readonly instantBuy: number | null;
  readonly instantSell: number | null;
}

export interface AuctionLike {
  readonly auctionId: string;
  readonly itemName: string | null;
  readonly price: number | null;
  readonly bin: boolean;
  readonly endsAt: number | null;
  /** Canonical item id when the AH exposes one; falls back to the name. */
  readonly itemId?: string | null;
}

export interface AuctionPageLike {
  readonly page: number;
  readonly totalPages: number;
  readonly auctions: readonly AuctionLike[];
}

export interface CachedPriceWrite {
  readonly bazaarInstantSell: number | null;
  readonly bazaarInstantBuy: number | null;
  readonly lowestBin: number | null;
  readonly estimatedValue: number | null;
  readonly fetchedAt: number;
}

export interface BinWrite {
  readonly price: number | null;
  readonly listings: number;
  readonly cheapest: readonly AuctionLike[];
  readonly fetchedAt: number;
}

export interface BazaarRefreshDeps {
  fetchBazaar(): Promise<Readonly<Record<string, BazaarProductLike>> | null>;
  /** The lowest BIN already known for an item, so the blend can use both sides. */
  knownLowestBin(itemId: string): Promise<number | null>;
  writePrice(itemId: string, price: CachedPriceWrite): Promise<void>;
  now?: () => number;
}

/**
 * Estimated value: the cheapest way to actually obtain one unit.
 *
 * Instant-buy and lowest-BIN are both real acquisition costs, so the estimate
 * is the lower of the two. When only one side is readable that side stands
 * alone, and when neither is the estimate stays null — an item we cannot price
 * must not be reported as free.
 */
export function blendEstimate(instantBuy: number | null, lowestBin: number | null): number | null {
  if (instantBuy === null) return lowestBin;
  if (lowestBin === null) return instantBuy;
  return Math.min(instantBuy, lowestBin);
}

/** Refresh every bazaar product's cached price. Returns the number written. */
export async function refreshBazaar(deps: BazaarRefreshDeps): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  const products = await deps.fetchBazaar();
  if (!products) return 0;

  let written = 0;
  for (const [itemId, product] of Object.entries(products)) {
    const lowestBin = await deps.knownLowestBin(itemId);
    await deps.writePrice(itemId, {
      bazaarInstantSell: product.instantSell,
      bazaarInstantBuy: product.instantBuy,
      lowestBin,
      estimatedValue: blendEstimate(product.instantBuy, lowestBin),
      fetchedAt: now(),
    });
    written += 1;
  }
  return written;
}

export interface AuctionSweepDeps {
  fetchPage(page: number): Promise<AuctionPageLike | null>;
  writeBin(itemId: string, entry: BinWrite): Promise<void>;
  /** Hard ceiling on pages, so a bad totalPages can't run the worker forever. */
  maxPages?: number;
  /** Cheapest listings kept per item, for `/auctions item:`. */
  keepPerItem?: number;
  now?: () => number;
}

/** The AH exposes no id for many items, so the display name is the stable key. */
function keyFor(auction: AuctionLike): string | null {
  const id = auction.itemId ?? auction.itemName;
  if (!id) return null;
  return id.toUpperCase().replace(/\s+/g, "_");
}

/**
 * Sweep the auction house and write one lowest-BIN entry per item.
 *
 * Only BIN listings count: an auction's current bid is not a price anyone can
 * pay right now, and folding bids into "lowest BIN" would understate it.
 */
export async function sweepAuctions(deps: AuctionSweepDeps): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  const maxPages = deps.maxPages ?? 100;
  const keep = deps.keepPerItem ?? 5;

  const first = await deps.fetchPage(0);
  if (!first) return 0;

  const byItem = new Map<string, AuctionLike[]>();
  const collect = (page: AuctionPageLike): void => {
    for (const auction of page.auctions) {
      if (!auction.bin || auction.price === null) continue;
      const key = keyFor(auction);
      if (!key) continue;
      const bucket = byItem.get(key);
      if (bucket) bucket.push(auction);
      else byItem.set(key, [auction]);
    }
  };
  collect(first);

  const pages = Math.min(first.totalPages, maxPages);
  for (let page = 1; page < pages; page += 1) {
    const next = await deps.fetchPage(page);
    // A single failed page degrades coverage rather than losing the whole
    // sweep — a partial index is far more useful than none.
    if (next) collect(next);
  }

  const fetchedAt = now();
  for (const [itemId, listings] of byItem) {
    listings.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    await deps.writeBin(itemId, {
      price: listings[0]?.price ?? null,
      listings: listings.length,
      cheapest: listings.slice(0, keep),
      fetchedAt,
    });
  }
  return byItem.size;
}

// ────────────────────────── ended auctions ──────────────────────────

export interface EndedAuctionLike {
  readonly auctionId: string;
  readonly itemId: string | null;
  readonly itemName: string | null;
  readonly price: number | null;
  readonly bin: boolean;
}

export interface SaleStats {
  readonly itemId: string;
  /** Median of the observed sale prices — the headline "actually sells for". */
  readonly median: number | null;
  readonly low: number | null;
  readonly high: number | null;
  readonly sales: number;
  readonly fetchedAt: number;
}

/**
 * Median rather than mean.
 *
 * Ended-auction data is full of misclicks and manipulation: one item listed at
 * 100× its worth drags a mean far enough to make `/price` useless, while the
 * median barely moves. Even-count medians average the two middle values so a
 * two-sale sample still reports something between them.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  return lo === undefined || hi === undefined ? null : (lo + hi) / 2;
}

export interface EndedAuctionDeps {
  fetchEnded(): Promise<readonly EndedAuctionLike[] | null>;
  writeSales(stats: SaleStats): Promise<void>;
  now?: () => number;
}

/**
 * Fold the last hour of completed sales into per-item statistics.
 *
 * Hypixel's ended-auctions endpoint is a rolling ~60-minute window, so this is
 * the only source of *realised* prices anywhere in the platform — every other
 * feed reports what sellers are asking, not what buyers paid.
 */
export async function ingestEndedAuctions(deps: EndedAuctionDeps): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  const ended = await deps.fetchEnded();
  if (!ended) return 0;

  const byItem = new Map<string, number[]>();
  for (const sale of ended) {
    if (sale.price === null || sale.price <= 0) continue;
    const raw = sale.itemId ?? sale.itemName;
    if (!raw) continue;
    const key = raw.toUpperCase().replace(/\s+/g, "_");
    const bucket = byItem.get(key);
    if (bucket) bucket.push(sale.price);
    else byItem.set(key, [sale.price]);
  }

  const fetchedAt = now();
  for (const [itemId, prices] of byItem) {
    const sorted = [...prices].sort((a, b) => a - b);
    await deps.writeSales({
      itemId,
      median: median(sorted),
      low: sorted[0] ?? null,
      high: sorted[sorted.length - 1] ?? null,
      sales: sorted.length,
      fetchedAt,
    });
  }
  return byItem.size;
}

// ────────────────────────── resources refresh ──────────────────────────

export interface ResourceRefreshDeps {
  /**
   * Named resource fetchers — skills, collections, items, election, bingo.
   * Each returns its payload or null when the endpoint is unreadable.
   */
  readonly resources: Readonly<Record<string, () => Promise<unknown | null>>>;
  writeResource(name: string, payload: unknown): Promise<void>;
}

/**
 * Refresh the slow-moving reference data (`resources/*`, election, bingo).
 *
 * These change on Hypixel's release cadence, not minute to minute, so they are
 * fetched rarely and cached long. Each resource is independent: one failing
 * endpoint leaves the others refreshed rather than aborting the run.
 */
export async function refreshResources(deps: ResourceRefreshDeps): Promise<number> {
  let written = 0;
  for (const [name, fetch] of Object.entries(deps.resources)) {
    const payload = await fetch().catch(() => null);
    if (payload === null || payload === undefined) continue;
    await deps.writeResource(name, payload);
    written += 1;
  }
  return written;
}

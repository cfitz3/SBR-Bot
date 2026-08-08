/**
 * MarketServiceImpl — the order-book and listings reads behind `/bazaar`,
 * `/lowestbin` and `/auctions`.
 *
 * Two different sourcing rules apply, and the split is deliberate:
 *   - The bazaar is one upstream request for every product, already cached by
 *     the Hypixel client, so a command may read it directly.
 *   - The auction house is hundreds of pages. Commands read only what the sweep
 *     job left in cache; a cold cache means "no data yet", never a live sweep.
 */
import {
  err,
  ok,
  hypixelFailure,
  type AuctionListingDTO,
  type AuctionsDTO,
  type BazaarQuoteDTO,
  type DataEnvelope,
  type HypixelResult,
  type ItemMatchDTO,
  type LowestBinDTO,
  type MarketService,
} from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import type { ItemCatalog } from "./catalog.js";
import type { BazaarProvider, BinListing, BinSource, PlayerAuctionProvider } from "./ports.js";

/** Past this, a swept BIN reading is reported as stale rather than current. */
const BIN_STALE_AFTER_MS = 10 * 60_000;

export interface MarketServiceDeps {
  readonly bazaar: BazaarProvider;
  readonly bins: BinSource;
  readonly auctions: PlayerAuctionProvider;
  readonly catalog: ItemCatalog;
  readonly logger: Logger;
  readonly now?: () => number;
}

function toListing(l: BinListing): AuctionListingDTO {
  return {
    auctionId: l.auctionId,
    itemName: l.itemName,
    price: l.price,
    bin: l.bin,
    endsAt: l.endsAt === null ? null : new Date(l.endsAt).toISOString(),
  };
}

export class MarketServiceImpl implements MarketService {
  private readonly d: MarketServiceDeps;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(deps: MarketServiceDeps) {
    this.d = deps;
    this.log = deps.logger.child({ service: "market" });
    this.now = deps.now ?? (() => Date.now());
  }

  async getBazaarQuote(itemId: string): Promise<HypixelResult<BazaarQuoteDTO>> {
    const snapshot = await this.d.bazaar.getBazaar();
    if (!snapshot.ok) return err(snapshot.error);

    const product = snapshot.value.data.products[itemId];
    if (!product) {
      // Not on the bazaar is a real answer about a real item, but there is
      // nothing to quote — MISSING_PROFILE is the "we have no such record"
      // state the command layer already renders.
      this.log.debug("item not on bazaar", { itemId });
      return hypixelFailure("MISSING_PROFILE");
    }

    const displayName = await this.d.catalog.displayName(itemId);
    const spread =
      product.instantBuy !== null && product.instantSell !== null
        ? product.instantBuy - product.instantSell
        : null;

    return ok(
      reEnvelope(snapshot.value, {
        itemId,
        displayName,
        instantBuy: product.instantBuy,
        instantSell: product.instantSell,
        buyVolume: product.buyVolume,
        sellVolume: product.sellVolume,
        spread,
      }),
    );
  }

  async getLowestBin(itemId: string): Promise<HypixelResult<LowestBinDTO>> {
    const entry = await this.d.bins.get(itemId);
    const displayName = await this.d.catalog.displayName(itemId);

    if (!entry) {
      // Unknown, not zero: the sweep may simply not have covered this item yet.
      return ok({
        data: { itemId, displayName, price: null, listings: 0 },
        freshness: "STALE",
        source: "CACHE",
        fetchedAt: new Date(this.now()).toISOString(),
      });
    }
    return ok({
      data: { itemId, displayName, price: entry.price, listings: entry.listings },
      freshness: this.now() - entry.fetchedAt > BIN_STALE_AFTER_MS ? "STALE" : "LIVE",
      source: "CACHE",
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
    });
  }

  async getPlayerAuctions(uuid: string): Promise<HypixelResult<AuctionsDTO>> {
    const result = await this.d.auctions.getPlayerAuctions(uuid);
    if (!result.ok) return err(result.error);

    // Soonest to end first — that is the one a seller or buyer acts on next.
    const listings = [...result.value.data]
      .sort((a, b) => (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity))
      .map(toListing);
    return ok(reEnvelope(result.value, { listings }));
  }

  async getItemAuctions(itemId: string): Promise<HypixelResult<AuctionsDTO>> {
    const entry = await this.d.bins.get(itemId);
    if (!entry) {
      return ok({
        data: { listings: [] },
        freshness: "STALE",
        source: "CACHE",
        fetchedAt: new Date(this.now()).toISOString(),
      });
    }
    return ok({
      data: { listings: entry.cheapest.map(toListing) },
      freshness: this.now() - entry.fetchedAt > BIN_STALE_AFTER_MS ? "STALE" : "LIVE",
      source: "CACHE",
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
    });
  }

  async searchItems(query: string, limit = 25): Promise<readonly ItemMatchDTO[]> {
    return this.d.catalog.search(query, limit);
  }

  async resolveItemId(query: string): Promise<string | null> {
    return this.d.catalog.resolve(query);
  }
}

function reEnvelope<A, B>(source: DataEnvelope<A>, data: B): DataEnvelope<B> {
  return { data, freshness: source.freshness, source: source.source, fetchedAt: source.fetchedAt };
}

/**
 * PricingServiceImpl — answers item price queries from the worker-populated
 * cache. Absent data yields a PriceDTO of nulls (unknown ≠ zero), never a fake
 * number; staleness is surfaced via the envelope freshness.
 */
import { ok, type HypixelResult, type PriceDTO, type PricingService } from "@sbr/shared-types";
import type { Logger } from "@sbr/observability";
import type { PriceSource } from "./ports.js";

export interface PricingServiceDeps {
  readonly source: PriceSource;
  readonly logger: Logger;
}

function emptyPrice(itemId: string): PriceDTO {
  return {
    itemId,
    bazaarInstantSell: null,
    bazaarInstantBuy: null,
    lowestBin: null,
    estimatedValue: null,
  };
}

export class PricingServiceImpl implements PricingService {
  private readonly source: PriceSource;
  private readonly log: Logger;

  constructor(deps: PricingServiceDeps) {
    this.source = deps.source;
    this.log = deps.logger.child({ service: "pricing" });
  }

  async getPrice(itemId: string): Promise<HypixelResult<PriceDTO>> {
    const found = await this.source.getItem(itemId);
    if (!found) {
      this.log.debug("no market data for item", { itemId });
      return ok({ data: emptyPrice(itemId), freshness: "STALE", source: "CACHE", fetchedAt: new Date().toISOString() });
    }
    return ok({
      data: found.price,
      freshness: found.stale ? "STALE" : "LIVE",
      source: "CACHE",
      fetchedAt: new Date().toISOString(),
    });
  }
}

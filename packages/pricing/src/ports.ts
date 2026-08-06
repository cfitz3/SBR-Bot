/**
 * Injectable collaborators for pricing/networth.
 *   - PriceSource: worker-populated cache of item prices (commands read only).
 *   - NetworthEngine: the valuation engine (skyhelper-networth seam), injected so
 *     the honesty logic can be tested without the real library.
 */
import type { PriceDTO } from "@sbr/shared-types";

export interface PriceLookup {
  readonly price: PriceDTO;
  readonly stale: boolean;
}

export interface PriceSource {
  /** Returns the cached price (fresh or stale), or null if we have no data at all. */
  getItem(itemId: string): Promise<PriceLookup | null>;
}

export interface NetworthComputation {
  readonly total: number | null;
  readonly breakdown: Readonly<Record<string, number>>;
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

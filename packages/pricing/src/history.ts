/**
 * Price history — the cache and the breaker in front of a source we do not run.
 *
 * Everything else in this package answers from data the platform collected
 * itself: the bazaar snapshot the Hypixel client already caches, the BIN
 * readings the sweep job leaves behind, the valuation engine. History is the one
 * thing we cannot produce, because nobody kept it — so it comes from Coflnet,
 * and that changes the rules it has to live under.
 *
 * Three of them:
 *
 * 1. **A history outage is never a market outage.** `/price` answers from our
 *    own data; the chart is context laid over the top. So this returns `null`
 *    rather than a failure, the card renders without a chart, and the current
 *    prices — the part somebody is about to trade on — are unaffected by a third
 *    party's uptime.
 *
 * 2. **Failures are counted, not cached.** A cached "no history" would turn one
 *    bad minute into an hour of blank charts. Instead the breaker counts
 *    consecutive failures and, past the threshold, stops calling for a cooldown
 *    — which is the honest version of the same idea: not "there is no history"
 *    but "we are not asking right now".
 *
 * 3. **One request per item per window, however many people ask.** A popular
 *    item on a busy server is the same series a dozen times over, so successes
 *    are cached and concurrent misses share one in-flight request. The point is
 *    not our latency; it is that a free public API should not be billed for our
 *    fan-out.
 */
import type { Logger } from "@sbr/observability";
import type { MarketHistoryDTO, MarketHistoryService, MarketRange } from "@sbr/shared-types";
import type { HistoryCache, HistoryPoint, PriceHistoryProvider } from "./ports.js";
import { InMemoryHistoryCache } from "./ports.js";

/**
 * How long a series may be reused, by range.
 *
 * Proportional to the bucket it is made of: a day chart is hourly, so a
 * fifteen-minute cache cannot hide a bucket that has already closed, while a
 * month chart is daily and re-reading it every fifteen minutes would be asking
 * the same question a hundred times for one new point.
 */
export const HISTORY_TTL_MS: Readonly<Record<MarketRange, number>> = {
  DAY: 15 * 60_000,
  WEEK: 60 * 60_000,
  MONTH: 6 * 60 * 60_000,
};

/** Consecutive failures before the breaker opens. */
export const BREAKER_THRESHOLD = 3;

/** How long it stays open. Long enough to be a rest, short enough to self-heal. */
export const BREAKER_COOLDOWN_MS = 5 * 60_000;

export interface MarketHistoryServiceDeps {
  readonly provider: PriceHistoryProvider;
  readonly logger: Logger;
  readonly cache?: HistoryCache;
  readonly now?: () => number;
}

function toDTO(itemId: string, range: MarketRange, points: readonly HistoryPoint[]): MarketHistoryDTO {
  return {
    itemId,
    range,
    // Oldest first, because a chart is read left to right and a source that
    // hands back newest-first would otherwise draw every series backwards.
    points: [...points]
      .sort((a, b) => a.at - b.at)
      .map((p) => ({
        at: new Date(p.at).toISOString(),
        min: p.min,
        max: p.max,
        avg: p.avg,
        volume: p.volume,
      })),
  };
}

export class MarketHistoryServiceImpl implements MarketHistoryService {
  private readonly provider: PriceHistoryProvider;
  private readonly cache: HistoryCache;
  private readonly log: Logger;
  private readonly now: () => number;

  /** Consecutive failures, and when the breaker may next let a call through. */
  private failures = 0;
  private openUntil = 0;

  /** In-flight reads by cache key, so a burst on one item is one request. */
  private readonly inFlight = new Map<string, Promise<MarketHistoryDTO | null>>();

  constructor(deps: MarketHistoryServiceDeps) {
    this.provider = deps.provider;
    this.cache = deps.cache ?? new InMemoryHistoryCache(deps.now);
    this.log = deps.logger.child({ service: "market-history" });
    this.now = deps.now ?? (() => Date.now());
  }

  async history(itemId: string, range: MarketRange): Promise<MarketHistoryDTO | null> {
    const key = `${range}:${itemId}`;

    // The cache is checked before the breaker on purpose. An open breaker means
    // "stop calling out", not "forget what we already know" — a series read two
    // minutes ago is still the best answer available, and dropping it would make
    // an upstream blip look like an item with no past.
    const cached = await this.cache.get<MarketHistoryDTO>(key).catch(() => null);
    if (cached) return cached;

    if (this.now() < this.openUntil) return null;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const request = this.read(key, itemId, range).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, request);
    return request;
  }

  private async read(key: string, itemId: string, range: MarketRange): Promise<MarketHistoryDTO | null> {
    // A provider is contracted to return null rather than throw, but a breaker
    // that trusts that contract stops counting the moment somebody breaks it.
    const points = await this.provider.history(itemId, range).catch((error: unknown) => {
      this.log.debug("history provider threw", { itemId, error: String(error) });
      return null;
    });

    if (points === null) {
      this.failures += 1;
      if (this.failures >= BREAKER_THRESHOLD) {
        this.openUntil = this.now() + BREAKER_COOLDOWN_MS;
        this.log.warn("price history unavailable, pausing reads", {
          failures: this.failures,
          cooldownMs: BREAKER_COOLDOWN_MS,
        });
      }
      return null;
    }

    this.failures = 0;
    const dto = toDTO(itemId, range, points);
    // An empty series is cached like any other answer: "this item has no
    // recorded past" is a fact about the item, and asking again in a second
    // will not change it.
    await this.cache.set(key, dto, HISTORY_TTL_MS[range]).catch(() => undefined);
    return dto;
  }
}

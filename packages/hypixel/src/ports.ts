/**
 * Injectable collaborators for the Hypixel client. Keeping these as ports lets
 * the client be unit-tested offline and lets the Redis-backed cache/rate-gate
 * (multi-instance, follow-up) drop in without touching the client.
 */

export interface HttpResponse {
  readonly status: number;
  /** Header names are lower-cased. */
  readonly headers: Readonly<Record<string, string>>;
  readonly json: unknown;
}

export interface HttpFetcher {
  get(url: string, headers?: Readonly<Record<string, string>>): Promise<HttpResponse>;
}

/** A cached entry with soft-expiry, so stale-if-error can still serve it. */
export interface CacheEntry<T> {
  readonly data: T;
  readonly fetchedAt: string;
  readonly expired: boolean;
}

export interface HypixelCache {
  get<T>(key: string): Promise<CacheEntry<T> | null>;
  set<T>(key: string, data: T, ttlMs: number): Promise<void>;
}

export interface RateAcquire {
  readonly allowed: boolean;
  readonly retryAfterMs?: number;
}

/** Shared rate budget. `observe` folds real response headers back into the bucket. */
export interface RateGate {
  acquire(): Promise<RateAcquire>;
  observe(headers: Readonly<Record<string, string>>, status: number): void;
}

/**
 * The self-imposed per-player floor: at most one upstream read for a given
 * player inside the configured window.
 *
 * Separate from `RateGate` because the two answer different questions. The gate
 * asks "does the fleet have budget right now", and folds Hypixel's own headers
 * back in — it is a shared bucket, and upstream is the authority on it. This
 * asks "have we already read *this player* recently", against our own clock and
 * regardless of what upstream would allow. A cap that yielded to upstream's
 * headers would not be a cap at all; the whole point is that it holds when
 * Hypixel would have said yes.
 *
 * Only player-scoped endpoints consult it. Guild and market reads are one
 * request covering everyone, so there is no per-player claim to make.
 */
export interface PlayerRateLimiter {
  /**
   * Reserve a slot for the window. False when one was already taken.
   *
   * The subject is `<uuid>:<endpoint family>`, not a bare uuid, and that choice
   * is worth stating plainly because it is an interpretation of the policy
   * rather than a mechanical reading of it.
   *
   * "One request per player per hour" has to mean one *refresh* per player per
   * hour: a player's data lives behind three endpoints (`player`,
   * `skyblock/profiles`, `skyblock/museum`), a networth figure needs all three,
   * and a single shared claim would mean fetching someone's profile locked out
   * reading their museum until the next hour — the feature would simply not
   * work. So the cap is one read per player per endpoint per hour, giving a
   * worst case of three upstream calls per player per hour.
   *
   * In practice it is far below that: the cache TTLs (6h player, 6h profiles,
   * 12h museum) are what actually bound our volume, and this limiter is the
   * floor that proves the bound holds rather than the thing producing it.
   *
   * Never throws: an unreachable limiter must not turn into a failed lookup, and
   * the cache TTL is a second floor underneath it either way.
   */
  claim(subject: string): Promise<boolean>;
}

/** Allows everything. The default when no per-player cap is configured. */
export const unlimitedPlayers: PlayerRateLimiter = {
  claim: () => Promise.resolve(true),
};

export type Sleeper = (ms: number) => Promise<void>;

export const realSleep: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

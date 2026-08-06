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

export type Sleeper = (ms: number) => Promise<void>;

export const realSleep: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

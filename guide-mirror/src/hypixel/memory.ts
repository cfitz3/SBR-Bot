/**
 * In-memory implementations of the cache and rate-gate ports. Fully functional
 * for a single instance and used by the unit tests. Multi-instance deployments
 * swap these for Redis-backed adapters (same ports) — see HYPIXEL_DATA_LAYER.md.
 */
import type { CacheEntry, HypixelCache, RateAcquire, RateGate } from "./ports.js";

interface StoredEntry {
  data: unknown;
  fetchedAt: string;
  softExpiresAt: number;
}

export class InMemoryHypixelCache implements HypixelCache {
  private readonly store = new Map<string, StoredEntry>();

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return {
      data: entry.data as T,
      fetchedAt: entry.fetchedAt,
      expired: Date.now() > entry.softExpiresAt,
    };
  }

  async set<T>(key: string, data: T, ttlMs: number): Promise<void> {
    this.store.set(key, {
      data,
      fetchedAt: new Date().toISOString(),
      softExpiresAt: Date.now() + ttlMs,
    });
  }
}

/**
 * Token bucket driven by observed rate-limit headers. Starts optimistic (allows
 * traffic) and tightens to whatever the API reports.
 */
export class InMemoryRateGate implements RateGate {
  private remaining = Number.POSITIVE_INFINITY;
  private resetAt = 0;

  async acquire(): Promise<RateAcquire> {
    const now = Date.now();
    if (now >= this.resetAt) {
      // Window elapsed; assume budget refreshed until the next observation.
      this.remaining = Number.POSITIVE_INFINITY;
    }
    if (this.remaining <= 0) {
      return { allowed: false, retryAfterMs: Math.max(0, this.resetAt - now) };
    }
    if (Number.isFinite(this.remaining)) this.remaining -= 1;
    return { allowed: true };
  }

  observe(headers: Readonly<Record<string, string>>, status: number): void {
    const remaining = headers["ratelimit-remaining"];
    const reset = headers["ratelimit-reset"];
    const retryAfter = headers["retry-after"];

    if (remaining !== undefined && remaining !== "") this.remaining = Number(remaining);
    if (reset !== undefined && reset !== "") this.resetAt = Date.now() + Number(reset) * 1000;

    if (status === 429) {
      this.remaining = 0;
      if (retryAfter !== undefined && retryAfter !== "") {
        this.resetAt = Date.now() + Number(retryAfter) * 1000;
      }
    }
  }
}

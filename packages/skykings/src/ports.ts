/**
 * Injectable collaborators for the SkyKings client.
 *
 * `HttpFetcher` and `HttpResponse` are declared here rather than imported from
 * `@sbr/hypixel` even though the shapes are identical. TypeScript is structural,
 * so wiring can hand this package the very same `fetchHttp` the Hypixel client
 * uses — with its timeout and its network-failure-as-504 behaviour — without
 * this package taking a dependency on the Hypixel client, its NBT decoder and
 * its rate ledger to borrow two interfaces.
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

/**
 * Cache port.
 *
 * Deliberately narrower than the Hypixel one: there is no stale-if-error here.
 * A scammer listing is a safety signal, and serving an expired "clear" because
 * the API is down would turn an outage into a silent approval. When SkyKings
 * cannot be reached the client says so and lets the policy decide.
 */
export interface SkykingsCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, data: T, ttlMs: number): Promise<void>;
}

/** In-memory cache, for single-process wiring and tests. */
export class InMemorySkykingsCache implements SkykingsCache {
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

  async set<T>(key: string, data: T, ttlMs: number): Promise<void> {
    this.entries.set(key, { value: data, expiresAt: this.now() + ttlMs });
  }
}

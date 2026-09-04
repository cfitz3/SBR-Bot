/**
 * The entire Redis surface of this bot, in one file so a reader can take it in
 * at one sitting.
 *
 * Three things live here and nothing else: the response cache, the shared
 * budget that watches the rate-limit headers Hypixel sends back, and the
 * per-player claim that enforces one upstream read per player per hour. The
 * first two are ordinary politeness. The third is the promise this project
 * makes about how often it will ask about any one person, and it is a separate
 * mechanism from the cache on purpose — a cache is an optimisation somebody
 * could tune away, whereas this refuses the request (COMPLIANCE.md §2).
 *
 * Nothing here outlives its TTL, and nothing here is keyed by anything a player
 * could be reconstructed from: the cache holds an API response for a few hours,
 * and the claim holds the single byte `1`.
 */
import { createClient, type RedisClientType } from "redis";
import { loadConfig } from "../config.js";

export interface RedisContext {
  readonly client: RedisClientType;
  readonly keys: KeyFactory;
}

export type KeyFactory = ReturnType<typeof createKeyFactory>;

/**
 * Every key is prefixed and follows `{category}:{scope}:{id}`, so a category
 * can be scanned or flushed on its own.
 */
export function createKeyFactory(prefix: string) {
  const p = (s: string) => `${prefix}${s}`;
  return {
    prefix,
    /** The shared Hypixel budget, as observed from response headers. */
    rlHypixel: () => p("rl:hypixel"),
    /** One player claim on one endpoint. The key existing *is* the claim. */
    rlPlayer: (subject: string) => p(`rl:player:${subject}`),
    /** A cached upstream response. `resource` is the logical key the client picks. */
    cacheHypixel: (resource: string) => p(`cache:hypixel:${resource}`),
  };
}

const globalForRedis = globalThis as typeof globalThis & {
  __guideRedis?: Promise<RedisContext>;
};

/**
 * Create (or reuse) the shared, connected Redis context.
 *
 * The in-flight *promise* is memoised rather than the resolved context.
 * Memoising the context leaves a window spanning `await connect()`, and
 * concurrent callers at boot are the normal case rather than a corner: two of
 * them racing that window each open a connection, one of which is then orphaned
 * — never returned to a caller, never closed, still counted against the server
 * client limit.
 */
export async function getRedis(): Promise<RedisContext> {
  const existing = globalForRedis.__guideRedis;
  if (existing) return existing;

  const pending = (async (): Promise<RedisContext> => {
    const cfg = loadConfig();
    const client: RedisClientType = createClient({ url: cfg.redis.url });
    client.on("error", (error) => {
      // Never throw from the error listener; node-redis handles reconnection.
      console.error("[redis] client error:", error instanceof Error ? error.message : error);
    });
    await client.connect();
    return { client, keys: createKeyFactory(cfg.redis.keyPrefix) };
  })();

  globalForRedis.__guideRedis = pending;
  try {
    return await pending;
  } catch (error) {
    // A failed connect must not be memoised, or every later call re-awaits the
    // same rejection and a transient blip becomes a required restart.
    if (globalForRedis.__guideRedis === pending) delete globalForRedis.__guideRedis;
    throw error;
  }
}

export async function closeRedis(): Promise<void> {
  const pending = globalForRedis.__guideRedis;
  if (!pending) return;
  delete globalForRedis.__guideRedis;
  // Await a connect that may still be in flight, so a shutdown racing a boot
  // closes the client rather than leaving it to connect into an empty process.
  const ctx = await pending.catch(() => null);
  if (ctx) await ctx.client.quit().catch(() => undefined);
}

export interface RedisPingResult {
  readonly ok: boolean;
  readonly latencyMs: number | null;
  readonly detail?: string;
}

/** Liveness probe for the health registry. */
export async function pingRedis(): Promise<RedisPingResult> {
  const start = Date.now();
  try {
    const { client } = await getRedis();
    await client.ping();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (error) {
    return { ok: false, latencyMs: null, detail: error instanceof Error ? error.message : "unknown error" };
  }
}

/** HypixelCache — a soft-expiry envelope, so stale-if-error can still serve. */
export class RedisHypixelCache {
  constructor(private readonly ctx: RedisContext) {}

  async get<T>(key: string): Promise<{ data: T; fetchedAt: string; expired: boolean } | null> {
    const raw = await this.ctx.client.get(this.ctx.keys.cacheHypixel(key));
    if (!raw) return null;
    let e: { data: T; fetchedAt: string; softExpiresAt: number };
    try {
      e = JSON.parse(raw) as { data: T; fetchedAt: string; softExpiresAt: number };
    } catch {
      // A corrupt envelope is a cache miss, not an error: the fallback is to
      // fetch, which is exactly what the caller should do. Throwing here would
      // turn a bad byte in Redis into a failed player lookup.
      return null;
    }
    return { data: e.data, fetchedAt: e.fetchedAt, expired: Date.now() > e.softExpiresAt };
  }

  async set<T>(key: string, data: T, ttlMs: number): Promise<void> {
    const payload = JSON.stringify({
      data,
      fetchedAt: new Date().toISOString(),
      softExpiresAt: Date.now() + ttlMs,
    });
    // The hard expiry is six times the soft one: past the soft mark the entry
    // is only good for stale-if-error, and past this it is simply gone.
    const hardSeconds = Math.max(60, Math.ceil((ttlMs * 6) / 1000));
    await this.ctx.client.set(this.ctx.keys.cacheHypixel(key), payload, { EX: hardSeconds });
  }
}

/**
 * How long an observed Hypixel budget stays interesting.
 *
 * The upstream window is a minute; an hour is comfortably longer than any
 * window whose `remaining` could still mean something, and short enough that a
 * key nobody has written since a deploy simply goes away.
 */
const RATE_GATE_TTL_SECONDS = 3600;

/** RateGate — the shared budget, driven by observed response headers. */
export class RedisRateGate {
  constructor(private readonly ctx: RedisContext) {}

  async acquire(): Promise<{ allowed: boolean; retryAfterMs?: number }> {
    const key = this.ctx.keys.rlHypixel();
    const data = await this.ctx.client.hGetAll(key);
    const now = Date.now();
    const resetAt = data.resetAt ? Number(data.resetAt) : 0;
    let remaining = data.remaining !== undefined ? Number(data.remaining) : Number.POSITIVE_INFINITY;
    if (now >= resetAt) remaining = Number.POSITIVE_INFINITY;

    if (remaining <= 0) return { allowed: false, retryAfterMs: Math.max(0, resetAt - now) };
    if (Number.isFinite(remaining)) await this.ctx.client.hIncrBy(key, "remaining", -1);
    return { allowed: true };
  }

  observe(headers: Readonly<Record<string, string>>, status: number): void {
    const key = this.ctx.keys.rlHypixel();
    const upd: Record<string, string> = {};
    const remaining = headers["ratelimit-remaining"];
    const reset = headers["ratelimit-reset"];
    const retry = headers["retry-after"];
    if (remaining !== undefined && remaining !== "") upd.remaining = remaining;
    if (reset !== undefined && reset !== "") upd.resetAt = String(Date.now() + Number(reset) * 1000);
    if (status === 429) {
      upd.remaining = "0";
      if (retry !== undefined && retry !== "") upd.resetAt = String(Date.now() + Number(retry) * 1000);
    }
    if (Object.keys(upd).length > 0) {
      // Fire-and-forget: `observe` is synchronous in the port. The TTL is here
      // because this is a window, not a fact — a `remaining` from a budget that
      // lapsed hours ago describes nothing, and without an expiry it would be
      // the one key in this file that outlives every process that wrote it.
      void this.ctx.client
        .hSet(key, upd)
        .then(() => this.ctx.client.expire(key, RATE_GATE_TTL_SECONDS))
        .catch(() => {});
    }
  }
}

/**
 * PlayerRateLimiter — one upstream read per player per window (COMPLIANCE.md §2).
 *
 * `SET NX EX` is the whole mechanism: the key existing is the claim, so there
 * is no read-then-write race of the kind the shared gate tolerates. Two
 * processes racing the same subject produce exactly one winner, which matters
 * here in a way it does not for a soft budget — this cap is a promise made to
 * Hypixel, not an optimisation.
 *
 * The claim is spent on the *attempt*. Nothing releases it if the request then
 * fails, and that is deliberate: releasing on failure would let a flapping
 * endpoint be retried without limit, which is the pattern the cap prevents.
 */
export class RedisPlayerRateLimiter {
  private readonly windowSeconds: number;

  constructor(
    private readonly ctx: RedisContext,
    windowMs: number,
  ) {
    // A sub-second window is not a window; it is the caller asking for no cap,
    // and `createRedisAdapters` already says that by not constructing one.
    this.windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));
  }

  async claim(subject: string): Promise<boolean> {
    // An unreachable Redis must not turn into a failed player lookup. Erring
    // open is safe because the cache TTL (hours) is a second floor underneath
    // this one — losing the limiter does not uncork per-minute polling.
    try {
      const ok = await this.ctx.client.set(this.ctx.keys.rlPlayer(subject), "1", {
        NX: true,
        EX: this.windowSeconds,
      });
      return ok !== null;
    } catch {
      return true;
    }
  }
}

export interface RedisAdapterOptions {
  /**
   * The per-player window, from `config.hypixel.playerWindowMs`. Zero means no
   * per-player cap, and the limiter is then omitted entirely rather than built
   * with a window of nothing — the `unlimitedPlayers` default in the client is
   * the clearer way to say "no cap".
   */
  readonly playerWindowMs?: number;
}

export function createRedisAdapters(ctx: RedisContext, opts: RedisAdapterOptions = {}) {
  const playerWindowMs = opts.playerWindowMs ?? 0;
  return {
    hypixelCache: new RedisHypixelCache(ctx),
    rateGate: new RedisRateGate(ctx),
    playerLimiter: playerWindowMs > 0 ? new RedisPlayerRateLimiter(ctx, playerWindowMs) : undefined,
  };
}

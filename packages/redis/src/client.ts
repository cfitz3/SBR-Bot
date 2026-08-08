/**
 * @sbr/redis — thin wrapper over node-redis with the platform keyspace bound in.
 * Provides a shared client, prefixed key builders, JSON/envelope helpers, and a
 * health ping. Higher-level concerns (locks, rate buckets, cooldowns) build on
 * these primitives.
 */
import { createClient, type RedisClientType } from "redis";
import { loadConfig } from "@sbr/config";
import type { DataEnvelope, DataSource, Freshness } from "@sbr/shared-types";
import { createKeyFactory, type KeyFactory } from "./keys.js";

export interface RedisOptions {
  readonly url?: string;
  readonly keyPrefix?: string;
}

export interface RedisContext {
  readonly client: RedisClientType;
  readonly keys: KeyFactory;
}

const globalForRedis = globalThis as typeof globalThis & {
  __sbrRedis?: Promise<RedisContext>;
};

/**
 * Create (or reuse) the shared, connected Redis context.
 *
 * The in-flight *promise* is memoised, not the resolved context. Caching the
 * context would leave a window between the guard and the assignment spanning an
 * `await connect()` — and since every `setJson`/`getJson` call goes through
 * here, concurrent callers at boot are the normal case, not a corner. Two of
 * them racing that window each open a connection, one of which is then orphaned:
 * never returned to a caller, never closed by `closeRedis`, and still counted
 * against the server's client limit.
 */
export async function getRedis(options: RedisOptions = {}): Promise<RedisContext> {
  const existing = globalForRedis.__sbrRedis;
  if (existing) return existing;

  const pending = (async (): Promise<RedisContext> => {
    const cfg = loadConfig();
    const url = options.url ?? cfg.redis.url;
    const keyPrefix = options.keyPrefix ?? cfg.redis.keyPrefix;

    const client: RedisClientType = createClient({ url });
    client.on("error", (error) => {
      // Never throw from the error listener; connection retries are handled by node-redis.
      console.error("[redis] client error:", error instanceof Error ? error.message : error);
    });
    await client.connect();

    return { client, keys: createKeyFactory(keyPrefix) };
  })();

  globalForRedis.__sbrRedis = pending;
  try {
    return await pending;
  } catch (error) {
    // A failed connect must not be memoised, or the process is permanently
    // poisoned: every later call would re-await the same rejection and never
    // retry, turning a transient Redis blip into a required restart.
    if (globalForRedis.__sbrRedis === pending) delete globalForRedis.__sbrRedis;
    throw error;
  }
}

export async function closeRedis(): Promise<void> {
  const pending = globalForRedis.__sbrRedis;
  if (!pending) return;
  delete globalForRedis.__sbrRedis;
  // Await the connect that may still be in flight, so a shutdown racing a boot
  // closes the client rather than leaving it to connect into an empty process.
  const ctx = await pending.catch(() => null);
  if (ctx) await ctx.client.quit().catch(() => undefined);
}

// ─────────────────────────── JSON helpers ───────────────────────────

export async function setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
  const { client } = await getRedis();
  const payload = JSON.stringify(value);
  if (ttlSeconds && ttlSeconds > 0) {
    await client.set(key, payload, { EX: ttlSeconds });
  } else {
    await client.set(key, payload);
  }
}

export async function getJson<T>(key: string): Promise<T | null> {
  const { client } = await getRedis();
  const raw = await client.get(key);
  return raw ? (JSON.parse(raw) as T) : null;
}

/**
 * Store a value with cache provenance so reads can report freshness and detect
 * staleness (HYPIXEL_DATA_LAYER.md). Pair with `getCached`.
 */
export async function setCached<T>(
  key: string,
  data: T,
  ttlSeconds: number,
  meta: { source: DataSource; freshness?: Freshness },
): Promise<void> {
  const envelope: DataEnvelope<T> = {
    data,
    fetchedAt: new Date().toISOString(),
    freshness: meta.freshness ?? "LIVE",
    source: meta.source,
  };
  await setJson(key, envelope, ttlSeconds);
}

export async function getCached<T>(key: string): Promise<DataEnvelope<T> | null> {
  return getJson<DataEnvelope<T>>(key);
}

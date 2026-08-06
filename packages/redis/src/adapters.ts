/**
 * Concrete Redis implementations of the domain ports (lock, cooldown, hypixel
 * cache, rate gate, analytics buffer, enforcement mirror). Shapes match the
 * ports structurally; the app composition roots verify conformance by passing
 * these where the port type is expected.
 */
import { randomUUID } from "node:crypto";
import type { AnalyticsEvent, ModerationActionDTO } from "@sbr/shared-types";
import type { RedisContext } from "./client.js";

const RELEASE_LOCK = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** LockPort — SET NX PX, owner-checked release. */
export class RedisLock {
  constructor(private readonly ctx: RedisContext) {}
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const ok = await this.ctx.client.set(key, token, { NX: true, PX: ttlMs });
    return ok ? token : null;
  }
  async release(key: string, token: string): Promise<void> {
    await this.ctx.client.eval(RELEASE_LOCK, { keys: [key], arguments: [token] });
  }
}

/** CooldownGate — presence key with PX ttl. */
export class RedisCooldownGate {
  constructor(private readonly ctx: RedisContext) {}
  async consume(key: string, ttlMs: number): Promise<{ allowed: boolean; retryAfterMs?: number }> {
    const ok = await this.ctx.client.set(key, "1", { NX: true, PX: ttlMs });
    if (ok) return { allowed: true };
    const ttl = await this.ctx.client.pTTL(key);
    return { allowed: false, retryAfterMs: ttl > 0 ? ttl : ttlMs };
  }
}

/** HypixelCache — soft-expiry envelope so stale-if-error can still serve. */
export class RedisHypixelCache {
  constructor(private readonly ctx: RedisContext) {}
  async get<T>(key: string): Promise<{ data: T; fetchedAt: string; expired: boolean } | null> {
    const raw = await this.ctx.client.get(key);
    if (!raw) return null;
    const e = JSON.parse(raw) as { data: T; fetchedAt: string; softExpiresAt: number };
    return { data: e.data, fetchedAt: e.fetchedAt, expired: Date.now() > e.softExpiresAt };
  }
  async set<T>(key: string, data: T, ttlMs: number): Promise<void> {
    const payload = JSON.stringify({ data, fetchedAt: new Date().toISOString(), softExpiresAt: Date.now() + ttlMs });
    const hardSeconds = Math.max(60, Math.ceil((ttlMs * 6) / 1000));
    await this.ctx.client.set(key, payload, { EX: hardSeconds });
  }
}

/** RateGate — shared Hypixel budget driven by observed headers. */
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
      // Fire-and-forget: observe() is sync in the port.
      void this.ctx.client.hSet(key, upd).catch(() => {});
    }
  }
}

/** AnalyticsBuffer — append events to the Redis Stream drained by workers. */
export class RedisAnalyticsBuffer {
  constructor(private readonly ctx: RedisContext) {}
  async append(event: AnalyticsEvent): Promise<void> {
    await this.ctx.client.xAdd(
      this.ctx.keys.analyticsBuffer(),
      "*",
      {
        type: event.type,
        guildId: event.guildId ?? "",
        surface: event.surface,
        ts: event.ts,
        props: JSON.stringify(event.props ?? {}),
      },
      { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 100_000 } },
    );
  }
}

/** EnforcementMirror — reflect active mute/ban into Redis for fast checks. */
export class RedisEnforcementMirror {
  constructor(private readonly ctx: RedisContext) {}
  async apply(action: ModerationActionDTO): Promise<void> {
    const target = action.targetDiscordId;
    if (!target) return;
    const { keys, client } = this.ctx;

    switch (action.type) {
      case "MUTE": {
        const value = JSON.stringify({ actionId: action.id, until: action.expiresAt, surfaces: action.surfaces });
        const key = keys.mute(action.guildId, target);
        if (action.durationSeconds && action.durationSeconds > 0) {
          await client.set(key, value, { EX: action.durationSeconds });
        } else {
          await client.set(key, value);
        }
        break;
      }
      case "BAN": {
        const value = JSON.stringify({ actionId: action.id, until: action.expiresAt });
        const key = keys.ban(action.guildId, target);
        if (action.durationSeconds && action.durationSeconds > 0) {
          await client.set(key, value, { EX: action.durationSeconds });
        } else {
          await client.set(key, value);
        }
        break;
      }
      case "UNMUTE":
        await client.del(keys.mute(action.guildId, target));
        break;
      case "UNBAN":
        await client.del(keys.ban(action.guildId, target));
        break;
      default:
        break;
    }
  }
}

export function createRedisAdapters(ctx: RedisContext) {
  return {
    lock: new RedisLock(ctx),
    cooldowns: new RedisCooldownGate(ctx),
    hypixelCache: new RedisHypixelCache(ctx),
    rateGate: new RedisRateGate(ctx),
    analyticsBuffer: new RedisAnalyticsBuffer(ctx),
    enforcement: new RedisEnforcementMirror(ctx),
  };
}

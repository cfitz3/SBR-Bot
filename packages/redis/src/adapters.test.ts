/**
 * The Redis adapters, exercised against an in-memory stand-in for node-redis.
 *
 * A fake rather than a real server because what is worth testing here is the
 * decisions — which window a counter belongs to, whether a corrupt value is a
 * miss or a throw, what a malformed bus payload does — and none of those are
 * decisions Redis makes. The commands used are narrow and stable enough that a
 * fake is not much of a lie; the ones with real semantics worth respecting
 * (`SET NX`, TTLs, `INCR` on a missing key) are implemented rather than stubbed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RedisClientType } from "redis";
import {
  RedisAutomodCounters,
  RedisBinSource,
  RedisCooldownGate,
  RedisHeartbeat,
  RedisHypixelCache,
  RedisLock,
  RedisPlayerRateLimiter,
  RedisPriceSource,
  RedisRateGate,
  RedisRoleDirtySet,
  RedisRoleRefusals,
  RedisTallyStore,
  isRunnableJob,
  parseBridgeBusMessage,
  parseJobTriggerMessage,
  parseMemberBusMessage,
  parseModAckMessage,
  parseModBusMessage,
  startHeartbeat,
  RUNNABLE_JOBS,
} from "./adapters.js";
import { createKeyFactory } from "./keys.js";
import type { RedisContext } from "./client.js";

/** No expiry. Redis reports -1 for a key with no TTL and -2 for a missing one. */
const NO_TTL = -1;

interface Entry {
  value: string | Record<string, string> | Set<string>;
  /** Epoch ms, or null for no expiry. */
  expiresAt: number | null;
}

/**
 * The half of node-redis these adapters actually use. Time is injectable so a
 * TTL test does not have to wait one out.
 */
class FakeRedis {
  readonly store = new Map<string, Entry>();
  now = 1_000_000;
  /** Set to make every command throw, for the "Redis is down" paths. */
  broken = false;
  readonly published: { channel: string; message: string }[] = [];

  private guard(): void {
    if (this.broken) throw new Error("redis unreachable");
  }

  private live(key: string): Entry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  private ttlMsOf(options?: { EX?: number; PX?: number }): number | null {
    if (options?.PX !== undefined) return options.PX;
    if (options?.EX !== undefined) return options.EX * 1000;
    return null;
  }

  async set(
    key: string,
    value: string,
    options?: { NX?: boolean; EX?: number; PX?: number },
  ): Promise<string | null> {
    this.guard();
    if (options?.NX && this.live(key)) return null;
    const ms = this.ttlMsOf(options);
    this.store.set(key, { value, expiresAt: ms === null ? null : this.now + ms });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    this.guard();
    const entry = this.live(key);
    return typeof entry?.value === "string" ? entry.value : null;
  }

  async del(key: string): Promise<number> {
    this.guard();
    return this.store.delete(key) ? 1 : 0;
  }

  async pTTL(key: string): Promise<number> {
    this.guard();
    const entry = this.live(key);
    if (!entry) return -2;
    return entry.expiresAt === null ? NO_TTL : entry.expiresAt - this.now;
  }

  async ttl(key: string): Promise<number> {
    const ms = await this.pTTL(key);
    return ms < 0 ? ms : Math.ceil(ms / 1000);
  }

  async incr(key: string): Promise<number> {
    this.guard();
    const entry = this.live(key);
    const next = (entry && typeof entry.value === "string" ? Number(entry.value) : 0) + 1;
    this.store.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
    return next;
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    this.guard();
    const entry = this.live(key);
    if (!entry) return false;
    entry.expiresAt = this.now + seconds * 1000;
    return true;
  }

  async hSet(key: string, field: string | Record<string, string>, value?: string): Promise<number> {
    this.guard();
    const entry = this.live(key);
    const hash = (entry?.value as Record<string, string> | undefined) ?? {};
    if (typeof field === "string") hash[field] = value ?? "";
    else Object.assign(hash, field);
    this.store.set(key, { value: hash, expiresAt: entry?.expiresAt ?? null });
    return 1;
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    this.guard();
    const entry = this.live(key);
    return entry && !(entry.value instanceof Set) && typeof entry.value !== "string"
      ? { ...entry.value }
      : {};
  }

  async hIncrBy(key: string, field: string, by: number): Promise<number> {
    this.guard();
    const hash = await this.hGetAll(key);
    const next = Number(hash[field] ?? 0) + by;
    await this.hSet(key, field, String(next));
    return next;
  }

  async sAdd(key: string, members: readonly string[]): Promise<number> {
    this.guard();
    const entry = this.live(key);
    const set = (entry?.value as Set<string> | undefined) ?? new Set<string>();
    for (const m of members) set.add(m);
    this.store.set(key, { value: set, expiresAt: entry?.expiresAt ?? null });
    return set.size;
  }

  async sCard(key: string): Promise<number> {
    this.guard();
    const entry = this.live(key);
    return entry?.value instanceof Set ? entry.value.size : 0;
  }

  async publish(channel: string, message: string): Promise<number> {
    this.guard();
    this.published.push({ channel, message });
    return 1;
  }

  async eval(_script: string, _opts: { keys: string[]; arguments: string[] }): Promise<number> {
    this.guard();
    const key = _opts.keys[0] ?? "";
    const entry = this.live(key);
    if (entry && entry.value === _opts.arguments[0]) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }

  async *scanIterator(options: { MATCH: string }): AsyncGenerator<string> {
    this.guard();
    const rx = new RegExp(`^${options.MATCH.split("*").map(escapeRx).join(".*")}$`);
    for (const key of [...this.store.keys()]) {
      if (rx.test(key) && this.live(key)) yield key;
    }
  }
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function harness(): { redis: FakeRedis; ctx: RedisContext } {
  const redis = new FakeRedis();
  return {
    redis,
    ctx: { client: redis as unknown as RedisClientType, keys: createKeyFactory("sbr:") },
  };
}

// ───────────────────────────── lock & cooldown ─────────────────────────────

test("a lock is exclusive, and released only by its owner", async () => {
  const { ctx } = harness();
  const lock = new RedisLock(ctx);

  const mine = await lock.acquire("job:x", 30_000);
  assert.ok(mine);
  assert.equal(await lock.acquire("job:x", 30_000), null);

  // Somebody else's token must not free it.
  await lock.release("job:x", "not-my-token");
  assert.equal(await lock.acquire("job:x", 30_000), null);

  await lock.release("job:x", mine);
  assert.ok(await lock.acquire("job:x", 30_000));
});

test("a lock lapses on its own once the ttl passes", async () => {
  const { redis, ctx } = harness();
  const lock = new RedisLock(ctx);

  assert.ok(await lock.acquire("job:x", 30_000));
  redis.now += 30_001;
  assert.ok(await lock.acquire("job:x", 30_000), "a crashed holder must not hold forever");
});

test("a cooldown reports how long is left, not just that it is on", async () => {
  const { redis, ctx } = harness();
  const gate = new RedisCooldownGate(ctx);

  assert.deepEqual(await gate.consume("cd:a", 10_000), { allowed: true });
  redis.now += 4_000;

  const denied = await gate.consume("cd:a", 10_000);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 6_000);
});

// ───────────────────────────── automod counters ─────────────────────────────

const spamRule = [{ ruleId: "r1", kind: "spam" as const, windowSeconds: 10 }];

test("the spam window tumbles rather than sliding forward on every message", async () => {
  const { redis, ctx } = harness();
  const counters = new RedisAutomodCounters(ctx);

  // Somebody chatting steadily just under the rate. Before the window was made
  // to tumble, each message pushed the expiry out and this reached five.
  let highest = 0;
  for (let i = 0; i < 6; i += 1) {
    const read = await counters.read("g", "author", `line ${i}`, spamRule);
    highest = Math.max(highest, read["r1"] ?? 0);
    redis.now += 9_000;
  }

  assert.equal(highest, 2, "a lawful chatter must never approach a flood threshold");
});

test("a real burst inside one window still counts", async () => {
  const { redis, ctx } = harness();
  const counters = new RedisAutomodCounters(ctx);

  let last = 0;
  for (let i = 0; i < 5; i += 1) {
    last = (await counters.read("g", "author", `line ${i}`, spamRule))["r1"] ?? 0;
    redis.now += 500;
  }

  assert.equal(last, 5);
});

test("repeat counting normalises case and whitespace", async () => {
  const { ctx } = harness();
  const counters = new RedisAutomodCounters(ctx);
  const rule = [{ ruleId: "r2", kind: "repeat" as const, windowSeconds: 30 }];

  await counters.read("g", "author", "Stop", rule);
  const second = await counters.read("g", "author", "  stop   ", rule);

  assert.equal(second["r2"], 2, "a trailing space must not defeat the counter");
});

test("an unreachable counter store fires nothing rather than everything", async () => {
  const { redis, ctx } = harness();
  redis.broken = true;

  const read = await new RedisAutomodCounters(ctx).read("g", "author", "hi", spamRule);
  assert.deepEqual(read, { r1: 0 });
});

test("no requested rules is no round trip", async () => {
  const { redis, ctx } = harness();
  redis.broken = true;
  assert.deepEqual(await new RedisAutomodCounters(ctx).read("g", "a", "hi", []), {});
});

// ───────────────────────────── caches ─────────────────────────────

test("a cached hypixel entry reports soft expiry without disappearing", async () => {
  const { redis, ctx } = harness();
  const cache = new RedisHypixelCache(ctx);

  await cache.set("cache:p", { name: "Notch" }, 60_000);
  const fresh = await cache.get<{ name: string }>("cache:p");
  assert.equal(fresh?.expired, false);
  assert.equal(fresh?.data.name, "Notch");

  // Soft expiry is wall-clock, so move the clock the adapter actually reads.
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    assert.equal((await cache.get("cache:p"))?.expired, true, "stale-if-error still serves");
  } finally {
    Date.now = realNow;
  }
  assert.ok(redis.store.has("cache:p"), "the hard ttl is much longer than the soft one");
});

test("a corrupt cache entry is a miss, not a thrown lookup", async () => {
  const { redis, ctx } = harness();
  redis.store.set("cache:p", { value: "{not json", expiresAt: null });

  assert.equal(await new RedisHypixelCache(ctx).get("cache:p"), null);
});

test("an unpriced item is unknown rather than free", async () => {
  const { ctx } = harness();
  assert.equal(await new RedisPriceSource(ctx).getItem("HYPERION"), null);
});

test("a price older than the sweep cadence is served, marked stale", async () => {
  const { redis, ctx } = harness();
  const key = ctx.keys.cachePriceItem("HYPERION");
  redis.store.set(key, {
    value: JSON.stringify({
      bazaarInstantSell: 1,
      bazaarInstantBuy: 2,
      lowestBin: 3,
      estimatedValue: 4,
      fetchedAt: Date.now() - 6 * 60_000,
    }),
    expiresAt: null,
  });

  const read = await new RedisPriceSource(ctx).getItem("HYPERION");
  assert.equal(read?.stale, true);
  assert.equal(read?.price.lowestBin, 3);
});

test("a corrupt price entry is a miss rather than a parse error at the call site", async () => {
  const { redis, ctx } = harness();
  redis.store.set(ctx.keys.cachePriceItem("X"), { value: "}{", expiresAt: null });
  assert.equal(await new RedisPriceSource(ctx).getItem("X"), null);
});

test("a corrupt bin entry is a miss too", async () => {
  const { redis, ctx } = harness();
  redis.store.set(ctx.keys.cacheLowestBin("X"), { value: "nope", expiresAt: null });
  assert.equal(await new RedisBinSource(ctx).get("X"), null);
});

// ───────────────────────────── rate gate ─────────────────────────────

test("an exhausted budget denies with the wait, and refills when the window passes", async () => {
  const { ctx } = harness();
  const gate = new RedisRateGate(ctx);

  gate.observe({ "ratelimit-remaining": "1", "ratelimit-reset": "60" }, 200);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal((await gate.acquire()).allowed, true);
  const denied = await gate.acquire();
  assert.equal(denied.allowed, false);
  assert.ok((denied.retryAfterMs ?? 0) > 0);
});

test("a 429 closes the gate even when the headers say otherwise", async () => {
  const { ctx } = harness();
  const gate = new RedisRateGate(ctx);

  gate.observe({ "ratelimit-remaining": "40", "retry-after": "30" }, 429);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal((await gate.acquire()).allowed, false);
});

test("an unobserved gate lets the first call through", async () => {
  const { ctx } = harness();
  assert.deepEqual(await new RedisRateGate(ctx).acquire(), { allowed: true });
});

// ───────────────────────────── bus payload validation ─────────────────────────────

test("a mod-bus payload is validated, not trusted", () => {
  assert.equal(parseModBusMessage("not json"), null);
  assert.equal(parseModBusMessage(JSON.stringify({ kind: "OTHER", guildId: "g", command: "/g mute x" })), null);
  assert.equal(parseModBusMessage(JSON.stringify({ kind: "GAME_COMMAND", guildId: "", command: "/g mute x" })), null);
  assert.equal(parseModBusMessage(JSON.stringify({ kind: "GAME_COMMAND", guildId: "g", command: "" })), null);

  const ok = parseModBusMessage(
    JSON.stringify({ kind: "GAME_COMMAND", guildId: "g", command: "/g mute Notch 1h" }),
  );
  assert.equal(ok?.command, "/g mute Notch 1h");
  assert.equal(ok?.correlationId, "", "a missing correlation id is blank, not a rejection");
});

test("a mod-ack payload is validated too, because it settles a punishment", () => {
  const base = { kind: "GAME_COMMAND_ACK", guildId: "g", correlationId: "c", outcome: "TYPED" };
  assert.equal(parseModAckMessage("not json"), null);
  assert.equal(parseModAckMessage(JSON.stringify({ ...base, kind: "GAME_COMMAND" })), null);
  assert.equal(parseModAckMessage(JSON.stringify({ ...base, guildId: "" })), null);
  // Unlike the instruction, a blank correlation id is useless here: an ack that
  // answers no particular command would settle whichever one asked first.
  assert.equal(parseModAckMessage(JSON.stringify({ ...base, correlationId: "" })), null);
  // An unknown outcome must not be waved through as a confirmation.
  assert.equal(parseModAckMessage(JSON.stringify({ ...base, outcome: "PROBABLY_FINE" })), null);

  const ok = parseModAckMessage(JSON.stringify({ ...base, outcome: "REFUSED_INGAME", detail: "no such player" }));
  assert.equal(ok?.outcome, "REFUSED_INGAME");
  assert.equal(ok?.detail, "no such player");
  assert.equal(parseModAckMessage(JSON.stringify(base))?.detail, "", "a missing detail is blank");
});

test("a reminder with an unusable time or title is dropped", () => {
  const base = {
    kind: "event-reminder",
    guildId: "g",
    eventId: "e",
    title: "Dungeon run",
    startsAt: "2026-08-21T12:00:00.000Z",
    offsetMinutes: 15,
    discordIds: ["123456789012345678"],
  };

  assert.ok(parseBridgeBusMessage(JSON.stringify(base)));
  assert.equal(parseBridgeBusMessage(JSON.stringify({ ...base, startsAt: "soon" })), null);
  assert.equal(parseBridgeBusMessage(JSON.stringify({ ...base, title: "" })), null);
  assert.equal(parseBridgeBusMessage(JSON.stringify({ ...base, offsetMinutes: "15" })), null);
});

test("only snowflake-shaped ids survive to be pinged", () => {
  const parsed = parseBridgeBusMessage(
    JSON.stringify({
      kind: "event-reminder",
      guildId: "g",
      eventId: "e",
      title: "t",
      startsAt: "2026-08-21T12:00:00.000Z",
      offsetMinutes: 5,
      discordIds: ["123456789012345678", "@everyone", 42, null, "12"],
    }),
  );

  assert.deepEqual(parsed?.discordIds, ["123456789012345678"]);
});

test("a reminder with nothing left to ping is still delivered", () => {
  const parsed = parseBridgeBusMessage(
    JSON.stringify({
      kind: "event-reminder",
      guildId: "g",
      eventId: "e",
      title: "t",
      startsAt: "2026-08-21T12:00:00.000Z",
      offsetMinutes: 5,
      discordIds: "everyone",
    }),
  );

  assert.deepEqual(parsed?.discordIds, []);
});

test("a job trigger naming a job that does not exist is refused at the drain", () => {
  const at = "2026-08-21T12:00:00.000Z";
  assert.equal(
    parseJobTriggerMessage(JSON.stringify({ jobName: "rm-rf", guildId: "g", actorDiscordId: "1", at })),
    null,
  );
  assert.equal(
    parseJobTriggerMessage(JSON.stringify({ jobName: "guild-scan", guildId: "", actorDiscordId: "1", at })),
    null,
  );
  assert.equal(
    parseJobTriggerMessage(JSON.stringify({ jobName: "guild-scan", guildId: "g", actorDiscordId: "1", at }))
      ?.jobName,
    "guild-scan",
  );
});

test("the runnable-job list is an allow-list, and the continuous jobs are not on it", () => {
  assert.ok(isRunnableJob("guild-scan"));
  assert.ok(!isRunnableJob("heartbeat"));
  assert.ok(!isRunnableJob("analytics-ingest"));
  assert.equal(new Set(RUNNABLE_JOBS).size, RUNNABLE_JOBS.length, "no duplicates");
});

test("a member-bus payload keeps a missing count as null rather than zero", () => {
  const parsed = parseMemberBusMessage(
    JSON.stringify({ kind: "member-join", guildId: "g", discordId: "1", username: "n", serverName: "s" }),
  );
  assert.equal(parsed?.memberCount, null);

  assert.equal(parseMemberBusMessage(JSON.stringify({ kind: "member-renamed", guildId: "g", discordId: "1" })), null);
  assert.equal(parseMemberBusMessage(JSON.stringify({ kind: "member-join", guildId: "g", discordId: "" })), null);
});

// ───────────────────────────── role sync bookkeeping ─────────────────────────────

test("marking is deduped, skips blanks, and never fails its caller", async () => {
  const { redis, ctx } = harness();
  const dirty = new RedisRoleDirtySet(ctx);

  await dirty.mark("g", ["a", "a", "b", ""]);
  assert.equal(await dirty.pending("g"), 2);

  redis.broken = true;
  await assert.doesNotReject(() => dirty.mark("g", ["c"]));
  assert.equal(await dirty.pending("g"), 0, "an unreadable count renders as zero, not as an error");
});

test("refusals are keyed by role, newest first, and clearable", async () => {
  const { redis, ctx } = harness();
  const refusals = new RedisRoleRefusals(ctx, 3600);

  await refusals.record("g", "role-1", "above me in the list");
  redis.now += 1_000;
  await refusals.record("g", "role-2", "deleted");
  await refusals.record("g", "role-1", "still above me");

  const listed = await refusals.list("g");
  assert.equal(listed.length, 2, "one entry per role, not per member");
  assert.equal(listed[0]?.roleId, "role-1");
  assert.equal(listed[0]?.detail, "still above me");

  await refusals.clear("g");
  assert.deepEqual(await refusals.list("g"), []);
});

test("an unreadable refusal entry is dropped rather than rendered as garbage", async () => {
  const { redis, ctx } = harness();
  await redis.hSet(ctx.keys.rolesRefused("g"), "role-1", "{oops");
  await new RedisRoleRefusals(ctx, 60).record("g", "role-2", "fine");

  const listed = await new RedisRoleRefusals(ctx, 60).list("g");
  assert.deepEqual(
    listed.map((r) => r.roleId),
    ["role-2"],
  );
});

// ───────────────────────────── heartbeats & tallies ─────────────────────────────

test("a beat that expired is simply absent", async () => {
  const { redis, ctx } = harness();
  const heartbeat = new RedisHeartbeat(ctx);

  await heartbeat.beat({ service: "workers", instance: "w-1", details: {} }, 45);
  assert.equal((await heartbeat.list()).length, 1);

  redis.now += 46_000;
  assert.deepEqual(await heartbeat.list(), []);
});

test("an unreadable beat leaves the service absent rather than throwing", async () => {
  const { redis, ctx } = harness();
  redis.store.set(ctx.keys.heartbeat("workers", "w-1"), { value: "{", expiresAt: null });

  assert.deepEqual(await new RedisHeartbeat(ctx).list(), []);
});

test("startHeartbeat beats immediately and stops cleanly", async () => {
  const { ctx } = harness();
  const heartbeat = new RedisHeartbeat(ctx);

  const stop = startHeartbeat(heartbeat, () => ({ service: "svc", instance: "i-1", details: {} }), 60_000);
  await new Promise((resolve) => setImmediate(resolve));
  stop();

  const listed = await heartbeat.list();
  assert.equal(listed[0]?.service, "svc");
  assert.equal(listed[0]?.pid, process.pid);
});

test("a tally counts up and keeps its window fresh", async () => {
  const { ctx } = harness();
  const tallies = new RedisTallyStore(ctx, 3600);

  assert.equal(await tallies.bump("g", "cringe", "user"), 1);
  assert.equal(await tallies.bump("g", "cringe", "user"), 2);
  assert.equal(await tallies.bump("g", "cringe", "other"), 1, "tallies are per subject");
});

// ─────────────────────── the per-player Hypixel window ──────────────────────

test("a player window admits one claim and refuses the rest until it rolls", async () => {
  const { redis, ctx } = harness();
  const limiter = new RedisPlayerRateLimiter(ctx, 60 * 60_000);

  assert.equal(await limiter.claim("uuid-aria:player"), true);
  assert.equal(await limiter.claim("uuid-aria:player"), false);
  assert.equal(await limiter.claim("uuid-aria:player"), false);

  // Subjects are independent — a claim on one player says nothing about another,
  // and a claim on one endpoint says nothing about the same player's others.
  assert.equal(await limiter.claim("uuid-bex:player"), true);
  assert.equal(await limiter.claim("uuid-aria:museum"), true);

  redis.now += 60 * 60_000 + 1;
  assert.equal(await limiter.claim("uuid-aria:player"), true);
});

test("an unreachable Redis errs open rather than failing the lookup", async () => {
  // The cache TTL is a second floor underneath this one, so erring open costs
  // freshness discipline, not the cap. Erring closed would cost the feature.
  const failing = {
    client: {
      set: () => Promise.reject(new Error("connection lost")),
    } as unknown as RedisClientType,
    keys: createKeyFactory("sbr:"),
  };
  const limiter = new RedisPlayerRateLimiter(failing, 60 * 60_000);
  assert.equal(await limiter.claim("uuid-aria:player"), true);
});

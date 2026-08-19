/**
 * Concrete Redis implementations of the domain ports (lock, cooldown, hypixel
 * cache, rate gate, analytics buffer, enforcement mirror). Shapes match the
 * ports structurally; the app composition roots verify conformance by passing
 * these where the port type is expected.
 */
import { randomUUID } from "node:crypto";
import type {
  AnalyticsEvent,
  AntiRaidStateDTO,
  LockdownStateDTO,
  ModerationActionDTO,
  PriceDTO,
} from "@sbr/shared-types";
import type { RedisContext } from "./client.js";

/**
 * How long a `!cringe` tally survives without being added to.
 *
 * A running joke nobody has touched in three months is not a running joke, and
 * the alternative — a counter that lives forever — makes Redis the durable home
 * of a number nobody chose to keep and nothing migrates.
 */
const FUN_TALLY_TTL_SECONDS = 90 * 24 * 3600;

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

/**
 * TallyStore — a running total that forgets a joke nobody is still telling.
 *
 * The expiry is reset on every bump rather than set once, so a counter's life
 * is measured from the last time somebody used it. That is the difference
 * between a tally that quietly disappears mid-joke and one that disappears when
 * the joke does. Nothing here can read a total without adding to it, which is
 * the port's guarantee rather than an oversight.
 */
export class RedisTallyStore {
  constructor(
    private readonly ctx: RedisContext,
    private readonly ttlSeconds: number,
  ) {}
  async bump(guildId: string, name: string, subject: string): Promise<number> {
    const key = this.ctx.keys.funTally(guildId, name, subject);
    const total = await this.ctx.client.incr(key);
    await this.ctx.client.expire(key, this.ttlSeconds);
    return total;
  }
}

/** What the automod evaluator needs read before it can judge a windowed rule. */
export interface AutomodCounterRequest {
  readonly ruleId: string;
  readonly kind: "spam" | "repeat";
  readonly windowSeconds: number;
}

/**
 * The windowed side of automod: how many messages, and how many repeats.
 *
 * Counting is a bump-and-read rather than a read: the message being judged is
 * part of its own window, so "the fifth message in ten seconds" has to see
 * itself to be the fifth. The expiry is set from the current bump, which makes
 * the window sliding-ish — good enough for flood detection, and far cheaper
 * than a sorted set of timestamps per author per rule.
 *
 * A Redis failure returns zero for that rule rather than throwing. Automod
 * mutes people; the failure mode when the counter store is unreachable must be
 * "nothing fires", not "everything does" and not "the relay stops".
 */
export class RedisAutomodCounters {
  constructor(private readonly ctx: RedisContext) {}

  async read(
    guildId: string,
    author: string,
    text: string,
    requests: readonly AutomodCounterRequest[],
  ): Promise<Readonly<Record<string, number>>> {
    if (requests.length === 0) return {};
    const hash = hashText(text);
    const out: Record<string, number> = {};
    await Promise.all(
      requests.map(async (request) => {
        const key =
          request.kind === "spam"
            ? this.ctx.keys.automodSpam(guildId, request.ruleId, author)
            : this.ctx.keys.automodRepeat(guildId, request.ruleId, author, hash);
        try {
          const total = await this.ctx.client.incr(key);
          await this.ctx.client.expire(key, Math.max(1, Math.ceil(request.windowSeconds)));
          out[request.ruleId] = total;
        } catch {
          out[request.ruleId] = 0;
        }
      }),
    );
    return out;
  }
}

/**
 * A short, stable fingerprint of a message, used only to key the repeat
 * counter. Whitespace and case are normalised so "STOP" and "stop  " are the
 * same line; the point is to catch somebody repeating themselves, and a counter
 * defeated by a trailing space would catch nobody.
 */
function hashText(text: string): string {
  const normalised = text.trim().toLowerCase().replace(/\s+/g, " ");
  let h = 0x811c9dc5;
  for (let i = 0; i < normalised.length; i += 1) {
    h ^= normalised.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
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

/** One buffered event, with the stream id needed to acknowledge it. */
export interface BufferedAnalyticsEvent {
  readonly id: string;
  readonly guildId: string | null;
  readonly discordId: string | null;
  readonly surface: string;
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly ts: string;
}

/**
 * Drain side of the analytics buffer, read by the `analytics-ingest` job.
 *
 * XRANGE + XDEL rather than a consumer group: exactly one locked worker drains
 * this stream, so the delivery tracking a group provides would be bookkeeping
 * for a concurrency that cannot happen — and XDEL is what actually reclaims the
 * memory, which acknowledging in a group alone does not.
 */
export class RedisAnalyticsDrain {
  constructor(private readonly ctx: RedisContext) {}

  async read(count: number): Promise<readonly BufferedAnalyticsEvent[]> {
    const entries = await this.ctx.client.xRange(this.ctx.keys.analyticsBuffer(), "-", "+", {
      COUNT: count,
    });
    return entries.map((entry) => {
      const m = entry.message;
      let props: Record<string, unknown> = {};
      try {
        // A malformed props blob costs that event its dimensions, not its count.
        props = m["props"] ? (JSON.parse(m["props"]) as Record<string, unknown>) : {};
      } catch {
        props = {};
      }
      return {
        id: entry.id,
        guildId: m["guildId"] ? m["guildId"] : null,
        discordId: m["discordId"] ? m["discordId"] : null,
        surface: m["surface"] ?? "SYSTEM",
        type: m["type"] ?? "unknown",
        props,
        ts: m["ts"] ?? new Date().toISOString(),
      };
    });
  }

  async ack(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.ctx.client.xDel(this.ctx.keys.analyticsBuffer(), [...ids]);
  }
}

/**
 * ConfigBus — the fan-out that makes a panel edit visible to a running bot.
 *
 * Every process caches guild config in memory for a few seconds so the bridge
 * isn't doing a database round trip per relayed line. That cache is what this
 * exists to punch through: without it a staffer's toggle appears to do nothing
 * until the TTL lapses, and "did my change save?" becomes a support question.
 *
 * Publishing is a plain PUBLISH on the shared client. Subscribing needs its own
 * connection — a node-redis client in subscriber mode will not serve ordinary
 * commands — so `subscribe` duplicates rather than borrowing the shared one.
 */
export class RedisConfigBus {
  constructor(private readonly ctx: RedisContext) {}

  async publish(guildId: string): Promise<void> {
    await this.ctx.client.publish(
      this.ctx.keys.chanConfig(guildId),
      JSON.stringify({ guildId, at: new Date().toISOString() }),
    );
  }

  /**
   * Listen for every guild's config changes, and return the unsubscribe.
   *
   * Pattern-subscribed rather than one channel per guild: a bot's guild set is
   * discovered as it runs, so a per-guild subscription would have to be managed
   * alongside it and would miss any guild onboarded after boot.
   */
  async subscribe(onChange: (guildId: string) => void): Promise<() => Promise<void>> {
    const sub = this.ctx.client.duplicate();
    sub.on("error", () => {
      // node-redis reconnects on its own; an unhandled 'error' would take the
      // process down over a blip in a channel that only carries cache hints.
    });
    await sub.connect();

    const pattern = this.ctx.keys.chanConfig("*");
    await sub.pSubscribe(pattern, (message: string) => {
      try {
        const parsed = JSON.parse(message) as { guildId?: unknown };
        if (typeof parsed.guildId === "string") onChange(parsed.guildId);
      } catch {
        // A malformed message is not worth crashing a listener over.
      }
    });

    return async () => {
      await sub.pUnsubscribe(pattern).catch(() => undefined);
      await sub.quit().catch(() => undefined);
    };
  }
}

/** One instruction on the moderation bus. */
export interface ModBusMessage {
  readonly guildId: string;
  readonly kind: "GAME_COMMAND";
  /** The literal line to type in game, e.g. `/g mute Notch 1h`. */
  readonly command: string;
  /** Ties the publish, the drain and the audit row together in the logs. */
  readonly correlationId: string;
}

/**
 * The moderation bus: how a decision made in one process reaches the process
 * that can act on it.
 *
 * Only `apps/bridge-bot` holds the Minecraft socket, so a `/warn` issued from
 * the panel or the admin bot has no way to reach guild chat directly. This is
 * that way. It mirrors `RedisConfigBus` exactly — publish on the shared client,
 * pattern-subscribe on a duplicate — because the two have identical delivery
 * needs and a second, subtly different implementation of the same thing is how
 * one of them ends up with a bug the other does not.
 *
 * Delivery is fire-and-forget. Redis pub/sub drops messages published while no
 * subscriber is connected, which is the right trade here: a guild command that
 * arrives an hour late, after the mute has expired, is worse than one that never
 * arrives. The Discord side of the punishment is already durable in Postgres.
 */
export class RedisModBus {
  constructor(private readonly ctx: RedisContext) {}

  async publish(message: ModBusMessage): Promise<void> {
    await this.ctx.client.publish(this.ctx.keys.chanMod(message.guildId), JSON.stringify(message));
  }

  /** Pattern-subscribed for the same reason the config bus is: guilds are discovered as the process runs. */
  async subscribe(onMessage: (message: ModBusMessage) => void): Promise<() => Promise<void>> {
    const sub = this.ctx.client.duplicate();
    sub.on("error", () => {
      // node-redis reconnects on its own; an unhandled 'error' would take the
      // bridge down over a blip on a channel it only listens to.
    });
    await sub.connect();

    const pattern = this.ctx.keys.chanMod("*");
    await sub.pSubscribe(pattern, (raw: string) => {
      const parsed = parseModBusMessage(raw);
      if (parsed !== null) onMessage(parsed);
    });

    return async () => {
      await sub.pUnsubscribe(pattern).catch(() => undefined);
      await sub.quit().catch(() => undefined);
    };
  }
}

/**
 * Validated rather than cast. This payload becomes a command typed by an account
 * with guild-officer permissions, so "it parsed as JSON" is not a good enough
 * reason to run it — every field is checked, and anything else is dropped.
 */
export function parseModBusMessage(raw: string): ModBusMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const { guildId, kind, command, correlationId } = record;
    if (kind !== "GAME_COMMAND") return null;
    if (typeof guildId !== "string" || guildId.length === 0) return null;
    if (typeof command !== "string" || command.length === 0) return null;
    return {
      guildId,
      kind,
      command,
      correlationId: typeof correlationId === "string" ? correlationId : "",
    };
  } catch {
    return null;
  }
}

/**
 * The jobs an operator may start by hand from the panel's Health page.
 *
 * An allow-list rather than "any name that has a definition", because the name
 * arrives from a browser: an open-ended trigger would let an admin queue a job
 * that only exists in a future deploy, or spell one wrong and get silence.
 *
 * It lives beside the bus rather than beside the job definitions because it *is*
 * the bus's vocabulary — the one thing both ends must agree on — and because
 * `@sbr/jobs` is a dependency the panel process has no other reason to carry.
 * `apps/workers`' schedule test asserts every name here is really scheduled, so
 * the list cannot drift away from the jobs it claims to name.
 *
 * Two families are deliberately absent. `heartbeat` and `analytics-ingest` are
 * continuous plumbing on a seconds-long cadence — running one by hand does
 * nothing an operator could observe. The rest are here because there is a real
 * reason to want one *now*: a roster that is wrong, prices that went stale
 * during an outage, a milestone somebody is waiting on.
 */
export const RUNNABLE_JOBS: readonly string[] = [
  "guild-scan",
  "guild-roster-sync",
  "discord-member-sync",
  "profile-snapshot",
  "milestone-detect",
  "xp-aggregate",
  "analytics-rollup",
  "bazaar-refresh",
  "ah-sweep",
  "ah-ended-ingest",
  "resources-refresh",
  "inactivity-scan",
  "event-transition",
  "reminder-dispatch",
  "punishment-expiry",
  "ticket-sweep",
  "config-cache-invalidation",
];

export function isRunnableJob(name: string): boolean {
  return RUNNABLE_JOBS.includes(name);
}

/** One manual run request, panel → workers. */
export interface JobTriggerMessage {
  /** A member of `RUNNABLE_JOBS`; checked again on the receiving end. */
  readonly jobName: string;
  /** Which guild the operator was looking at. Context for the log, not a filter. */
  readonly guildId: string;
  /** Who asked, so an unexpected run has a name attached to it. */
  readonly actorDiscordId: string;
  readonly at: string;
}

/**
 * The job-trigger bus: how "run it now" reaches the process holding the queue.
 *
 * BullMQ's `Queue` opens its own Redis connections and owns the queue's keys, so
 * a panel that enqueued directly would be a second writer to a structure
 * `apps/workers` reconciles on every boot. Publishing a request instead keeps
 * exactly one process in charge of the queue, and keeps `bullmq` out of the
 * panel's dependency tree.
 *
 * Fire-and-forget, like the moderation bus: pub/sub drops a message published
 * while the workers are down, which is the honest outcome — the panel reports
 * that the run was requested, and the Health page's next-run column is what says
 * whether it happened. A queued-up backlog of "run now" from an outage is not
 * something anybody asked for.
 */
export class RedisJobTriggerBus {
  constructor(private readonly ctx: RedisContext) {}

  async publish(message: JobTriggerMessage): Promise<void> {
    await this.ctx.client.publish(this.ctx.keys.chanJobs(), JSON.stringify(message));
  }

  /** Plain subscribe, not a pattern: there is one channel, and it is not per guild. */
  async subscribe(onMessage: (message: JobTriggerMessage) => void): Promise<() => Promise<void>> {
    const sub = this.ctx.client.duplicate();
    sub.on("error", () => {
      // node-redis reconnects on its own; an unhandled 'error' would take the
      // worker fleet down over a blip on a convenience channel.
    });
    await sub.connect();

    const channel = this.ctx.keys.chanJobs();
    await sub.subscribe(channel, (raw: string) => {
      const parsed = parseJobTriggerMessage(raw);
      if (parsed !== null) onMessage(parsed);
    });

    return async () => {
      await sub.unsubscribe(channel).catch(() => undefined);
      await sub.quit().catch(() => undefined);
    };
  }
}

/**
 * Validated, and the job name checked against the allow-list a second time.
 *
 * The panel checks before publishing; this checks before queueing. Both, because
 * anything that can reach Redis can publish here, and the receiving end is the
 * one holding the queue — a name it accepted on trust would be work the fleet
 * runs because a message said so.
 */
export function parseJobTriggerMessage(raw: string): JobTriggerMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const { jobName, guildId, actorDiscordId, at } = record;
    if (typeof jobName !== "string" || !isRunnableJob(jobName)) return null;
    if (typeof guildId !== "string" || guildId.length === 0) return null;
    return {
      jobName,
      guildId,
      actorDiscordId: typeof actorDiscordId === "string" ? actorDiscordId : "",
      at: typeof at === "string" ? at : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** What one process last reported about itself. */
export interface HeartbeatRecord {
  readonly service: string;
  readonly instance: string;
  readonly at: string;
  readonly pid: number;
  /** Service-specific liveness detail — gateway latency, session state, etc. */
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Heartbeat — liveness by presence.
 *
 * Each process writes its own key on a timer with a TTL of several beats, so a
 * process that dies stops appearing without anything having to detect the death
 * and mark it down. That makes the absent case the reliable one, which is the
 * opposite of a status flag someone has to remember to clear.
 */
export class RedisHeartbeat {
  constructor(private readonly ctx: RedisContext) {}

  async beat(record: Omit<HeartbeatRecord, "at" | "pid">, ttlSeconds: number): Promise<void> {
    const value: HeartbeatRecord = { ...record, at: new Date().toISOString(), pid: process.pid };
    await this.ctx.client.set(
      this.ctx.keys.heartbeat(record.service, record.instance),
      JSON.stringify(value),
      { EX: Math.max(1, Math.ceil(ttlSeconds)) },
    );
  }

  async list(): Promise<readonly HeartbeatRecord[]> {
    const out: HeartbeatRecord[] = [];
    for await (const key of this.ctx.client.scanIterator({ MATCH: this.ctx.keys.heartbeatScan(), COUNT: 100 })) {
      const raw = await this.ctx.client.get(String(key));
      if (!raw) continue; // expired between the scan and the read — simply gone
      try {
        out.push(JSON.parse(raw) as HeartbeatRecord);
      } catch {
        // Unreadable liveness is the same as none: leave the service absent.
      }
    }
    return out;
  }
}

/**
 * Beat now, then on a timer, until the returned stop function is called.
 *
 * `unref` so a heartbeat never becomes the reason a process refuses to exit —
 * liveness reporting should not keep a shutting-down service alive.
 */
export function startHeartbeat(
  heartbeat: RedisHeartbeat,
  record: () => Omit<HeartbeatRecord, "at" | "pid">,
  intervalMs = 15_000,
): () => void {
  const ttlSeconds = Math.ceil((intervalMs * 3) / 1000);
  const send = (): void => {
    void heartbeat.beat(record(), ttlSeconds).catch(() => undefined);
  };
  send();
  const timer = setInterval(send, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
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

/** What the pricing jobs write to `cache:pricing:item:<id>`. */
export interface CachedItemPrice {
  readonly bazaarInstantSell: number | null;
  readonly bazaarInstantBuy: number | null;
  readonly lowestBin: number | null;
  readonly estimatedValue: number | null;
  /** Epoch ms; anything older than the job's cadence is served as stale. */
  readonly fetchedAt: number;
}

/**
 * PriceSource — read-only view of the worker-populated market cache.
 *
 * Commands never call Hypixel for prices: a bazaar sweep is far too expensive
 * to run per invocation, so the jobs own refreshing and commands only read. An
 * absent item yields null (the service turns that into "unknown", never zero).
 */
export class RedisPriceSource {
  /** Older than this and the reading is reported as stale rather than current. */
  private static readonly STALE_AFTER_MS = 5 * 60_000;

  constructor(private readonly ctx: RedisContext) {}

  async getItem(itemId: string): Promise<{ price: PriceDTO; stale: boolean } | null> {
    const raw = await this.ctx.client.get(this.ctx.keys.cachePriceItem(itemId));
    if (!raw) return null;

    let cached: CachedItemPrice;
    try {
      cached = JSON.parse(raw) as CachedItemPrice;
    } catch {
      // A corrupt entry is indistinguishable from no data as far as the caller
      // is concerned, and pretending otherwise would surface a parse error to a
      // user asking for an item price.
      return null;
    }

    return {
      price: {
        itemId,
        bazaarInstantSell: cached.bazaarInstantSell,
        bazaarInstantBuy: cached.bazaarInstantBuy,
        lowestBin: cached.lowestBin,
        estimatedValue: cached.estimatedValue,
      },
      stale: Date.now() - cached.fetchedAt > RedisPriceSource.STALE_AFTER_MS,
    };
  }
}

/** One item's lowest-BIN reading, as the auction sweep job writes it. */
export interface CachedBinEntry {
  readonly price: number | null;
  readonly listings: number;
  readonly cheapest: readonly {
    readonly auctionId: string;
    readonly itemName: string | null;
    readonly price: number | null;
    readonly bin: boolean;
    readonly endsAt: number | null;
  }[];
  readonly fetchedAt: number;
}

/**
 * BinSource — read side of the auction-house sweep cache.
 *
 * Commands may not paginate the AH themselves, so everything here comes from
 * whatever the sweep job last wrote. A missing key means "not swept yet", which
 * the market service reports as unknown rather than as a price of zero.
 */
export class RedisBinSource {
  constructor(private readonly ctx: RedisContext) {}

  async get(itemId: string): Promise<CachedBinEntry | null> {
    const raw = await this.ctx.client.get(this.ctx.keys.cacheLowestBin(itemId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CachedBinEntry;
    } catch {
      // A corrupt entry is indistinguishable from no data to the caller.
      return null;
    }
  }

  /** Write side, used only by the sweep job. */
  async put(itemId: string, entry: CachedBinEntry, ttlMs: number): Promise<void> {
    await this.ctx.client.set(this.ctx.keys.cacheLowestBin(itemId), JSON.stringify(entry), {
      PX: ttlMs,
    });
  }
}

/**
 * SafetyStateStore — the live record of `/lockdown` and `/antiraid-on`.
 *
 * Reads tolerate a corrupt or hand-edited value by treating it as absent: a
 * posture nobody can parse is one nobody can lift either, and reporting "no
 * lockdown" at least lets an officer set a fresh one.
 */
export class RedisSafetyStore {
  constructor(private readonly ctx: RedisContext) {}

  private async read<T>(key: string): Promise<T | null> {
    const raw = await this.ctx.client.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async scan<T>(pattern: string): Promise<readonly T[]> {
    const out: T[] = [];
    for await (const key of this.ctx.client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      const value = await this.read<T>(String(key));
      if (value) out.push(value);
    }
    return out;
  }

  async getLockdown(guildId: string): Promise<LockdownStateDTO | null> {
    return this.read<LockdownStateDTO>(this.ctx.keys.lockdown(guildId));
  }

  async putLockdown(state: LockdownStateDTO, ttlSeconds: number): Promise<void> {
    await this.ctx.client.set(this.ctx.keys.lockdown(state.guildId), JSON.stringify(state), {
      EX: ttlSeconds,
    });
  }

  async clearLockdown(guildId: string): Promise<void> {
    await this.ctx.client.del(this.ctx.keys.lockdown(guildId));
  }

  async listLockdowns(): Promise<readonly LockdownStateDTO[]> {
    return this.scan<LockdownStateDTO>(this.ctx.keys.lockdownScan());
  }

  async getAntiRaid(guildId: string): Promise<AntiRaidStateDTO | null> {
    return this.read<AntiRaidStateDTO>(this.ctx.keys.antiRaid(guildId));
  }

  async putAntiRaid(state: AntiRaidStateDTO, ttlSeconds: number): Promise<void> {
    await this.ctx.client.set(this.ctx.keys.antiRaid(state.guildId), JSON.stringify(state), {
      EX: ttlSeconds,
    });
  }

  async clearAntiRaid(guildId: string): Promise<void> {
    await this.ctx.client.del(this.ctx.keys.antiRaid(guildId));
  }

  async listAntiRaid(): Promise<readonly AntiRaidStateDTO[]> {
    return this.scan<AntiRaidStateDTO>(this.ctx.keys.antiRaidScan());
  }
}

export function createRedisAdapters(ctx: RedisContext) {
  return {
    bins: new RedisBinSource(ctx),
    safety: new RedisSafetyStore(ctx),
    lock: new RedisLock(ctx),
    cooldowns: new RedisCooldownGate(ctx),
    hypixelCache: new RedisHypixelCache(ctx),
    rateGate: new RedisRateGate(ctx),
    analyticsBuffer: new RedisAnalyticsBuffer(ctx),
    analyticsDrain: new RedisAnalyticsDrain(ctx),
    enforcement: new RedisEnforcementMirror(ctx),
    priceSource: new RedisPriceSource(ctx),
    configBus: new RedisConfigBus(ctx),
    modBus: new RedisModBus(ctx),
    jobTriggers: new RedisJobTriggerBus(ctx),
    heartbeat: new RedisHeartbeat(ctx),
    tallies: new RedisTallyStore(ctx, FUN_TALLY_TTL_SECONDS),
    automodCounters: new RedisAutomodCounters(ctx),
  };
}

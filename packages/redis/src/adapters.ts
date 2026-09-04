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

/**
 * How long a role refusal stays on the Health card.
 *
 * A week: long enough that a refusal from a weekend sync is still there on
 * Monday, short enough that a role somebody deleted months ago is not still
 * being complained about.
 */
const ROLE_REFUSAL_TTL_SECONDS = 7 * 24 * 3600;

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

/**
 * FiringLedger — one SET NX, which is the whole point.
 *
 * A trigger asks this before it acts, and the answer is authoritative for every
 * bot process at once. Doing the same job with a read followed by a write would
 * be correct on one shard and wrong the moment two reactions land together,
 * which is exactly the traffic a popular starboard message generates.
 *
 * A Redis failure surfaces to the caller rather than being swallowed here: the
 * runner decides whether an unknown answer means "post anyway" or "skip", and
 * that is a policy decision, not a storage one.
 */
export class RedisFiringLedger {
  constructor(private readonly ctx: RedisContext) {}
  async claim(guildId: string, key: string, ttlSeconds: number): Promise<boolean> {
    const ok = await this.ctx.client.set(this.ctx.keys.dedupTrigger(guildId, key), "1", {
      NX: true,
      EX: ttlSeconds,
    });
    return ok !== null;
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
 * itself to be the fifth.
 *
 * The expiry is set only when the counter is created, which makes each window a
 * tumbling one. Refreshing it on every bump instead would mean the key only
 * expires once the author *stops* talking, so somebody chatting steadily just
 * under the rate — one line every nine seconds against a ten-second window —
 * accumulates towards the threshold forever and is eventually muted for not
 * flooding. A tumbling window is cheaper than a sorted set of timestamps per
 * author per rule, and wrong only at the seam, where the worst case is a burst
 * split across two windows going unpunished.
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
          // Only the bump that created the key sets the window. A key that
          // somehow survived without one (a crash between the two calls) is
          // given a TTL too, so nothing here can leak forever.
          if (total === 1) {
            await this.ctx.client.expire(key, Math.max(1, Math.ceil(request.windowSeconds)));
          } else if ((await this.ctx.client.ttl(key)) < 0) {
            await this.ctx.client.expire(key, Math.max(1, Math.ceil(request.windowSeconds)));
          }
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
    let e: { data: T; fetchedAt: string; softExpiresAt: number };
    try {
      e = JSON.parse(raw) as { data: T; fetchedAt: string; softExpiresAt: number };
    } catch {
      // A corrupt envelope is a cache miss, not an error: the caller's fallback
      // is to fetch, which is exactly what it should do. Throwing here would
      // turn a bad byte in Redis into a failed player lookup.
      return null;
    }
    return { data: e.data, fetchedAt: e.fetchedAt, expired: Date.now() > e.softExpiresAt };
  }
  async set<T>(key: string, data: T, ttlMs: number): Promise<void> {
    const payload = JSON.stringify({ data, fetchedAt: new Date().toISOString(), softExpiresAt: Date.now() + ttlMs });
    const hardSeconds = Math.max(60, Math.ceil((ttlMs * 6) / 1000));
    await this.ctx.client.set(key, payload, { EX: hardSeconds });
  }
}

/**
 * How long an observed Hypixel budget stays interesting.
 *
 * Hypixel's window is a minute; an hour is comfortably longer than any window
 * whose `remaining` could still mean something, and short enough that a key
 * nobody has written since a deploy simply goes away.
 */
const RATE_GATE_TTL_SECONDS = 3600;

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
      // Fire-and-forget: observe() is sync in the port. The TTL is here because
      // this is a window, not a fact: a `remaining` from a budget that lapsed
      // hours ago describes nothing, and without an expiry it would be the one
      // key in this file that outlives every process that wrote it.
      void this.ctx.client
        .hSet(key, upd)
        .then(() => this.ctx.client.expire(key, RATE_GATE_TTL_SECONDS))
        .catch(() => {});
    }
  }
}

/**
 * PlayerRateLimiter — the self-imposed floor of one upstream read per player per
 * window (docs/HYPIXEL_COMPLIANCE.md).
 *
 * `SET NX EX` is the whole mechanism: the key's existence is the claim, so there
 * is no read-then-write race of the kind `RedisRateGate.acquire` tolerates. Two
 * processes racing the same subject produce exactly one winner, which matters
 * here in a way it does not for the soft shared budget — this cap is a promise
 * made to Hypixel, not an optimisation.
 *
 * The claim is spent on the *attempt*. Nothing releases it if the request then
 * fails, and that is deliberate: releasing on failure would let a flapping
 * endpoint be retried without limit, which is the pattern the cap exists to
 * prevent.
 */
export class RedisPlayerRateLimiter {
  private readonly windowSeconds: number;

  constructor(
    private readonly ctx: RedisContext,
    windowMs: number,
  ) {
    // A sub-second window is not a window; it is the caller asking for no cap,
    // and `createRedisAdapters` already expresses that by not constructing one.
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
 * How one guild command ended.
 *
 * Two layers, because they fail differently and staff need to tell them apart.
 * The first four are the bridge answering for itself - did it type the line.
 * The last two are Hypixel answering - did it accept the line that was typed.
 * `TYPED` is therefore not success; it is the absence of an answer yet.
 */
export type ModAckOutcome =
  /** Handed to Minecraft. Whether the server liked it is not known yet. */
  | "TYPED"
  /** The bridge is up but not this guild's bridge. */
  | "WRONG_GUILD"
  /** The outbound queue is full; the command was refused, not delayed. */
  | "REFUSED_BACKLOG"
  /** Sat in the queue past its useful life and was discarded untyped. */
  | "EXPIRED"
  /** Hypixel printed the notice this command was supposed to produce. */
  | "CONFIRMED_INGAME"
  /** Hypixel printed a refusal instead. */
  | "REFUSED_INGAME";

/** What became of one instruction from the moderation bus. */
export interface ModAckMessage {
  readonly guildId: string;
  readonly kind: "GAME_COMMAND_ACK";
  /** The `correlationId` of the `ModBusMessage` this answers. */
  readonly correlationId: string;
  readonly outcome: ModAckOutcome;
  /** The guild-chat line that settled it, or why it could not be typed. */
  readonly detail: string;
}

const ACK_OUTCOMES: readonly ModAckOutcome[] = [
  "TYPED",
  "WRONG_GUILD",
  "REFUSED_BACKLOG",
  "EXPIRED",
  "CONFIRMED_INGAME",
  "REFUSED_INGAME",
];

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
/** One settled guild command, as the panel's relay strip shows it. */
export interface RelayLogEntry {
  readonly at: string;
  readonly command: string;
  readonly correlationId: string;
  readonly outcome: ModAckOutcome;
  readonly detail: string;
}

/** How many commands the strip remembers. */
const RELAY_LOG_LENGTH = 50;
/** A week. Long enough to answer "what happened on Saturday", short enough to forget. */
const RELAY_LOG_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * The last few guild commands and what became of them.
 *
 * The answer to "did that /g kick work" existed only as a log line in whichever
 * process happened to publish it, which is to say nowhere anyone could look.
 * This is the same information, written where the panel can read it.
 *
 * Capped and expiring: it is a monitor, not an audit trail. The audit trail is
 * the moderation table, which holds every one of these as an `enforcement`
 * verdict on a real case.
 */
export class RedisRelayLog {
  constructor(private readonly ctx: RedisContext) {}

  /**
   * One row per command, updated in place as its answer arrives.
   *
   * A command is acked twice — `TYPED` when the bridge types it, then the
   * guild's own verdict — and appending both would show every kick twice while
   * halving what the strip can remember. Rewriting the row instead means a
   * command that was typed and never answered *stays* on the strip reading
   * "typed", which is the state an operator most needs to be able to see.
   *
   * Best-effort throughout. A relay log that failed to write is a strip missing
   * a row; one that threw would be a punishment failing over its own receipt.
   */
  async record(guildId: string, entry: RelayLogEntry): Promise<void> {
    const key = this.ctx.keys.relayLog(guildId);
    try {
      const existing = await this.ctx.client.lRange(key, 0, RELAY_LOG_LENGTH - 1);
      const at = existing.findIndex((line) => parseRelayLogEntry(line)?.correlationId === entry.correlationId);
      if (at === -1) {
        await this.ctx.client.lPush(key, JSON.stringify(entry));
        await this.ctx.client.lTrim(key, 0, RELAY_LOG_LENGTH - 1);
      } else {
        await this.ctx.client.lSet(key, at, JSON.stringify(entry));
      }
      await this.ctx.client.expire(key, RELAY_LOG_TTL_SECONDS);
    } catch {
      // Swallowed deliberately — see above.
    }
  }

  /** Newest first. Unreadable or malformed rows are skipped, never thrown over. */
  async list(guildId: string, limit = RELAY_LOG_LENGTH): Promise<readonly RelayLogEntry[]> {
    const capped = Math.min(Math.max(limit, 1), RELAY_LOG_LENGTH);
    let raw: string[];
    try {
      raw = await this.ctx.client.lRange(this.ctx.keys.relayLog(guildId), 0, capped - 1);
    } catch {
      return [];
    }
    const out: RelayLogEntry[] = [];
    for (const line of raw) {
      const entry = parseRelayLogEntry(line);
      if (entry !== null) out.push(entry);
    }
    return out;
  }
}

/**
 * Validated rather than trusted, like every other thing read back off Redis
 * here: a row written by an older build with a different shape must render as
 * one missing row, not as an exception on the moderation page.
 */
export function parseRelayLogEntry(raw: string): RelayLogEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const { at, command, correlationId, outcome, detail } = v;
  if (typeof at !== "string" || at === "") return null;
  if (typeof command !== "string" || command === "") return null;
  if (typeof correlationId !== "string" || correlationId === "") return null;
  if (typeof outcome !== "string" || !ACK_OUTCOMES.includes(outcome as ModAckOutcome)) return null;
  if (typeof detail !== "string") return null;
  return { at, command, correlationId, outcome: outcome as ModAckOutcome, detail };
}

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

  /** Answer one instruction. Published by the bridge, read by whoever issued it. */
  async publishAck(message: ModAckMessage): Promise<void> {
    await this.ctx.client.publish(this.ctx.keys.chanModAck(message.guildId), JSON.stringify(message));
  }

  /**
   * Listen for answers.
   *
   * Also pattern-subscribed, and for a reason worth stating: the admin bot and
   * the panel both publish commands for guilds they learn about at runtime, so
   * a subscription per guild would have to be opened at the moment the first
   * punishment is issued — which is exactly too late to hear its answer.
   */
  async subscribeAcks(onAck: (ack: ModAckMessage) => void): Promise<() => Promise<void>> {
    const sub = this.ctx.client.duplicate();
    sub.on("error", () => {
      // Same reasoning as `subscribe`: a blip on a channel this process only
      // listens to must not take the process down.
    });
    await sub.connect();

    const pattern = this.ctx.keys.chanModAck("*");
    await sub.pSubscribe(pattern, (raw: string) => {
      const parsed = parseModAckMessage(raw);
      if (parsed !== null) onAck(parsed);
    });

    return async () => {
      await sub.pUnsubscribe(pattern).catch(() => undefined);
      await sub.quit().catch(() => undefined);
    };
  }
}

/**
 * Validated like the instruction it answers.
 *
 * Less dangerous than a command — nothing here gets typed anywhere — but an
 * unchecked `outcome` would let a malformed payload mark a punishment confirmed
 * that never landed, which is the state this whole channel exists to prevent.
 */
export function parseModAckMessage(raw: string): ModAckMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const { guildId, kind, correlationId, outcome, detail } = record;
    if (kind !== "GAME_COMMAND_ACK") return null;
    if (typeof guildId !== "string" || guildId.length === 0) return null;
    if (typeof correlationId !== "string" || correlationId.length === 0) return null;
    if (typeof outcome !== "string" || !ACK_OUTCOMES.includes(outcome as ModAckOutcome)) return null;
    return {
      guildId,
      kind,
      correlationId,
      outcome: outcome as ModAckOutcome,
      detail: typeof detail === "string" ? detail : "",
    };
  } catch {
    return null;
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
 * One message on the bridge inbox: a reminder that an event is about to start.
 *
 * `guildId` is on the payload rather than read back out of the channel name.
 * The channel is pattern-subscribed, so the subscriber *could* parse the guild
 * out of `chan:bridge:<id>` — but that makes the routing depend on a key format
 * instead of on the message, and a key format is exactly the sort of thing that
 * gets a prefix added to it one day.
 */
export interface EventReminderMessage {
  readonly kind: "event-reminder";
  readonly guildId: string;
  readonly eventId: string;
  readonly title: string;
  /** ISO timestamp. Rendered as a Discord timestamp tag, so the clock is the reader's. */
  readonly startsAt: string;
  /** How far ahead of `startsAt` this reminder is — 60, 15, 5. */
  readonly offsetMinutes: number;
  /** The members who said they were coming. Only these are pingable. */
  readonly discordIds: readonly string[];
}

/** Everything that travels to the bridge bot on `chan:bridge:*`. */
export type BridgeBusMessage = EventReminderMessage;

/**
 * The bridge inbox: how a process with no gateway asks the one that has one to
 * say something in a guild.
 *
 * Third bus with this shape, after `RedisConfigBus` and `RedisModBus`, and
 * deliberately identical to them — publish on the shared client,
 * pattern-subscribe on a duplicate, validate rather than cast.
 *
 * Fire-and-forget, and for reminders that is the correct trade rather than a
 * concession: a "starts in 15 minutes" notice delivered after the event has
 * begun is worse than one that never arrives. The workers only mark the offset
 * sent once the publish resolves, so a bot that is down loses the ping and not
 * the event.
 */
export class RedisBridgeBus {
  constructor(private readonly ctx: RedisContext) {}

  async publish(message: BridgeBusMessage): Promise<void> {
    await this.ctx.client.publish(this.ctx.keys.chanBridge(message.guildId), JSON.stringify(message));
  }

  async subscribe(onMessage: (message: BridgeBusMessage) => void): Promise<() => Promise<void>> {
    const sub = this.ctx.client.duplicate();
    sub.on("error", () => {
      // As on the other two buses: node-redis reconnects on its own, and an
      // unhandled 'error' would take the bridge down over a blip.
    });
    await sub.connect();

    const pattern = this.ctx.keys.chanBridge("*");
    await sub.pSubscribe(pattern, (raw: string) => {
      const parsed = parseBridgeBusMessage(raw);
      if (parsed !== null) onMessage(parsed);
    });

    return async () => {
      await sub.pUnsubscribe(pattern).catch(() => undefined);
      await sub.quit().catch(() => undefined);
    };
  }
}

/**
 * Validated rather than cast. This payload decides who gets pinged, so a
 * malformed `discordIds` is not something to pass through and hope the
 * allow-mentions list catches: entries that are not snowflake-shaped strings are
 * dropped, and a message with nothing left to ping is still delivered — the
 * event notice is useful without the mentions.
 */
export function parseBridgeBusMessage(raw: string): BridgeBusMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record["kind"] !== "event-reminder") return null;

    const { guildId, eventId, title, startsAt, offsetMinutes } = record;
    if (typeof guildId !== "string" || guildId.length === 0) return null;
    if (typeof eventId !== "string" || eventId.length === 0) return null;
    if (typeof title !== "string" || title.length === 0) return null;
    if (typeof startsAt !== "string" || Number.isNaN(Date.parse(startsAt))) return null;
    if (typeof offsetMinutes !== "number" || !Number.isFinite(offsetMinutes)) return null;

    const ids = record["discordIds"];
    const discordIds = Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === "string" && /^\d{5,25}$/.test(id))
      : [];

    return { kind: "event-reminder", guildId, eventId, title, startsAt, offsetMinutes, discordIds };
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
  "profile-refresh",
  "milestone-detect",
  "milestone-backfill",
  "xp-aggregate",
  "analytics-rollup",
  "bazaar-refresh",
  "ah-sweep",
  "ah-ended-ingest",
  "resources-refresh",
  "inactivity-scan",
  "event-transition",
  "reminder-dispatch",
  // `punishment-expiry` is deliberately absent: it moved to the admin bot, so a
  // manual-run request routed to workers would be accepted and then do nothing.
  "ticket-sweep",
  "event-tracking",
  "event-board",
  "leaderboard-post",
  "role-sync",
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
 * One member arriving at, or leaving, a Discord server.
 *
 * Published by the admin bot, which already holds `GuildMembers` — observing is
 * automated work, and adding a privileged intent to the shared member-facing
 * application to watch for joins would be paying a permission for a message.
 * The member-facing bot subscribes and does the talking, because a welcome from
 * a staff bot most members cannot see is the platform speaking out of the wrong
 * mouth.
 *
 * Everything the greeter needs to render is on the payload. The subscriber
 * cannot fetch a member who has just left, and half a farewell is worse than
 * none.
 */
export interface MemberBusMessage {
  readonly kind: "member-join" | "member-leave";
  readonly guildId: string;
  readonly discordId: string;
  /** Display name at the moment of the event, already stripped of mentions. */
  readonly username: string;
  readonly serverName: string;
  /** Server member count after the event, or null when Discord did not say. */
  readonly memberCount: number | null;
}

/**
 * Validated, not cast: this payload decides who gets pinged in a public channel.
 */
export function parseMemberBusMessage(raw: string): MemberBusMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const r = parsed as Record<string, unknown>;
    const { kind, guildId, discordId, username, serverName, memberCount } = r;
    if (kind !== "member-join" && kind !== "member-leave") return null;
    if (typeof guildId !== "string" || guildId.length === 0) return null;
    if (typeof discordId !== "string" || discordId.length === 0) return null;
    return {
      kind,
      guildId,
      discordId,
      username: typeof username === "string" ? username : "",
      serverName: typeof serverName === "string" ? serverName : "",
      memberCount: typeof memberCount === "number" && Number.isFinite(memberCount) ? memberCount : null,
    };
  } catch {
    return null;
  }
}

/** Pattern-subscribed, like the other buses: guilds appear as the process runs. */
export class RedisMemberBus {
  constructor(private readonly ctx: RedisContext) {}

  async publish(message: MemberBusMessage): Promise<void> {
    await this.ctx.client.publish(this.ctx.keys.chanMember(message.guildId), JSON.stringify(message));
  }

  async subscribe(onMessage: (message: MemberBusMessage) => void): Promise<() => Promise<void>> {
    const sub = this.ctx.client.duplicate();
    sub.on("error", () => {
      // node-redis reconnects on its own; an unhandled 'error' here would take
      // the whole bot down over a blip on a channel it only listens to.
    });
    await sub.connect();

    const pattern = this.ctx.keys.chanMember("*");
    await sub.pSubscribe(pattern, (raw: string) => {
      const parsed = parseMemberBusMessage(raw);
      if (parsed !== null) onMessage(parsed);
    });

    return async () => {
      await sub.pUnsubscribe(pattern).catch(() => undefined);
      await sub.quit().catch(() => undefined);
    };
  }
}

/** One member worth reconciling now, rather than at the next sweep. */
export interface RoleNudgeMessage {
  readonly guildId: string;
  readonly discordId: string;
  readonly at: string;
}

/**
 * How many members one `mark` will nudge individually.
 *
 * Above this the mark is a bulk one and the sweep owns it. Sized so that the
 * everyday causes — somebody linked, somebody's rank changed, somebody was
 * banned, a small event completed — are all under it, and a roster-wide rescan
 * is comfortably over.
 */
export const MAX_NUDGED_PER_MARK = 25;

/**
 * Validated rather than cast, like every other bus in this file: anything that
 * can reach Redis can publish here, and the receiving end is the one that will
 * spend a Discord role call because a message said to.
 */
export function parseRoleNudgeMessage(raw: string): RoleNudgeMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const { guildId, discordId, at } = record;
    if (typeof guildId !== "string" || guildId.length === 0) return null;
    if (typeof discordId !== "string" || discordId.length === 0) return null;
    return { guildId, discordId, at: typeof at === "string" ? at : new Date().toISOString() };
  } catch {
    return null;
  }
}

/**
 * The listening half of the nudge channel, for the worker fleet.
 *
 * Publishing lives on `RedisRoleDirtySet` because marking and nudging are one
 * act and splitting them across two adapters would let a caller do half of it.
 * Subscribing is separate because exactly one process does it, and it needs a
 * connection of its own — a node-redis client in subscriber mode will not serve
 * ordinary commands.
 */
export class RedisRoleNudgeBus {
  constructor(private readonly ctx: RedisContext) {}

  async subscribe(onNudge: (message: RoleNudgeMessage) => void): Promise<() => Promise<void>> {
    const sub = this.ctx.client.duplicate();
    sub.on("error", () => {
      // node-redis reconnects on its own, and this channel is an optimisation.
      // Taking the worker fleet down over a blip on it would cost far more than
      // the fifteen-minute fallback it briefly falls back to.
    });
    await sub.connect();

    const channel = this.ctx.keys.chanRoleNudge();
    await sub.subscribe(channel, (raw: string) => {
      const parsed = parseRoleNudgeMessage(raw);
      if (parsed !== null) onNudge(parsed);
    });

    return async () => {
      await sub.unsubscribe(channel).catch(() => undefined);
      await sub.quit().catch(() => undefined);
    };
  }
}

/**
 * Marks members whose auto-roles may have gone out of date.
 *
 * Everything that changes a fact a rule can read — a link, a rank, a level, an
 * achievement, an attendance — calls this, and `role-sync` drains the set. It is
 * a hint, not a queue: the daily full sweep reconciles everyone regardless, so
 * losing a mark to a Redis flush or a crash between the write and the mark costs
 * latency and never correctness. That is the whole reason it is allowed to be a
 * fire-and-forget set in Redis instead of an outbox table.
 *
 * Marking is therefore never worth failing a caller over. A guild scan that
 * cannot reach Redis has still done its real work.
 */
export class RedisRoleDirtySet {
  constructor(private readonly ctx: RedisContext) {}

  async mark(guildId: string, discordIds: readonly string[]): Promise<void> {
    const ids = [...new Set(discordIds)].filter((id) => id.length > 0);
    if (ids.length === 0) return;
    try {
      await this.ctx.client.sAdd(this.ctx.keys.rolesDirty(guildId), ids);
    } catch {
      // Swallowed deliberately: see the class comment. The sweep is the floor.
    }
    await this.nudge(guildId, ids);
  }

  /**
   * Ask the workers to look at these members now, having marked them.
   *
   * Ordered after the `sAdd` on purpose. The mark is what makes the reconcile
   * eventually happen; the nudge only makes it happen sooner. Publishing first
   * would open a window where a worker reconciles a member, finds nothing, and
   * *then* the fact that changed gets marked — which the sweep would fix, but
   * fifteen minutes later, which is the delay this whole path exists to remove.
   *
   * Only for small marks. A guild scan that touches two hundred members is a
   * bulk reconcile, and bulk reconciles are what the sweep is good at: nudging
   * each of them individually would flood a queue that would drop most of them
   * anyway, and would spend the guild's Discord role budget racing a pass that
   * is already scheduled to do the same work.
   */
  private async nudge(guildId: string, discordIds: readonly string[]): Promise<void> {
    if (discordIds.length > MAX_NUDGED_PER_MARK) return;
    for (const discordId of discordIds) {
      try {
        const message: RoleNudgeMessage = { guildId, discordId, at: new Date().toISOString() };
        await this.ctx.client.publish(this.ctx.keys.chanRoleNudge(), JSON.stringify(message));
      } catch {
        // Same reasoning as the mark above, and more so: this is the optimistic
        // half. A publish nobody heard costs the member a quarter of an hour.
      }
    }
  }

  /**
   * How many members are waiting on the next pass.
   *
   * The panel's "is this feature keeping up" number. Unreachable Redis reads as
   * zero rather than throwing: a Health card that cannot render is less use
   * than one missing a count.
   */
  async pending(guildId: string): Promise<number> {
    try {
      return await this.ctx.client.sCard(this.ctx.keys.rolesDirty(guildId));
    } catch {
      return 0;
    }
  }
}

/** One role the effector would not touch, with the reason staff need. */
export interface RoleRefusal {
  readonly roleId: string;
  readonly detail: string;
  readonly at: string;
}

/**
 * Refusals, kept just long enough to be read.
 *
 * A refusal is not an outage and not an audit record — it is "your rule names a
 * role I am not allowed to give out", which stops being true the moment somebody
 * drags the bot's role up the list. So it lives in a hash with a TTL, keyed by
 * role id so a rule refusing on every one of four hundred members is one entry
 * rather than four hundred, and the newest reason wins.
 */
export class RedisRoleRefusals {
  constructor(private readonly ctx: RedisContext, private readonly ttlSeconds: number) {}

  async record(guildId: string, roleId: string, detail: string): Promise<void> {
    try {
      const key = this.ctx.keys.rolesRefused(guildId);
      await this.ctx.client.hSet(key, roleId, JSON.stringify({ detail: detail.slice(0, 200), at: new Date().toISOString() }));
      // Refreshed on every write, so the window is "since the last refusal"
      // rather than "since the first one" — a rule still failing today should
      // not vanish from the card because it first failed a week ago.
      await this.ctx.client.expire(key, this.ttlSeconds);
    } catch {
      // A diagnostic that cannot be written is not worth failing a sync over.
    }
  }

  async list(guildId: string): Promise<readonly RoleRefusal[]> {
    let raw: Record<string, string>;
    try {
      raw = await this.ctx.client.hGetAll(this.ctx.keys.rolesRefused(guildId));
    } catch {
      return [];
    }
    const out: RoleRefusal[] = [];
    for (const [roleId, value] of Object.entries(raw)) {
      try {
        const parsed = JSON.parse(value) as { detail?: unknown; at?: unknown };
        out.push({
          roleId,
          detail: typeof parsed.detail === "string" ? parsed.detail : "Refused.",
          at: typeof parsed.at === "string" ? parsed.at : "",
        });
      } catch {
        // An unreadable entry is dropped rather than rendered as garbage.
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  /** Staff say "I fixed it"; the card empties without waiting out the TTL. */
  async clear(guildId: string): Promise<void> {
    try {
      await this.ctx.client.del(this.ctx.keys.rolesRefused(guildId));
    } catch {
      // Nothing to undo: the TTL removes it anyway.
    }
  }
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

/** Options that adapters cannot derive from the connection alone. */
export interface RedisAdapterOptions {
  /**
   * The per-player Hypixel window, from `config.hypixel.playerWindowMs`. Zero
   * (production mode) means no per-player cap, and the limiter is omitted
   * entirely rather than constructed with a window of nothing — the client's
   * `unlimitedPlayers` default is the clearer way to say "no cap".
   */
  readonly playerWindowMs?: number;
}

/**
 * The panel's read cache, versioned per guild.
 *
 * Every method swallows its own failures. A panel whose cache is unreachable
 * has to be a slow panel, never a broken one — these pages are how staff find
 * out what is wrong, so they are the last thing that may depend on Redis being
 * healthy.
 */
export class RedisPanelCache {
  constructor(private readonly ctx: RedisContext) {}

  /** The guild's current cache generation. Unreadable counts as generation 0. */
  private async version(guildId: string): Promise<number> {
    const raw = await this.ctx.client.get(this.ctx.keys.panelVersion(guildId)).catch(() => null);
    const value = Number(raw ?? 0);
    return Number.isFinite(value) ? value : 0;
  }

  async fetch<T>(guildId: string, key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const version = await this.version(guildId);
    const cacheKey = this.ctx.keys.panelCache(guildId, version, key);
    const hit = await this.ctx.client.get(cacheKey).catch(() => null);
    if (hit !== null) {
      try {
        return JSON.parse(hit) as T;
      } catch {
        // Something else wrote this key, or the shape changed across a deploy.
        // Falling through re-computes and overwrites it.
      }
    }
    const value = await load();
    await this.ctx.client
      .set(cacheKey, JSON.stringify(value), { EX: Math.max(1, Math.floor(ttlSeconds)) })
      .catch(() => undefined);
    return value;
  }

  /**
   * Retire everything cached for this guild.
   *
   * The counter itself is deliberately given no TTL. If it were to expire, the
   * generation would reset to zero and a page could start reading entries from
   * before the last several invalidations — a stale panel produced by a cleanup
   * mechanism, which is the one failure this design exists to rule out.
   */
  async invalidate(guildId: string): Promise<void> {
    await this.ctx.client.incr(this.ctx.keys.panelVersion(guildId)).catch(() => undefined);
  }
}

export function createRedisAdapters(ctx: RedisContext, opts: RedisAdapterOptions = {}) {
  const playerWindowMs = opts.playerWindowMs ?? 0;
  return {
    bins: new RedisBinSource(ctx),
    safety: new RedisSafetyStore(ctx),
    lock: new RedisLock(ctx),
    cooldowns: new RedisCooldownGate(ctx),
    hypixelCache: new RedisHypixelCache(ctx),
    rateGate: new RedisRateGate(ctx),
    playerLimiter: playerWindowMs > 0 ? new RedisPlayerRateLimiter(ctx, playerWindowMs) : undefined,
    analyticsBuffer: new RedisAnalyticsBuffer(ctx),
    analyticsDrain: new RedisAnalyticsDrain(ctx),
    enforcement: new RedisEnforcementMirror(ctx),
    priceSource: new RedisPriceSource(ctx),
    configBus: new RedisConfigBus(ctx),
    modBus: new RedisModBus(ctx),
    relayLog: new RedisRelayLog(ctx),
    bridgeBus: new RedisBridgeBus(ctx),
    jobTriggers: new RedisJobTriggerBus(ctx),
    memberBus: new RedisMemberBus(ctx),
    rolesDirty: new RedisRoleDirtySet(ctx),
    roleNudges: new RedisRoleNudgeBus(ctx),
    roleRefusals: new RedisRoleRefusals(ctx, ROLE_REFUSAL_TTL_SECONDS),
    heartbeat: new RedisHeartbeat(ctx),
    tallies: new RedisTallyStore(ctx, FUN_TALLY_TTL_SECONDS),
    automodCounters: new RedisAutomodCounters(ctx),
    firings: new RedisFiringLedger(ctx),
    panelCache: new RedisPanelCache(ctx),
  };
}

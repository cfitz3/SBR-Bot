# Redis Keyspace — SBR Guild Platform

The canonical Redis key layout for the platform. Redis is the shared coordination layer for cache, cooldowns, locks, sessions, queues, ephemeral enforcement, and event dispatch. Postgres remains the source of truth; **nothing here is authoritative** except transient/ephemeral state that has no durable home (sessions, cooldowns, live counters, queue internals).

**Global conventions**
- **Namespace prefix:** every key starts with an app-wide prefix `sbr:` (omitted in examples for brevity) so the instance can be shared safely and flushed by pattern.
- **Segment order:** `sbr:{category}:{scope}:{id}[:sub]` — category first, then scope (`guild`/`user`/`uuid`/global), enabling `SCAN`-by-category and clean invalidation.
- **Logical DB / prefix split:** cache, queues, and sessions are separated (by key prefix and, in prod, logical DBs / instances) so a cache flush never nukes queues or sessions.
- **Serialization:** small/atomic values are **raw scalars** (ints, ISO strings) for `INCR`/TTL efficiency; structured values are **JSON** (or MessagePack where size matters); BullMQ owns its own encoding.
- **Metadata on cached blobs:** cached JSON carries `{ data, fetchedAt, freshness, source }` so consumers can render "as of Xm ago" and detect `STALE` (see `HYPIXEL_DATA_LAYER.md`).
- **TTL discipline:** every ephemeral key has a TTL; only worker-managed indexes and queues are refreshed rather than expired. No unbounded keys.

---

## Category Overview

| Category | Prefix | Owner (writer) | Typical TTL | Format |
|----------|--------|----------------|-------------|--------|
| Command cooldowns | `cd:` | bots / panel | seconds–minutes | int / TTL-only |
| Session & OAuth state | `sess:` / `oauth:` | web-panel (`identity`) | hours / minutes | JSON |
| Event dispatch & queues | `bull:` / `chan:` / `buf:` | workers / all (pub) | queue-managed / n/a / trimmed | BullMQ / pub-sub / stream |
| Rate-limit buckets | `rl:` | hypixel client / workers | rolling window | hash / int |
| Bridge flood counters | `flood:` / `cd:relay:` | bridge-bot | seconds | int |
| Temp mutes / suspensions | `mute:` / `ban:` / `suspend:` | admin-bot / panel (`moderation`) | = action duration | JSON / int |
| Cached Hypixel responses | `cache:` | hypixel client / workers | seconds–hours | JSON(+meta) |
| Worker locks | `lock:` | workers | short (auto-expire) | token string |
| Deduplication keys | `dedup:` | emitters (bots/workers) | short window | bit / int / string |

---

## 1. Command Cooldowns (`cd:`)

- **Naming:** `cd:{surface}:{command}:{userId}` and in-game `cd:ingame:{command}:{ign}`; bridge relay cooldown `cd:relay:{surface}:{userId}`.
- **TTL:** the cooldown window itself (seconds–minutes); the key *is* the cooldown — presence = on cooldown. In-game tiers are stricter.
- **Serialization:** usually **TTL-only** (empty/`1` value) checked via `EXISTS`, or a small int for token-bucket-style remaining count.
- **Ownership:** written by whichever surface enforces the command (bridge-bot, admin-bot, web-panel).
- **Invalidation:** self-expiring; `BYPASS_COOLDOWN` capability skips the check entirely (never written). Manual clear only for support/debug.

```
cd:BRIDGE_BOT:networth:214...901      SET NX EX 30
cd:ingame:stats:AriaMC                SET NX EX 15
cd:relay:BRIDGE_BOT:214...901         (token bucket window)
```

---

## 2. Session & OAuth State (`sess:` / `oauth:`)

- **Naming:** session `sess:{sessionId}`; transient OAuth flow state `oauth:state:{state}` (CSRF/nonce), `oauth:pkce:{state}`.
- **TTL:** sessions hours with **sliding renewal**; OAuth flow state minutes (single-use).
- **Serialization:** **JSON** — `{ discordId, manageableGuildIds[], roleCacheByGuild, csrfToken, createdAt, expiresAt }`. Discord access/refresh tokens stored **encrypted** (never plaintext).
- **Ownership:** `packages/identity` via the web-panel; only the panel writes/reads sessions.
- **Invalidation:** logout deletes `sess:*`; refresh-token rotation replaces contents; permission re-validation on guild entry can shorten TTL. OAuth state keys are deleted on first use (single-use, replay-proof).

```
sess:9f3c...            {"discordId":"214...","manageableGuildIds":[...],"exp":...}   EX 21600 (sliding)
oauth:state:Xk92...     "pending"   EX 300  (deleted on callback)
```

---

## 3. Event Dispatch & Queues (`bull:` / `chan:` / `buf:`)

Three distinct mechanisms:

- **Job queues — `bull:{queueName}:*`:** owned/encoded by **BullMQ**; contains job data, delayed/repeatable schedules, and state. Do not hand-edit. TTL is queue-managed (completed/failed retention configured per queue).
- **Pub/sub channels — `chan:{topic}:{scope}`:** fire-and-forget domain events for cross-instance fan-out. No TTL (transient messages, not stored). Topics: `chan:bridge:{guildId}` (relay fan-out), `chan:config:{guildId}` (config reload), `chan:mod:{guildId}` (enforcement changes), `chan:events` (global refresh signals).
- **Analytics ingest buffer — `buf:analytics`:** a Redis **Stream** (append-only), drained by the `analytics-ingest` consumer group; trimmed by `MAXLEN` once consumed.

- **Serialization:** BullMQ internal; pub/sub payloads small **JSON**; stream entries field-map JSON.
- **Ownership:** workers own queues + stream consumers; any surface may **publish** to `chan:*`; bots subscribe.
- **Invalidation:** queues age out by retention; pub/sub not stored; stream trimmed after consumption.

```
bull:ah-sweep:repeat:...           (BullMQ-managed)
chan:config:872...                 PUBLISH {"type":"config.reload","v":42}
buf:analytics                      XADD * type command.used guildId 872... ...
```

---

## 4. Rate-Limit Buckets (`rl:`)

- **Naming:** shared Hypixel budget `rl:hypixel` (account-wide); optional per-endpoint `rl:hypixel:{endpoint}`; Discord/webhook pacing `rl:discord:{scope}`.
- **TTL:** a **rolling window** aligned to the upstream reset — refreshed from real response headers (`RateLimit-Remaining`/`Reset`, `Retry-After`), not guessed.
- **Serialization:** **hash** `{ limit, remaining, resetAt }` or a token-bucket int with a companion `resetAt`.
- **Ownership:** the `packages/hypixel` client writes it from headers; workers and live handlers both consume tokens, with a **reserved worker fraction** so sweeps can't starve commands.
- **Invalidation:** self-resets each window; a `429` with `Retry-After` overrides remaining to 0 until reset. Never manually cleared in normal operation.

```
rl:hypixel        HSET limit 300 remaining 271 resetAt 1723489200   (updated from headers)
rl:discord:webhook:872...   (pacing bucket)
```

---

## 5. Bridge Flood Counters (`flood:`)

- **Naming:** per-user `flood:user:{guildId}:{userId}`, global guild cap `flood:guild:{guildId}`, mention cap `flood:mention:{guildId}:{userId}`.
- **TTL:** short sliding windows (seconds) sized to the flood rule; escalation counters slightly longer.
- **Serialization:** **int** counters via `INCR` + `EXPIRE` (first-write sets TTL); escalation state a small JSON if needed.
- **Ownership:** the bridge-bot (pipeline stage 5) writes/reads these; feeds anti-spam decisions and, on sustained abuse, raises an `Infraction(SPAM)`.
- **Invalidation:** windows self-expire; a `/mute` supersedes counters (mute check happens earlier in the pipeline). The **global guild cap** specifically protects against Hypixel's own guild-chat spam limit.

```
flood:user:872...:214...    INCR → 4   EX 10   (drop if > threshold)
flood:guild:872...          INCR → 57  EX 5    (shed low-priority relays)
```

---

## 6. Temporary Mutes / Suspensions (`mute:` / `ban:` / `suspend:`)

These **mirror** durable `ModerationAction`/`GuildConfig` records in Postgres for fast enforcement — Redis is the hot-path check, Postgres is the truth.

- **Naming:** `mute:{guildId}:{userId}`, `ban:{guildId}:{userId}`, bridge suspension `suspend:bridge:{guildId}`.
- **TTL:** exactly the **action duration** (Redis auto-expiry = the punishment expiring); indefinite actions store no TTL and are cleared explicitly.
- **Serialization:** small **JSON** `{ actionId, until, reason, actor, surfaces:[discord,guildchat] }` (mutes note both surfaces for the cross-surface `/mute`); or int flag for simple suspend.
- **Ownership:** written by `packages/moderation` from the admin-bot **or** the panel; both bots read it before relaying/allowing actions.
- **Invalidation:** TTL expiry ends the punishment; an unmute/unsuspend **deletes** the key and writes a corresponding durable action; on restart, keys are **rehydrated** from active Postgres records so enforcement survives a Redis flush.

```
mute:872...:214...   {"actionId":"...","until":1723492800,"surfaces":["discord","guildchat"]}   EX 3600
suspend:bridge:872...   {"reason":"raid","actor":"...","until":...}   EX 1200
```

---

## 7. Cached Hypixel Responses (`cache:`)

- **Naming:** `cache:hypixel:{resource}:{id}[:sub]` — e.g. `cache:hypixel:profile:{uuid}:{profileId}`, `:player:{uuid}`, `:museum:{profileId}`, `:guild:{id}`, `:res:{name}`; market caches `cache:pricing:bazaar`, `cache:pricing:item:{itemId}`, `cache:ah:lbin:{itemId}`, global `cache:sb:election`.
- **TTL:** per-resource (player 5–10m, profile 3–5m, museum 10m, bazaar 60–90s, resources 6–24h) — see `HYPIXEL_DATA_LAYER.md`. Negative results (`API_DISABLED`/`MISSING_PROFILE`) cached 30–60s.
- **Serialization:** **JSON with metadata** `{ data, fetchedAt, freshness, source }`; workers write market **indexes** (maps), never raw AH pages.
- **Ownership:** the `packages/hypixel` client (on-demand player-scoped) and **workers** (global/market via shadow-key swap). Commands are **read-only** consumers of market/global caches.
- **Invalidation:** TTL + **stale-while-revalidate** (serve + refresh) and **stale-if-error** (serve `STALE` on upstream failure); **single-flight** via `lock:hypixel:*` coalesces concurrent misses; AH indexes replaced by **atomic promote**, so readers never see partial data.

```
cache:hypixel:profile:5f0...:83e...   {"data":{...},"fetchedAt":...,"freshness":"LIVE"}   EX 240
cache:pricing:bazaar                  {"data":{...},"fetchedAt":...}   EX 75
cache:ah:lbin:HYPERION                (promoted from shadow key by ah-sweep)
```

---

## 8. Worker Locks (`lock:`)

- **Naming:** `lock:job:{name}[:{scope}]` (e.g. `lock:job:ah-sweep`, `lock:job:guild:872...`, `lock:rollup:daily:2026-08-05`), single-flight `lock:hypixel:{cacheKey}`.
- **TTL:** **short, always set** (a few seconds to a couple minutes ≥ expected job step) so a crashed holder can't deadlock; long jobs renew (lock extension) while alive.
- **Serialization:** a unique **token string** (owner id/nonce) set with `SET key token NX PX ttl`; released via a compare-and-delete Lua script so only the owner unlocks.
- **Ownership:** workers (job mutexes); the hypixel client (single-flight coalescing).
- **Invalidation:** released on completion (owner-checked delete) or auto-expires on crash. Idempotent job design (see `WORKERS.md`) means a lost lock + rerun never corrupts state.

```
lock:job:ah-sweep         SET <token> NX PX 120000   (renew while running)
lock:hypixel:cache:...     SET <token> NX PX 5000     (single-flight)
```

---

## 9. Deduplication Keys (`dedup:`)

- **Naming:** by purpose — relay `dedup:relay:{guildId}:{hash(author+content)}`, announcements `dedup:milestone:{accountId}:{type}:{threshold}`, news `dedup:news:{eventId}`, reminders `dedup:reminder:{eventId}:{offset}`, analytics `dedup:event:{eventId}`.
- **TTL:** the dedup window — short for relay (seconds), longer for announcements/news (hours–days) so restarts don't repost.
- **Serialization:** presence-only (`SET NX`) or a small int/bitmap; some announcement dedup is also enforced by a Postgres flag (`Milestone.announced`) with Redis as the fast guard.
- **Ownership:** whichever component emits the deduped action (bridge-bot for relay/announce, workers for reminders/news/analytics ingest).
- **Invalidation:** self-expiring; durable dedup (milestones/reminders) is backed by DB flags so it survives a Redis flush — Redis only prevents *near-term* duplicates cheaply.

```
dedup:relay:872...:9a1f      SET NX EX 8        (drop identical repeat)
dedup:milestone:5f0...:CATA:45   SET NX EX 86400   (announce once; DB-backed)
dedup:reminder:evt42:1h      SET NX EX 7200
```

---

## 10. Ownership & Lifecycle Summary

| Category | Authoritative? | Survives Redis flush? | How restored |
|----------|----------------|-----------------------|--------------|
| `cd:` cooldowns | No | No (acceptable) | N/A — windows just reset |
| `sess:`/`oauth:` | Yes (only home) | No | Users re-login (expected) |
| `bull:`/`buf:`/`chan:` | Queue/stream: operational | Partially (BullMQ persistence) | BullMQ recovers; pub/sub is transient |
| `rl:` buckets | No | No | Rebuilt from next response headers |
| `flood:` counters | No | No (acceptable) | Windows reset |
| `mute:`/`ban:`/`suspend:` | No (mirror of Postgres) | No → **rehydrated** | Re-seeded from active `ModerationAction`/`GuildConfig` on boot |
| `cache:hypixel/pricing/ah` | No | No | Repopulated on demand + by workers |
| `lock:` | No | No | Auto-expire; jobs idempotent |
| `dedup:` | No (DB-backed for durable ones) | Partially | DB flags prevent durable double-posts |

**Guiding rules**
- **Redis is a coordination/cache layer, not the database.** Everything enforceable (mutes, bans, suspensions) is mirrored from Postgres and **rehydrated on startup**, so a Redis flush degrades performance, never correctness.
- **Every ephemeral key has a TTL**; only worker-owned indexes/queues are refreshed instead of expired.
- **Invalidation is event-driven + self-healing:** config/permission/wordlist writes publish on `chan:config:*` and bump version-stamped cache keys; a periodic reconcile pass repairs missed invalidations (see `WORKERS.md` §2.11).
- **Category prefixes enable safe, scoped operations:** `SCAN sbr:cache:*` to clear caches without touching `sess:`, `bull:`, or `mute:`.

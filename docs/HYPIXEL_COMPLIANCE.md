# Hypixel API compliance

How this platform satisfies the [Hypixel Developer API Policy](https://developer.hypixel.net/policies/)
(last read 2026-07-16), clause by clause, naming the file and mechanism for each.

This document describes **what the code does**, not what it intends to do. Where a
clause is not yet satisfied it says so plainly, with the remediation and its state.
If you change a mechanism named here, change this file in the same commit — a
compliance document that has drifted from the code is worse than none, because it
is the thing an application for a key is judged against.

---

## 0. Which regime this install runs under

**The guild-activity exception**, not a production-tier key.

This is one guild — Skyblock and Relax, roughly 125 members — and the person who
runs the platform is its owner and the holder of the API key. That makes the
exception the natural fit: personal key, owner-registered, non-production use, at
most one request per player per hour.

`HYPIXEL_KEY_MODE` (`packages/config/src/index.ts`) selects the regime. It
defaults to `personal`, which is what ships. The default direction matters:
forgetting an environment variable should not be how a deployment gains
permission to poll harder. `production` exists so the enforcement points are
already wired if the guild ever outgrows the exception; setting it without a key
on file is a boot failure rather than a warning.

### The commitments that come with it

These are operating constraints, not aspirations. Breaking one means this
document no longer describes a compliant deployment:

- **Non-production.** No monetisation, no public offering, no second guild, no
  hosted instance for anyone else.
- **One application.** One registered Hypixel application covers the whole
  project — both bots and the web panel share a single key through
  `packages/config`. Additional keys to widen the budget would be exactly the
  circumvention the policy names.
- **One guild.** The multi-guild shapes in the schema and panel are structural.
  A second guild on this key changes the analysis and needs this document revised
  before, not after.

### The residual risk, stated rather than papered over

The exception reads most naturally as *one operator's personal use*, and this bot
is member-facing: members run `/profile`, leaderboards post to Discord. The
reading taken here is that a single owner running a bot for their own guild is
personal, non-production use. What makes it defensible is that **every
member-facing surface is served from cache** — a member running a command does
not trigger a fetch about themselves or anyone else; it reads what the cache
already holds.

If Hypixel disagrees, the fix is to restrict the Hypixel-sourced commands to the
owner. That is a config change at the dispatcher, not a rewrite.

---

## 1. No session tracking

> Continuous polling of a player's stats to build a history shown back to users.

**Status: satisfied. The series it describes no longer exists.**

This is the one clause that survives every key route — it is unconditional, and
not part of the guild-activity carve-out. It is stated first because it is the
one this codebase used to violate.

### What it used to be

`ProfileSnapshot` was an append-only per-player stat series, fed by a
`profile-snapshot` job twice an hour and by `event-tracking` every ten minutes.
Five features read it: `/progress` charts, `/goal` pace projections, milestone
detection, five leaderboard categories, and event stat-scoring. The
append-a-reading-per-member-forever shape is the prohibited pattern regardless of
how slowly it appends.

### What replaced it

**`ProfileCurrent`** (`packages/db/prisma/schema.prisma`) — one row per
`(minecraftAccountId, profileId)`, upserted in place, never appended. It carries
the current reading plus a `previousMetrics` mirror of the single reading it
displaced. Two values, not a series, and the second exists only so a milestone
crossing can be noticed at all.

That was possible because none of the four automatic features needed a history in
the first place: milestone detection reads two values
(`packages/jobs/src/progression.ts`, `recentReadings`), and leaderboards, the
perms roster and profile cards read the newest. All four keep identical output.

`profile-refresh` (`apps/workers/src/schedule.ts`, hourly at `7 * * * *`)
performs the upsert. It is a guild-activity refresh keeping the roster and the
boards current, not a history: nothing it writes accumulates, and no query can
reconstruct a member's past from what it leaves behind.

**Event tracking** writes a **baseline and a final**, and nothing between them.
The final is an overwrite, so the last pass before an event completes *is* the
final and no lookahead is needed. Two rows per participant per event is a
structural ceiling rather than a job-level convention — the unique index
`@@unique([minecraftAccountId, eventId, source])` means a third row will not
insert. `pollIntervalMinutes` is clamped to a 60-minute floor in `trackEvents`
itself (`EVENT_POLL_FLOOR_MINUTES`), not only in the panel, because rows carrying
the older 5- and 10-minute values are still in the database.

The floor is 30 minutes — the cadence a live contest actually wants — **only**
where `HYPIXEL_KEY_MODE=production` asserts a production-tier grant.
`eventPollFloorMinutes` (`packages/shared-types/src/enums.ts`) is the one place
that decision is made, and both enforcement points read it: the panel refuses a
shorter interval at write time, and `trackEvents` clamps at read time in case a
row outlives the key that allowed it. On the shipped default — `personal` — the
floor is an hour, which is the per-player cap this section is about.

### The history that remains is one members build themselves

`ProfileSnapshot` narrows to rows a member explicitly saved. `/snapshot`
(`packages/commands-bridge/src/handlers-snapshot.ts`) copies their current
reading into a row they own, optionally named. `/progress` and `/goal` chart
those and only those — `listSnapshots` filters `source: "USER_SAVED"`, so event
boundaries sharing the table are excluded and a member cannot find a chart of
themselves appearing because they RSVP'd to something.

Three properties make this an explicit feature rather than the same tracking by a
slower route:

- **A save costs no upstream request.** It copies the reading the refresh job
  already holds. That is enforced by construction — the repository method reads
  `ProfileCurrent` and never the Hypixel client — and asserted by a test whose
  profile provider throws if it is called at all.
- **It is bounded.** `SAVED_SNAPSHOT_LIMIT` is 24 per account, trimmed inside the
  same transaction as the insert rather than by a nightly sweep, so the cap holds
  from the moment it is exceeded.
- **It is self-only.** The command takes no player argument; the uuid comes from
  the caller's own link. There is no way to build a history about somebody else.

Under two saved snapshots the reply says to save one, rather than drawing an
empty chart (`copy.embed.card.noSnapshots` / `oneSnapshot`).

There is deliberately **no panel button** for this. Member-facing interaction
belongs on the bot; the panel is the staff surface.

---

## 2. At most one request per player per hour

**Status: satisfied, by two independent controls.**

The ordering matters and is deliberate: the cache is what keeps volume inside the
cap, and the limiter is what proves the bound holds.

### The cache (the control that does the work)

`packages/hypixel/src/client.ts`, the `TTL` table. Player-scoped endpoints:

| Endpoint | TTL |
|---|---|
| `player` | 6 h |
| `skyblock/profiles` | 6 h |
| `skyblock/museum` | 12 h |
| player auctions | 6 h |

At a 6-hour TTL a member viewed twenty times a day costs four upstream reads, not
twenty. These were 3–10 minutes, which was a cost decision; they are now a policy
one. Market endpoints (`bazaar` 90 s, auction pages 60 s) are unchanged and
deliberately so — see §4.

The **only** route to data fresher than the TTL is an explicit `maxAgeMs`
(`PlayerReadOptions`), which exists for a member or operator pressing refresh.
Nothing scheduled passes it, and a refresh button pressed twenty times in a
minute still costs one upstream call at most, because the limiter is downstream
of it.

### The limiter (the control that proves it)

`PlayerRateLimiter` (`packages/hypixel/src/ports.ts`), implemented as
`RedisPlayerRateLimiter` (`packages/redis/src/adapters.ts`) over `SET NX EX` on
`rl:player:{uuid}:{endpoint}`. Checked in `fetch()` **before** the shared rate
gate.

It is a separate port from `RateGate` because the two answer different questions.
The gate asks whether the fleet has budget, and folds Hypixel's own response
headers back in — upstream is the authority on it. The limiter asks whether we
have already read *this player* recently, against our own clock and regardless of
what upstream would allow. A cap that yielded to upstream's headers would not be
a cap at all; the whole point is that it holds when Hypixel would have said yes.

Two properties worth stating because they are interpretations, not mechanics:

- **Claims are keyed per player *per endpoint family*.** A networth figure needs
  `player`, `skyblock/profiles` and `skyblock/museum` for one person. A single
  shared claim would mean that reading someone's profile locked out reading their
  museum until the next hour — the feature would simply not work. So "one request
  per player per hour" is read as one *refresh* per player per hour, giving a
  worst case of three upstream calls per player per hour. In practice the TTLs
  put it far below that.
- **A claim is spent on the attempt, not on success.** If the request then fails,
  the slot stays consumed until the window rolls. Releasing on failure would let
  a flapping endpoint be retried without limit, which is the pattern the cap
  exists to prevent. Stale cache covers the user-visible cost.

An unreachable Redis errs open, because the cache TTL is a second floor
underneath and a failed limiter must not become a failed player lookup.

### The arithmetic

125 members ⇒ 125 requests per hour permitted. Observed usage is roughly 10–20
per hour. The cap is not the binding constraint and is not close to being one;
it is enforced in code anyway, because a promise that is only kept by accident is
not a promise.

Tests: `packages/hypixel/src/client.test.ts` (cache hits, TTL lapse, per-player
and per-endpoint claim isolation, the refresh route),
`packages/redis/src/adapters.test.ts` (window behaviour, erring open),
`packages/config/src/config.test.ts` (mode defaults and validation).

---

## 3. No de-anonymising nicked players

**Status: satisfied, and now guarded by tests.**

`getLinkedDiscord` (`packages/hypixel/src/client.ts`) makes exactly two upstream
reads, always: Mojang for the uuid, then the Hypixel player object. **There is
deliberately no fallback route.** A name Mojang does not know is a name that does
not exist — which is what a nick looks like from here — and the obvious next
moves (scan the guild roster for a near-match, search active auctions, walk
recent chat) would all amount to working out who is behind the nick.

An inconclusive lookup therefore stays inconclusive: `IGN_NOT_FOUND` when Mojang
has nothing, a thrown `HypixelUnavailableError` when Hypixel will not answer.
Both are honest, and neither identifies anybody. The two IGN→uuid adapters in the
composition roots go through Mojang only and never touch Hypixel.

There is no feature whose purpose is tracking a specific player by rank or stat.
Leaderboards rank the guild's own members over the guild's own roster.

---

## 4. Aggressive caching

**Status: satisfied.**

Beyond the player TTLs in §2, the split between the two caching regimes is the
policy's own:

- **Player data — hours.** Covered above.
- **Market data — seconds to minutes.** Bazaar and auction pages are public,
  guild-agnostic, and one request serves every member at once, so they are not
  player polling in any sense. `packages/pricing` caches independently of any
  player: `market.ts` (`BIN_STALE_AFTER_MS`, 10 min) and `catalog.ts`
  (`REFRESH_MS`, 1 h) are keyed by item, never by who asked.

Market commands (`/price`, `/auctions`, `/mayor`) read
worker-populated Redis keys only and never trigger a sweep themselves.

Guild reads are one request per guild per six hours (`guild-scan`, cron
`26 1,7,13,19 * * *`) against the guild endpoint. Nothing per-player is requested,
so the per-player cap is not engaged — one response carries the whole roster.

---

## 5. Key hygiene

**Status: satisfied. Audited at this commit.**

- The key is read once, in `packages/config/src/index.ts`, from
  `HYPIXEL_API_KEY`. It reaches exactly four call sites — the
  `apps/*/src/composition.ts` roots — and from there only the `HypixelClient`
  constructor.
- It is sent as an `API-Key` request header and never appears in a URL, so
  nothing that logs a URL can leak it.
- The client logs two messages, both carrying a *cache* key. No log call in
  `packages/hypixel` receives the API key, headers, or a request object.
- Nothing in `apps/web-panel/client/**` references `HYPIXEL_API_KEY` or an API
  key of any kind — the panel's Hypixel data arrives as already-fetched DTOs from
  the server.
- `.env` is git-ignored; `.env.example` carries a placeholder.
  `git log -S"HYPIXEL_API_KEY="` across all history returns only that placeholder
  and a test fixture string. No key value has ever been committed.
- The internal APIs the bots expose are loopback-bound and bearer-authenticated,
  so nothing third-party-hosted proxies a keyed request.

---

## 6. Analytics carries no Hypixel data

**Status: satisfied.**

`DIM_KEYS` (`packages/analytics/src/rollup.ts`) covers `command.used`,
`bridge.relay`, `mod.action` and `filter.hit` — first-party Discord and community
metrics only. No Hypixel-sourced statistic enters the analytics pipeline or its
CSV export.

---

## Change log

- **2026-08-21** — First version. §2, §3, §5 satisfied and tested; §1 documented
  as outstanding with the remediation in progress.
- **2026-08-21** — §1 satisfied. `ProfileCurrent` replaces the stat series,
  `profile-refresh` replaces `profile-snapshot`, event tracking narrows to a
  baseline and a final behind a 60-minute floor, and the charted history becomes
  the member-saved snapshots `/snapshot` writes.

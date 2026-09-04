# Hypixel API compliance

What this bot does with the Hypixel API, clause by clause, with the code path
that implements each claim and the test that holds it in place.

Every section carries a status. `satisfied` means there is a named code path and
a named test, both of which exist and pass in this repository. `pending` means
the section is written but the mechanism it describes has not landed yet — this
file is filled in as the bot is built, not written once at submission time.

> **These sections are not documentation of an intention.** Each is a constraint
> the build enforces. `npm run scan` fails on a persistence surface that should
> not exist; `npm test` fails on a limiter that stopped limiting. If a future
> feature seems to require relaxing one of these, that is a decision to argue
> for in the open, not a column to add quietly.

---

## 0. Which regime this install runs under

**Status: pending**

`HYPIXEL_KEY_MODE` selects the policy regime, and the default is the restrictive
one so that an install which never sets it is `personal` rather than
`production`:

- **`personal`** — a personal key under the guild-activity exception:
  non-production use, and at most one request per player per hour, enforced
  against our own clock rather than against the headers upstream sends back.
- **`production`** — a granted production-tier key. The enforcement points are
  wired for it so the switch is a configuration change rather than a rewrite,
  and in this mode the cache TTL is the only per-player floor.

*Code path:* `src/config.ts` — `HypixelKeyMode`, `PERSONAL_PLAYER_WINDOW_MS`,
and the derivation of `hypixel.playerWindowMs`.
*Test:* pending.

---

## 1. No session tracking

**Status: pending**

Nothing this bot reads from the Hypixel API is written down. A profile is read,
advice is computed from it, the answer is rendered, and the values are gone with
the response — held only in a cache entry that expires.

Concretely, and checkably:

- **No table whose rows are keyed by `(uuid, capturedAt)`**, or by any other
  pairing of a player with a time of observation.
- **No table storing any Hypixel-derived player value at all** — no skill level,
  no networth, no slayer total, no collection count, no weight.
- **No aggregate or rollup** derived from such values, daily or otherwise.
- **No leaderboards.** There is no ranking table and no cross-player comparison
  anywhere in this repository.

The only player-scoped rows are an identity and a preference: the
Discord-to-Minecraft link, and which SkyBlock profile the player wants advice
about. Both are facts the player supplied, not observations we made.

*Code path:* `prisma/schema.prisma` — three models, `PlayerLink`,
`ProfilePreference` and `ContentVersion`, with the exclusions stated in the file
header. `src/db/index.ts` is the only module that touches Prisma.
*Test:* pending — `scripts/denylist-scan.mjs` is the automated half and runs in
CI as a required check.

---

## 2. At most one request per player per hour

**Status: pending**

Two independent controls, deliberately not one:

**The cache** does the work. A profile read is cached for six hours, so the
common case never reaches upstream at all. The soft-expiry envelope means a
lapsed entry is still servable when Hypixel is unreachable — a stale answer
carries `freshness: "STALE"` on an otherwise successful result, and the renderer
says how old it is rather than pretending it is current.

**The limiter** proves it. `SET NX EX` on `rl:player:{uuid}:{endpoint}`: the key
existing *is* the claim, so two processes racing the same subject produce
exactly one winner. The claim is spent on the attempt and nothing releases it if
the request then fails — releasing on failure would let a flapping endpoint be
retried without limit, which is the pattern the cap exists to prevent.

A refresh past the cache is reachable only from an explicit, user-pressed
refresh, never from a background path.

*Code path:* `src/redis/index.ts` — `RedisPlayerRateLimiter`,
`RedisHypixelCache`; `src/hypixel/client.ts` — the `cached()` request pipeline
and `PlayerReadOptions.maxAgeMs`.
*Test:* pending.

---

## 3. No de-anonymising nicked players

**Status: pending**

Name resolution goes through Mojang and only Mojang. There is no fallback that
walks a guild roster, searches the auction house, or reads chat to turn a
partial or unresolvable name into a player.

An inconclusive lookup stays inconclusive. The client returns a typed failure —
one of `NOT_LINKED`, `MISSING_PROFILE`, `API_DISABLED` or `RATE_LIMITED` — and
the command renders that state honestly rather than guessing at an identity.

The endpoints that would make de-anonymisation possible are not implemented in
this repository at all: there is no guild endpoint, no per-player auction
listing, and no ended-auction history. That is a reduction of the client this
bot was extracted from, and dropping them was the point of the exercise rather
than an oversight.

*Code path:* `src/hypixel/client.ts` — `resolveUuid`, `resolveIgn`; the exported
surface in `src/hypixel/index.ts` is the complete list of callable endpoints.
*Test:* pending.

---

## 4. Aggressive caching

**Status: pending**

Every endpoint goes through one request pipeline — cache lookup, single-flight,
per-player claim, shared rate gate, HTTP, header ingest, retry with backoff,
normalise, cache set — so caching is implemented once rather than per method.

Single-flight matters as much as the TTLs: concurrent misses for the same key
share one upstream call, so a burst of commands about the same player is one
request, not a burst of them.

Public, world-scoped reads (bazaar, auction pages, mayor election, fire sales,
bingo, resources) are fetched by a background job once for everybody. They are
not per-user reads and do not scale with the number of people using the bot.

*Code path:* `src/hypixel/client.ts` — the `TTL` table and `cached()`.
*Test:* pending.

---

## 5. Key hygiene

**Status: pending**

The key is read once, in `src/config.ts`, reaches exactly one construction site,
in `src/composition.ts`, and is sent as an `API-Key` header — never in a URL. A
key in a query string ends up in proxy access logs, browser referrers and error
reports; a header does not.

It is never logged, never rendered into a command response, and never included
in an error message returned to a user.

*Code path:* `src/config.ts` — `hypixel.apiKey`; `src/composition.ts` — the
single `new HypixelClient({ apiKey })`; `src/hypixel/client.ts` — the header
construction.
*Test:* pending.

---

## 6. Analytics carries no Hypixel data

**Status: pending**

Whatever operational telemetry this bot keeps is first-party only: which command
ran, whether it succeeded, how long it took, and how the upstream call behaved.
No value read from the Hypixel API appears in it — not as a field, not as a
label, not embedded in a message string.

*Code path:* `src/log/meter.ts` — the metered surfaces are counts and latencies
per upstream, with no payload.
*Test:* pending.

---

## Change log

- *(unreleased)* — initial extraction. Sections written, statuses pending;
  filled in as each mechanism lands.

# Immediate paths and their worker backstops

Some state is time-sensitive enough that a member notices the delay. Those
flows act on the request itself and keep a periodic worker underneath them as a
backstop — never as the primary path, and never as a competitor.

The rule every entry below obeys:

> **The immediate path may only make things happen sooner. It may never be the
> thing that makes them happen at all.**

That is why every immediate path writes a durable mark *before* it acts, and why
none of them consumes that mark on success. A crash, a restart, a dropped Redis
publish, a rate limit — all of them cost latency, and none of them costs
correctness.

## Role application on `/link`

| | |
|---|---|
| **Trigger** | `/link` and `/verify` in `packages/identity/src/service.ts` |
| **Immediate work** | Settle Hypixel guild membership, mark dirty, nudge a reconcile |
| **Backstop** | `role-sync`, every 15 minutes (`11-59/15 * * * *`), plus a daily full sweep |
| **Flag** | `LINK_GUILD_PROBE` (`0` disables the live probe) |
| **Retry** | One in-process retry after `LINK_GUILD_PROBE_RETRY_MS` (default 45 s) |

The chain, in order:

1. `IdentityServiceImpl.linkByIgn` writes the verified link.
2. `memberRoleDirtyMarker` (`packages/db/src/repositories/role-sync.ts`) fans the
   guild-agnostic link out to every platform guild the member belongs to.
3. Per guild, it settles **guild membership** — the one auto-role fact that does
   not live in our database:
   - with the probe on, `createGuildRankProbe` asks Hypixel
     `guild?player=<uuid>` and `writeGuildRank` stores the answer, overwriting;
   - with the probe off or unavailable, `adoptCachedGuildRank` falls back to the
     roster cache, which fills a null rank and never overwrites one.
4. It marks the member in `roles:dirty:<guildId>`.
5. `RedisRoleDirtySet.mark` publishes a nudge on `chan:role-nudge`.
6. The workers process picks it up, paces it through the per-guild token bucket
   in `packages/jobs/src/role-nudge.ts`, and runs `syncOneMember`.

**Ordering is load-bearing.** Membership is settled *before* the mark, never
after: the reconcile a mark triggers reads the member's facts once, so a rank
that lands afterwards is a fact that arrived too late to be used. This was a
real bug, and `adoptCachedGuildRank`'s doc comment records it.

### The three answers, and which one revokes

The probe returns a rank, `null`, or `undefined`, and the distinction is the
whole point:

- **a rank** — they are in the bound guild. Stored; guild-gated rules grant.
- **`null`** — Hypixel answered, and they are in another guild or none.
  Confirmed absence. Stored as a null rank, so guild-gated rules **revoke** on
  the spot rather than at the next roster scan.
- **`undefined`** — Hypixel did not answer (rate limited, key rejected,
  unreachable, socket error). Not evidence about the member. Nothing is written,
  nothing is revoked, and the member is told their roles are pending.

Reading an outage as absence would revoke the guild role of everybody who linked
during it. That is a far worse failure than a role arriving fifteen minutes
late, which is why only the middle answer is allowed to remove anything.

### What the member sees

- roles applied → `linkDone` / `linkConfirmed`
- membership unconfirmed → `linkPending`: *"Linked to **X**. Hypixel is not
  answering right now, so your guild roles will arrive shortly."*

The link itself always succeeds. A Hypixel outage delays a role; it does not
fail a link, and the copy says so.

### Leaving the guild

Revocation is still primarily the roster scan's job, because nothing fires an
event when somebody leaves a Hypixel guild. `guild-scan` notices the departure,
`guild-roster-sync` reconciles it, and the member is marked dirty. The probe
makes it *sooner* only when the departed member happens to run `/link` or
`/verify` again — at which point their rank is cleared immediately.

## Everything else on the same mechanism

These publish to the same dirty set and inherit the same backstop:

| Flow | Marked by |
|---|---|
| Punishment applied or lifted | `packages/moderation/src/service.ts` |
| Event attendance recorded | `packages/community/src/service.ts` |
| Guild rank change seen by a scan | `guild-scan` → `discordIdsForUuids` |
| Unlink | `IdentityServiceImpl.unlink` |

Bulk marks (a roster scan touching two hundred members) deliberately **do not**
nudge: `MAX_NUDGED_PER_MARK` caps it, because nudging each of them would flood a
queue that would drop most of them anyway and would spend the guild's Discord
role budget racing a sweep already scheduled to do the same work.

## Pacing, and why it is not parallelism

Discord's per-guild role bucket is empirically about ten modifications per ten
seconds, and one member's reconcile can cost two of them. The nudge queue is
therefore one member at a time per guild from a token bucket (`NUDGE_BURST = 1`,
`NUDGE_REFILL_MS = 2500`, `NUDGE_MAX_PENDING = 50`). A single person linking
spends a token that is always there. A crowd is spread over the following
minute. Past fifty pending, the queue declines — at that depth the immediate
path has nothing to offer over the sweep.

## Environment

| Variable | Default | Effect |
|---|---|---|
| `LINK_GUILD_PROBE` | `1` | `0` disables the live Hypixel guild probe; the marker reverts to roster-cache behaviour |
| `LINK_GUILD_PROBE_RETRY_MS` | `45000` | Delay before the single in-process retry of an unconfirmed membership |

No migration is required for any of this.

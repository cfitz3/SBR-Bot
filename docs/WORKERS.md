# Background Workers & Scheduled Jobs — SBR Guild Platform

Design for `apps/workers` — the process that owns everything slow, periodic, global, or paginated so the bots and panel stay on the fast path. Built on **BullMQ over Redis**; every job is repeatable/queued, guarded by a distributed lock, idempotent, retry-aware, and writes a `WorkerJobLog` on completion.

**Cross-cutting conventions (apply to every job below; not repeated per row)**
- **Lock:** each job takes `lock:job:{name}[:{scope}]` so overlapping runs can't double-write.
- **Rate budget:** any job hitting Hypixel draws from the shared `rl:hypixel` token bucket with a *reserved worker fraction* so it can't starve live commands (see `HYPIXEL_DATA_LAYER.md`).
- **Logging baseline:** start/finish/duration/attempt/outcome → `WorkerJobLog`; structured logs with correlation id; metrics event `job.completed(status)` → analytics; errors surfaced to the panel Health page.
- **Retry baseline:** transient failures → exponential backoff + jitter, capped attempts; permanent failures (bad input, 4xx auth) → no retry, dead-letter + alert.
- **Freshness contract:** consumers read caches tagged with `fetchedAt`/`freshness`; a late/failed job degrades to `STALE`, never a hard outage.

---

## 1. Job Catalog

| Job | Trigger | Frequency | Idempotency | Retry | Failure impact |
|-----|---------|-----------|-------------|-------|----------------|
| `bazaar-refresh` | Repeatable (cron) | 30–60 s | Overwrite snapshot key (last-writer-wins) | Backoff, keep last snapshot | Prices go `STALE`; commands serve last good |
| `ah-sweep` | Repeatable | 3–5 min | Build to shadow keys → atomic promote | Backoff; promote only if consistent | BIN/auction indexes `STALE`; no live paging risk |
| `ah-ended-ingest` | Repeatable | 1–2 min | Dedup by auction id | Backoff; idempotent replay | Sold-price signal lags; pricing slightly stale |
| `pricing-recompute` | Event (after bazaar/ah) + fallback cron | on upstream update / 2 min | Deterministic recompute from latest indexes | Recompute from source | Item prices `STALE` |
| `resources-refresh` | Repeatable | daily | Overwrite resource keys by name | Backoff; safe to replay | Reference data stale (low impact) |
| `profile-refresh` | Repeatable + on-demand | hourly, spread; each member at most once per 6 h | Upsert by `(uuid,profileId)` — one row, replaced | Backoff; per-member requeue | Leaderboards and milestones lag |
| `milestone-detect` | Event (after refresh) | per refreshed reading | Guard by `Milestone` unique + `announced` flag | Backoff; dedup on unique | Missed/late announcements only |
| `milestone-backfill` | Cron | daily 04:41 | Guard by `Milestone` unique; writes pre-announced | No retry; lock 30 min | New definitions unreflected for a day |
| `reminder-dispatch` | Scheduled (delayed jobs) | at offsets before events | Mark reminder sent (`reminderState`) | Backoff; skip if already sent | Missed/late reminder pings |
| `event-transition` | Repeatable + delayed | every 1–5 min / at boundaries | Idempotent state guard (only valid transitions) | Backoff; re-evaluate from truth | Event status lags (SCHEDULED→LIVE→COMPLETED) |
| `inactivity-scan` | Repeatable (cron) | daily/weekly | Deterministic over snapshot; flag not act | Backoff; recompute | Inactivity report delayed |
| `event-tracking` | Repeatable (cron) | every 10 min (`8-59/10 * * * *`), per-event interval on top | `EventScore` upsert on `(eventId,uuid,metric)`; baselines written once | 1 retry; global lock, 10 min TTL | Live event leaderboards age; recorded scores are unaffected |
| `event-board` | Repeatable (cron) | every 30 min (`13,43 * * * *`) | The board is one message, edited in place; `boardFinal` stops a finished card being rewritten | 1 retry; global lock, 5 min TTL | Live boards show older numbers than the database holds; nothing is duplicated |
| `leaderboard-post` | Repeatable (cron) | weekly, Sun 18:23 (`23 18 * * 0`) | **Not idempotent by design** — a re-run posts a second digest; the cadence and the global lock are the guard | 0 retries; global lock, 5 min TTL | A guild misses one week's digest; nothing reads what it writes |
| `role-sync` | Repeatable (cron) | every 15 min (`11-59/15 * * * *`), plus an immediate single-member pass on `chan:role-nudge` | Reconciles against current facts; only roles Discord confirmed are recorded, and only recorded grants are ever revoked | 1 retry; global lock, 5 min TTL | Auto-roles are applied late; nothing is granted or taken away wrongly |
| `ticket-sweep` | Repeatable (cron) | every 6 min (`5-59/6 * * * *`) | The warned flag is a Redis key with a 24 h TTL; a close is refused on an already-closed row | 2 retries; global lock, 5 min TTL | Quiet tickets are warned and auto-closed late; nothing is closed that should not be |
| `analytics-ingest` | Continuous (stream consumer) | continuous | Dedup by event id; consumer-group offset | Reclaim pending; replay | Analytics ingestion backlog |
| `analytics-rollup` | Repeatable (hourly/daily/weekly) | hourly / ~00:15 local / weekly | Rebuildable per `(guildId,metric,period)` | Backoff; recompute partition | Charts stale for a period |
| `xp-aggregate` | Repeatable (cron) | every 3 h (`48 */3 * * *`) | Derived awards upsert on `XpEvent.dedupeKey`; balances rebuilt from the whole ledger | 1 retry; global lock, 10 min TTL | Standings lag by up to a pass; nothing is lost — counters are re-derived next run |
| `config-cache-invalidation` | Event (on write) + reconcile cron | on config change / 5–10 min | Version-stamped keys; last-writer-wins | Backoff; reconcile pass | Bots read stale config until reconcile |
| `guild-roster-sync` | Repeatable | 5–15 min | Diff-based reconcile to DB | Backoff; per-guild lock | Roster/rank drift until next run |
| `guild-scan` | Repeatable (cron) | every 6 h (`26 1,7,13,19 * * *`) | Upsert on `(guildId,uuid)`; GEXP upsert on `(guildId,uuid,day)` overwrites | 1 retry; global lock, 10 min TTL | Member cache ages past its 6 h TTL; a missed day of GEXP is unrecoverable |

| `discord-member-sync` | Repeatable (cron) | every 2 h (`19 1,3,5,…,23 * * *`) | Upsert on `(guildId,discordUserId)`; departures marked `LEFT`, never deleted | 2 retries; global lock, 3 min TTL | The Discord side of the member directory ages; departures linger as ACTIVE |

*(guild-roster-sync included as the membership counterpart to the required set;
guild-scan is the in-game counterpart to both — see §2.14; discord-member-sync
mirrors the Discord roster for the panel's directory — see §2.15.)*

---

## 2. Job Specifications

### 2.1 `bazaar-refresh`
- **Trigger / frequency:** repeatable cron, 30–60 s.
- **Inputs:** Hypixel `skyblock/bazaar` quick-status.
- **Outputs:** `cache:pricing:bazaar` (whole snapshot) + derived per-item quick-status.
- **Idempotency:** snapshot is a full overwrite (last-writer-wins); no partial state.
- **Retry:** backoff on 5xx/timeout/`RATE_LIMITED`; on failure keep the previous snapshot.
- **Logging:** run + item count + age; failure counter feeds data-layer health.
- **Failure impact:** low/short — `/price` serves the last snapshot tagged `STALE`.

### 2.2 `ah-sweep` (+ `ah-ended-ingest`)
- **Trigger / frequency:** repeatable; sweep 3–5 min, ended-ingest 1–2 min.
- **Inputs:** paginated `skyblock/auctions` (workers only), `skyblock/auctions_ended`.
- **Outputs:** lowest-BIN index, per-player auction index, per-item aggregates → Redis.
- **Idempotency:** sweep builds into **shadow keys**, then atomic promote — readers never see a half-built index; ended-ingest dedups by auction id.
- **Retry:** paced under rate budget; if a sweep can't finish within budget, promote only if internally consistent, else keep the last good index and flag `STALE`.
- **Logging:** pages fetched, budget used, promote/skip decision, duration.
- **Failure impact:** none to live handlers (they read cache); indexes just age. **This is the job that keeps AH paging out of command handlers.**

### 2.3 `pricing-recompute`
- **Trigger / frequency:** event-driven after bazaar/ah update; cron fallback ~2 min.
- **Inputs:** latest bazaar snapshot, lowest-BIN index, ended-sold feed.
- **Outputs:** `cache:pricing:item:{itemId}` (blended value).
- **Idempotency:** pure function of current indexes → deterministic; safe to re-run.
- **Retry:** recompute from source; never partial-writes a blend.
- **Failure impact:** networth/price commands use last computed values (`STALE`).

### 2.4 `resources-refresh`
- **Trigger / frequency:** daily cron.
- **Inputs:** Hypixel `resources/*` (skills, collections, items, election metadata).
- **Outputs:** `cache:hypixel:res:{name}` (long TTL).
- **Idempotency:** overwrite by name.
- **Failure impact:** low — reference data changes rarely; last copy remains valid.

### 2.5 `profile-refresh`
- **Trigger / frequency:** repeatable, hourly, spread across the window; each member refreshed at most once per 6 h. Plus on-demand backfill.
- **Inputs:** tracked `MinecraftAccount`/`SelectedSkyblockProfile`, Hypixel profile (+museum) via the client.
- **Outputs:** one `ProfileCurrent` row per `(account, profile)`, upserted in place, carrying the reading it displaced in `previousMetrics`; warms profile cache.
- **Not a history, and that is a policy constraint rather than a design preference** — see docs/HYPIXEL_COMPLIANCE.md §1. The charted series is `ProfileSnapshot`, written only by `/snapshot` and by event boundaries.
- **Idempotency:** upsert keyed by `(uuid, profileId)`, so a re-run replaces rather than duplicates.
- **Retry:** per-member requeue with backoff; rate-budget-aware low-priority queue so it never beats live commands to a token.
- **Logging:** members processed, skipped (API disabled/rate), snapshots written.
- **Failure impact:** progression (`/progress`, `/whatnext`) and milestone detection lag; no user-facing error.
- **Event-tracked cohort:** a live event polls its own participants far more
  often than the bulk cadence does. That is `event-tracking` (§2.5b), which
  reuses this job's capture path rather than duplicating it — one definition of
  what a snapshot contains, so the event leaderboard and the progression charts
  are measuring the same thing.

### 2.5b `event-tracking`
- **Trigger / frequency:** repeatable cron, every 10 min (`8-59/10 * * * *`),
  bulk lane. The tick is not the cadence: each event carries its own
  `pollIntervalMinutes` (default 30) and a participant captured more recently
  than that is skipped, so the tick only decides how promptly an event whose
  interval has elapsed is picked up.
- **Inputs:** `Event` rows that are **LIVE** and have at least one entry in
  `trackedMetrics`; their **GOING** RSVPs, resolved through `LinkedAccount` to a
  verified Minecraft account.
- **Outputs:** an `EVENT_TRACKED` `ProfileSnapshot` per participant (carrying
  `eventId`), and an upserted `EventScore` per tracked metric.
- **Scope-limited by design.** Only live events, only tracked ones, only members
  who said they were coming, and only those with a linked account. An event
  nobody RSVP'd to costs nothing; the unlinked are absent rather than scored
  zero, and the panel shows them as an unlinked warning list.
- **The baseline is written once.** The first poll after an event goes LIVE
  records where a member started; every later poll updates `current` and
  `delta`. Nothing moves a baseline afterwards — doing so would silently reset
  everyone's score mid-event.
- **Idempotency:** `EventScore` is keyed `(eventId, uuid, metric)`, so a repeated
  pass rewrites the same row with the same numbers. Snapshots take a per-capture
  `seq`, so several captures in one day do not collide with the daily upsert.
- **A null reading is not a zero.** A metric the profile did not report is
  skipped, leaving the last good score standing rather than dropping the member
  to the bottom of the board over one bad fetch.
- **Retry:** 1 retry, global lock, 10 min TTL. The next pass is minutes away, so
  a failure costs a data point rather than a score.
- **Failure impact:** the board's "last updated" stamp ages. Scores already
  recorded are unaffected, and nothing has to be recomputed to recover.
- **No teardown to forget.** There is no per-event job to remove when an event
  ends: the pass reads current truth, so an event leaving LIVE simply stops
  appearing in the work list.

### 2.6 `milestone-detect`
- **Trigger / frequency:** event-driven immediately after a snapshot (per member).
- **Inputs:** newest `ProfileSnapshot` vs prior; threshold rules.
- **Outputs:** `Milestone` rows; publishes announce event for the Bridge bot.
- **Idempotency:** `Milestone` unique constraint on `(account, type, threshold)` + `announced` flag prevents duplicate detection/announcement.
- **Retry:** backoff; dedup on unique so replay is safe.
- **Failure impact:** a milestone announcement is missed or late — never double-announced.

### 2.6b `milestone-backfill`
- **Trigger / frequency:** scheduled daily (`41 4 * * *`), and runnable by hand from Health.
- **Inputs:** every tracked account's newest `ProfileSnapshot`, and the definitions in force for its guild.
- **Outputs:** `Milestone` rows for **standings** — everything the account is already past — rather than for crossings.
- **Why it exists.** `milestone-detect` compares two snapshots, so it only ever fires on the moment somebody crosses a line. A definition added today would therefore never fire for the members who passed it last year, and on a fresh install every member starts with nothing. This pass closes that gap within a day.
- **Rows are written pre-announced and award no XP.** A backfill that announced would spend a night posting a guild's entire history into a channel, and one that paid would hand out months of XP overnight. What it produces is a record, not an event.
- **Idempotency:** the same `Milestone` unique constraint. A re-run reports zero written, which is what makes a nightly cadence safe.
- **Retry:** none (`maxRetries: 0`), global lock, 30 min TTL. There is nothing time-sensitive here; tomorrow's run is the retry.
- **Failure impact:** newly added definitions stay unreflected for another day. Nothing already recorded is affected.

### 2.7 `reminder-dispatch`
- **Trigger / frequency:** **delayed jobs** enqueued when an event is created, firing at configured offsets (e.g. 24h/1h before `Event.startsAt`).
- **Inputs:** `Event`, `EventRSVP` (GOING/MAYBE), reminder config.
- **Outputs:** an `event-reminder` message on `chan:bridge:{guildId}`, which the
  bridge bot delivers into the guild's **`events`** channel
  (`apps/bridge-bot/src/events.ts`), pinging only the members who RSVP'd;
  updates `reminderState`.
- **Delivery is fire-and-forget.** Redis pub/sub drops a message published
  while no bridge is connected, and that is the intended trade: a "starts in
  15 minutes" notice delivered an hour late is worse than one never sent. The
  offset is only marked sent once the publish resolves.
- **Idempotency:** each reminder marks itself sent; a re-fire checks state and no-ops if already dispatched.
- **Retry:** backoff; if the event was cancelled/rescheduled, the job re-validates against current truth before sending.
- **Failure impact:** a reminder is late or missed; the event itself is unaffected.

### 2.7d `role-sync`
- **Trigger / frequency:** cron, every fifteen minutes (`11-59/15 * * * *`),
  **bulk** lane. Offset from the roster jobs, whose writes are what usually make
  a member dirty.
- **Inputs:** the guild's `roles.auto` policy, the dirty set
  `roles:dirty:<guildId>`, and one facts bundle per member (guild membership and
  rank, verified link, XP level, achievement keys, attendance count).
- **Outputs:** one `POST /internal/g/<guildId>/roles` per member with work to do,
  and `RoleGrant` rows recording what landed.
- **Reconciliation, not event handling.** Nothing here reacts to an event. It
  asks what should be true for one member, compares it to what is true, and
  fixes the difference. That is what makes a gateway event dropped during a
  deploy heal itself, a rule written today apply to members who qualified last
  year, and a role somebody removed by hand come back.
- **The dirty set is promptness, not correctness.** Link, unlink, a rank change,
  an achievement and a completed event all mark members dirty. Losing those
  marks — a Redis flush, a crash between the write and the mark — costs latency
  only: a **daily full sweep** per guild marks everybody, and that sweep is the
  floor under the whole design. It is claimed with `SET NX EX 86400` on
  `roles:sweep:<guildId>` so two workers produce one sweep rather than two.
- **Two paths, one reconcile.** Marking a member also publishes a nudge on
  `chan:role-nudge`, which this process subscribes to and answers by reconciling
  that one member immediately — usually within a second of the link, join, rank
  change or milestone that caused it. It runs `syncOneMember`, the same function
  the sweep runs per member: same policy, same ledger, same effector, same
  attribution. Two copies of that logic would be two ways for a role to be
  granted and only one of them audited the way this page claims.

  The immediate path **never touches the dirty set**. The mark stays where the
  publisher put it, so anything the nudge loses — a message published while the
  workers were restarting, a backlog that filled, a reconcile that failed — is
  picked up by the next fifteen-minute pass. That is why the sweep is not going
  anywhere and must not be turned into a pure event listener: it is the reason
  revocation is safe (the grant ledger only has meaning if something eventually
  reconciles every member), and it is the only thing that heals a dropped event.

  The second pass is a no-op, not a duplicate. Once the roster mirror reflects
  the applied role, the sweep's diff is empty and no Discord call is made at
  all; while the mirror is still behind, it re-asserts the same role and records
  no second grant, because the ledger already accounts for it.
- **Nudges are paced per guild.** Discord's role bucket is roughly ten
  modifications per ten seconds per guild and one member can cost two — an add
  and a remove. A small token bucket in front of the immediate path (one member
  at a time, one every 2.5s, `packages/jobs/src/role-nudge.ts`) keeps a burst of
  twenty simultaneous links inside that, at the cost of spreading them over the
  following minute. Past 50 waiting members per guild nudges are refused with a
  `role nudge dropped` warning: at that size the immediate path has nothing to
  offer over the sweep, and everyone refused is still marked dirty. A mark
  covering more than 25 members at once — a roster-wide rescan — is not nudged
  at all, for the same reason.
- **A pass acts on at most 200 members per guild.** The remainder stays in the
  dirty set for the next pass, which bounds both Discord writes and how long one
  guild can hold the bulk lane.
- **Never revokes what it did not grant.** A removal requires an open `RoleGrant`
  row for that member, role *and rule*. A role given by hand, by another bot, or
  by a rule that has since been deleted is left alone. `MANUAL` rules are never
  auto-revoked at all.
- **Claims only what Discord confirmed.** Asking for three roles and getting two
  is ordinary — one may have been deleted or moved above the bot since the rule
  was written. Only `added` is recorded; a failed call claims nothing and puts
  the member back in the dirty set, because a ledger row for a grant that never
  happened would authorise a later revoke of a role we never gave.
- **XP level changes have no dirty mark of their own.** Awards happen on several
  paths, and the daily sweep is what makes `XP_LEVEL` rules land — up to a day
  late. Milestone rewards are the exception: they mark, because the milestone
  itself does.
- **XP aggregation stays batched, deliberately.** See §2.10b. It is tempting to
  make an award mark the member dirty so `XP_LEVEL` rules land at once, and it
  is the wrong trade: XP is awarded per message, so that mark would fire on
  every chat line in the server and every one of them would nudge. The per-guild
  role bucket is about ten modifications per ten seconds, shared with moderation
  and role menus, and a busy evening would spend all of it discovering that
  nobody crossed a level boundary. The daily re-derive is what makes `XP_LEVEL`
  correct; a level-up that matters enough to reward promptly is a milestone, and
  milestones do mark and nudge.

### 2.7c `event-board`
- **Trigger / frequency:** cron, every thirty minutes (`13,43 * * * *`), **timely** lane.
- **Inputs:** `Event` rows that are LIVE and whose `boardUpdatedAt` is older than
  `BOARD_REFRESH_MS` (30 min), plus COMPLETED/CANCELLED events that have a
  `messageId` and `boardFinal = false` — the result card nobody has written yet.
- **Outputs:** one `POST /internal/g/<guildId>/event-board` per due event; the
  bridge bot renders the board and edits its message, then records
  `channelId` / `messageId` / `boardUpdatedAt` / `boardFinal`.
- **Where the work happens:** the same division of labour as `ticket-sweep`
  (§2.9c). This process knows which boards are stale; the **bridge bot** is the
  only one with a gateway to the community server, so the render, the post and
  the edit all live in `apps/bridge-bot/src/event-board.ts`.
- **One message, edited in place.** A half-hourly re-post would leave a channel
  of dead leaderboards, each of them wrong. When the remembered message has been
  deleted the edit fails, the id is cleared and a fresh board is posted, so
  "somebody tidied the channel" self-heals.
- **The result card.** A finished event's board is edited one final time and
  left in the channel rather than deleted, so the channel keeps the history.
  `boardFinal` is what makes that once rather than forever — without it a
  completed event is indistinguishable from one merely overdue.
- **Channel choice:** the event's stored `channelId` wins over the guild's
  `events` slot. A slot rebound mid-event would otherwise orphan a board nobody
  can update.
- **Mentions:** the standings are a column of `<@id>` and none of them pings.
  The board is redrawn every half hour and would otherwise notify the top ten
  each time.
- **Idempotency:** a re-run edits the same message to the same content.
- **Retry:** 1 retry; a global lock stops two workers redrawing at once.
- **Failure impact:** a board shows numbers up to a cadence old. The scores
  themselves are `event-tracking`'s (§2.5b) and are unaffected.

### 2.7d `leaderboard-post`
- **Trigger / frequency:** cron, weekly — Sunday 18:23 (`23 18 * * 0`), **timely** lane.
- **Inputs:** every ACTIVE `Guild`. No filtering happens here on purpose: the
  bridge refuses guilds with no `leaderboard` channel bound, and filtering on
  this side would mean two processes holding an opinion about what "configured"
  means.
- **Outputs:** one `POST /internal/g/<guildId>/leaderboard-post` per guild. The
  bridge reads four boards (Level, Wealth, Catacombs, Guild XP), top ten each,
  and posts them into the `leaderboard` channel.
- **Where the work happens:** the same division of labour as `event-board`
  (§2.7c). The render and the post live in
  `apps/bridge-bot/src/leaderboard-digest.ts`.
- **Posted, never edited — the opposite of §2.7c, deliberately.** A tracker
  board is one event's live state, so a second copy of it is a wrong copy. A
  digest is a record of where the guild stood on one particular Sunday, and
  editing last week's message would destroy the only reason to keep it.
- **Weekly, not daily.** A digest is interesting when something moved between
  two of them, and a member's SkyBlock Level does not move enough in a day.
- **Empty boards are omitted**, and a guild with nobody ranked on any of the
  four posts nothing at all. "Here are the top ten" over a blank table reads as
  a broken bot rather than as a young guild.
- **Mentions:** rows are IGNs and `<@id>`, and none of them pings. Notifying the
  top ten of four boards every Sunday is how a digest channel becomes a muted
  one.
- **Idempotency: none, and that is the point.** A re-run posts a second digest.
  The weekly cadence plus a global lock is what keeps that from happening;
  "Run now" from the panel will genuinely post another one.
- **Retry: 0.** A digest that failed is a week old before anybody notices, and
  posting it late is worse than not posting it.
- **Failure impact:** a guild misses one week's digest. Nothing else reads what
  this writes — the boards themselves are live on `/leaderboard` and the panel.

### 2.8 `event-transition`
- **Trigger / frequency:** repeatable sweep every 1–5 min, plus delayed jobs pinned to start/end boundaries.
- **Inputs:** `Event.startsAt/endsAt/status`.
- **Outputs:** state changes SCHEDULED→LIVE→COMPLETED (or CANCELLED honored); triggers attendance window open/close.
- **Idempotency:** only performs *valid* transitions from current state; re-running is a no-op if already transitioned.
- **Retry:** re-evaluate from DB truth (not from prior job state).
- **Failure impact:** an event's status label lags reality briefly; recovered on next sweep.

### 2.9 `inactivity-scan`
- **Trigger / frequency:** daily or weekly cron.
- **Inputs:** `GuildMember.lastSeen`, command/relay activity, latest snapshots, guild-configured inactivity thresholds.
- **Outputs:** inactivity report / flags to the panel (and optional staff notification) — **flags, does not auto-kick**.
- **Idempotency:** deterministic over the current state; a re-run reproduces the same flags.
- **Retry:** backoff; recompute.
- **Failure impact:** inactivity report delayed; no state mutated, so safe.
- **Safety note:** deliberately advisory — automated removal is a staff decision, not a worker's, matching the Admin bot's "fail-safe" stance.

### 2.9b `punishment-expiry` — moved to the admin bot
This job no longer runs in the workers process, and is no longer schedulable or
manually runnable here. It lives on the admin bot's own five-minute loop
(`apps/admin-bot/src/punishment-sweep.ts`), next to `safety-sweep`.

The reason is the bug it was hiding. The description that used to sit here said
the job "does not lift anything" because enforcement expires on Discord's own
clock and on the Redis mirror's TTL. That is true of a **timeout** and false of
everything else: a Discord *ban* never expires, and neither does the Hypixel
guild mute we asked for with `/g mute`. So a seven-day ban became a permanent
one, while this job dutifully cleared the row that said it was still in force —
removing the only remaining evidence that anybody was owed a reversal.

It now reverses first (a real audited `UNBAN`/`UNMUTE` through the moderation
service, enforced on Discord and relayed to guild chat) and clears the flag
second. Reversal needs the gateway, which is why the admin bot is the only place
it can run — and why it must not *also* run here, where a concurrent sweep would
clear the flags identifying the rows still owed a reversal.

### 2.9c `ticket-sweep`
- **Trigger / frequency:** cron, every six minutes (`5-59/6 * * * *`), **timely** lane.
- **Inputs:** every active guild's `OPEN`/`PENDING` tickets, plus a per-ticket "already warned" flag held in Redis.
- **Outputs:** a one-time "still need this?" post in the ticket channel, or an automatic close — transcript delivered, log posted, channel disposed of.
- **Where the work happens:** the decision is `sweep()` in `@sbr/tickets` and it runs in the **bridge bot**, which is the process holding a gateway to the community server. This job walks the guilds, remembers what has been warned, and calls `POST /internal/g/<guildId>/ticket-sweep` once per ticket. It runs here rather than on a timer inside that bot because the lock, the retry policy and the run log live in workers — a bot sweeping on its own `setInterval` sweeps twice the moment a second replica starts.
- **Why Redis and not a column:** "has been warned" is a fact about a notification, not about a ticket. Its worst failure — a warning repeated after a restart — is far milder than a schema migration for a boolean that expires on its own. The TTL is 24 h, longer than any sensible auto-close window, so a ticket that goes quiet, resumes, and goes quiet again the next day is warned again rather than silently skipped.
- **Idempotency:** a warned ticket answers `NONE` on the next pass; closing an already-closed ticket is refused by the lifecycle rules. Nothing is written twice.
- **Retry:** 2 attempts; each ticket is decided independently, so a re-run simply re-examines what the failed pass did not reach.
- **Failure impact:** with the bridge bot down, every call returns null and nothing is recorded — the pass is a no-op and the next one picks the same tickets up. Warnings and closes are late; none are lost.

### 2.10 `analytics-ingest` + `analytics-rollup`
- **Trigger / frequency:** ingest = continuous stream consumer; rollups = hourly / daily (~00:15 guild-local, staggered) / weekly.
- **Inputs:** `buf:analytics` Redis Stream (ingest); `AnalyticsEvent` raw facts (rollup).
- **Outputs:** `AnalyticsEvent` (raw), then `MetricHourly/Daily/Weekly` aggregates.
- **Idempotency:** ingest dedups by event id + consumer-group offsets; rollups are **rebuildable per `(guildId, metric, period)`** — delete partition + re-run reconstructs from raw.
- **Retry:** ingest reclaims pending stream entries; rollups recompute the whole period (never incremental-partial).
- **Failure impact:** analytics/charts lag by a period; no impact on live operation. (See `ANALYTICS.md`.)

### 2.10b `xp-aggregate`
- **Trigger / frequency:** repeatable cron `48 */3 * * *` — every three hours, 48 past the hour to keep clear of the roster and snapshot passes.
- **Inputs:** `ActivityDaily` counters, `GuildGexpDaily`, `GuildMember` join dates, and the guild's `XpSourceConfig` rows.
- **Outputs:** derived `XpEvent` rows, then a full rebuild of every `XpBalance` for the guild.
- **Idempotency:** every derived award carries a `dedupeKey` and is **upserted**, not skipped. A day still in progress therefore *converges* — the next pass overwrites this morning's partial figure rather than adding to it — and a retry cannot double-credit.
- **Window:** each run re-derives **yesterday and today**, for the same reason the analytics rollup recomputes its previous partition: today's counters are still climbing, and yesterday can still gain a late GEXP row from a scan that straddled midnight.
- **Retry:** 1 retry, and a 10-minute global lock. The lock matters more than the retry: two overlapping runs would each rebuild balances from a ledger the other was still writing, and the loser's totals would win.
- **Isolation:** one guild's failure is logged and skipped, never fatal to the pass — its counters are still sitting in the database for the next run to re-derive.
- **Why not nightly:** a member who asks for their standing should not be told about the person they were yesterday. Not more often than three-hourly either, because each run rebuilds balances by reading a guild's whole ledger, and there is no member-visible difference between "an hour stale" and "three hours stale".
- **Failure impact:** standings and the leaderboard lag; the ledger and the counters are untouched, so nothing needs repairing beyond the next successful run.
- **Anti-abuse split:** daily caps are applied *here*, at aggregation; message length and per-user cooldowns are applied at capture, on the hot path. See `DOMAIN_MODEL.md` → `ActivityDaily` for why the two limits cannot live in the same place.

### 2.11 `config-cache-invalidation`
- **Trigger / frequency:** event-driven on any config/permission/wordlist write; plus a reconcile cron every 5–10 min as a safety net.
- **Inputs:** changed `GuildConfig`/`BridgePermission`/`WordlistEntry` (with version stamp).
- **Outputs:** invalidated/refreshed `cfg:*`/`perm:*`/`wordlist:*` keys; publishes `chan:config:{guildId}` so bots reload.
- **Idempotency:** keys are **version-stamped**; a stale invalidation for an older version is ignored (last-writer-wins).
- **Retry:** backoff; the periodic reconcile pass repairs any missed invalidation (self-healing).
- **Failure impact:** bots may read stale config for up to the reconcile interval — bounded, not indefinite.

### 2.14 `guild-scan`
- **Trigger / frequency:** repeatable cron `26 1,7,13,19 * * *` — every 6 h, offset from midnight so a scan lands shortly *before* the cache TTL expires rather than alongside every other daily job.
- **Inputs:** Hypixel `guild` by id, per configured guild; Mojang session server for reverse uuid→name lookups.
- **Outputs:** `GuildMemberCache` (full roster incl. unlinked members), `GuildGexpDaily` (one row per member per day), `GuildScan` (audit row).
- **Idempotency:** members upsert on `(guildId,uuid)`; GEXP upserts on `(guildId,uuid,day)` with `gexp = EXCLUDED.gexp`. Today's value is still climbing, so the write is an **overwrite, never a sum** — a day scanned four times converges instead of quadrupling.
- **Partial-failure rule:** a failed or throwing roster fetch writes **nothing** and removes **nobody**; it records a `GuildScan` row with the error and returns `skipped: "fetch-failed"`. A partial roster is a lie rather than a subset — treating one bad response as truth would evict the whole guild from the cache and read as ~125 people leaving.
- **Mojang budget:** the guild endpoint returns uuids only. Names are resolved for cache rows that have none, capped per run (default 20) with joiners prioritised, and written with `COALESCE` so a skipped or failed lookup never nulls out a name already known. A cold start therefore fills in names over a few scans, which nobody notices.
- **Retry:** one retry; global lock `lock:job:guild-scan`, 10 min TTL. One unreachable guild does not abort the others in the same run.
- **Failure impact:** the member cache ages past its 6 h freshness window and commands warn rather than fail. The real cost is GEXP: Hypixel's `expHistory` window is only ~7 days wide, so a gap longer than that is permanently unrecoverable.
- **Distinct from `guild-roster-sync`,** which reconciles Discord-keyed platform membership and drives roles and access. This job caches the in-game guild as it actually is.

### 2.15 `discord-member-sync`
- **Trigger / frequency:** repeatable cron `19 1,3,5,7,9,11,13,15,17,19,21,23 * * *` — every 2 h on odd hours. The odd hours and the :19 keep it clear of `guild-scan` (:26 on even-ish hours) and `guild-roster-sync` (:09/:39): three jobs that each walk every guild, deliberately never at once.
- **Inputs:** the admin bot's loopback internal API, `GET /internal/g/{id}/members?all=1`. The `all=1` is not optional — the picker endpoint caps at 200 rows, and a sync that inherited that cap would record every member past the 200th as having left the server.
- **Outputs:** `DiscordUser` (username, globalName, avatarHash) and `GuildMember` (nickname, joinedAt, status).
- **Idempotency:** two multi-row `ON CONFLICT` upserts per 100-row chunk, on `("discordId")` and `("guildId","discordUserId")`. `joinedAt` is written with `COALESCE(EXCLUDED, existing)` so a response without it never erases one we already had. `GuildMember.role` is deliberately **not** written: it is the platform role staff set on the Members page, and a roster scan has no business resetting somebody to MEMBER.
- **Partial-failure rule:** an unreachable bot returns `null`, distinct from an empty roster, and the job returns `skipped: "unreachable"` having written nothing. Conflating the two would mark the entire server as departed.
- **Departures** set `status = LEFT` and `leftAt`; rows are never deleted, because moderation history and XP ledgers point at them and a rejoin should find its own past.
- **Bots are excluded** from the mirror. Every consumer of these rows — the directory, link coverage, activity — is about people. Bots remain visible in the ID pickers, which read the gateway cache directly rather than this table.
- **Requires the Server Members privileged intent** (see ADMIN_BOT.md §7b). Without it the endpoint returns an empty-looking cache, which is why "unreachable" and "empty" are kept distinct at every layer.
- **Failure impact:** the Members page's Discord column ages. It shows its own `Scanned …` clock rather than presenting a stale count as current.

---

## 3. Scheduling & Coordination

- **Two trigger styles:** *repeatable cron* (bazaar, ah, snapshots, rollups, scans, roster) and *delayed/event-driven* (reminders, event transitions, milestone detect, pricing recompute, cache invalidation). Event-driven jobs are enqueued by the action that necessitates them; cron jobs self-schedule.
- **Staggering:** periodic jobs fire on **off-minutes** (never :00/:30) and daily jobs use guild-local boundaries, avoiding thundering-herd on both our DB and the Hypixel API.
- **Priority lanes:** live-serving refreshes (bazaar, pricing) run at higher queue priority than bulk/backfill (snapshots, scans) so user-facing freshness wins contention.
- **Reserved rate budget:** Hypixel-touching jobs share `rl:hypixel` with a capped worker fraction; live commands always out-prioritize workers for a token.
- **A third trigger style: by hand, from the panel.** The Health page (WEB_PANEL.md §3.11) publishes `{jobName, guildId, actorDiscordId}` on `chan:jobs`; `main.ts` subscribes and calls `queue.add`. The panel deliberately does not enqueue — BullMQ stays out of that process and this stays the only writer to the queue. A hand-started job is added **at its scheduled lane priority**, not ahead of it, so an operator pressing a button cannot push live-serving work behind a bulk sweep. Names are gated by `RUNNABLE_JOBS` (`@sbr/redis`) on both sides; `heartbeat` and `analytics-ingest` are excluded as continuous plumbing, and a schedule test asserts every runnable name exists in `SCHEDULE`. A request for a name this build does not define is dropped with a warning line — it means the panel is ahead of the fleet, which an operator watching a button do nothing deserves to be able to find.
- **Scaling:** workers scale horizontally by queue depth; locks + idempotency make multiple replicas safe. Singleton-per-scope jobs (roster per guild) lock by scope.

---

## 4. Failure, Idempotency & Recovery Model

- **Everything is idempotent by construction:** overwrites (bazaar/resources/pricing), shadow-swap (ah), upsert-by-key (snapshots), unique-guard (milestones), sent-flags (reminders), valid-transition guards (events), rebuildable partitions (rollups), version-stamped keys (cache). A retried or duplicated run never corrupts state.
- **Transient vs permanent:** transient (5xx/timeout/`RATE_LIMITED`) → backoff+jitter, capped attempts; permanent (bad input/4xx auth) → **dead-letter queue** + staff alert, no blind retry.
- **Degrade, don't fail:** a missed refresh serves last-known-good tagged `STALE`; consumers show "as of Xm ago" rather than erroring.
- **Self-healing:** reconcile passes (cache invalidation, analytics counters, roster diff) repair drift from missed events without manual intervention.
- **Observability:** `WorkerJobLog` + BullMQ live state feed the panel Health page (queue depth, failed/**stale jobs**, last run/duration, failure rate); operators can force-run any scheduled job from there (§3 above); requeueing one specific failed job is not wired yet.
- **Blast-radius:** a crash in one processor doesn't stop others; jobs are isolated per-queue, and poison messages dead-letter rather than loop.

---

## 5. Summary

- **BullMQ-on-Redis workers** own all periodic/global/paginated work; bots and panel stay on the fast path.
- **Each job defines trigger, frequency, inputs, outputs, idempotency, retry, logging, and failure impact** (job table §1 + specs §2).
- **The AH sweep never runs in a handler** — shadow-build + atomic promote keeps live commands cache-only.
- **Idempotency is structural** (overwrite / shadow-swap / upsert / unique-guard / sent-flag / valid-transition / rebuildable / version-stamped), so retries and multi-replica scaling are safe.
- **Failure degrades to `STALE`, not outage**, with self-healing reconcile passes and full Health-page observability.

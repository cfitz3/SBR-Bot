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
| `profile-snapshot` | Repeatable + on-demand | tracked members ~6–12 h, spread; **event-tracked cohort sub-hourly** (see §2.5) | Upsert by `(uuid,profileId,captureDate[,seq])` | Backoff; per-member requeue | Progression/milestones lag; **event leaderboards go stale** |
| `milestone-detect` | Event (after snapshot) | per snapshot | Guard by `Milestone` unique + `announced` flag | Backoff; dedup on unique | Missed/late announcements only |
| `reminder-dispatch` | Scheduled (delayed jobs) | at offsets before events | Mark reminder sent (`reminderState`) | Backoff; skip if already sent | Missed/late reminder pings |
| `event-transition` | Repeatable + delayed | every 1–5 min / at boundaries | Idempotent state guard (only valid transitions) | Backoff; re-evaluate from truth | Event status lags (SCHEDULED→LIVE→COMPLETED) |
| `inactivity-scan` | Repeatable (cron) | daily/weekly | Deterministic over snapshot; flag not act | Backoff; recompute | Inactivity report delayed |
| `punishment-expiry` | Repeatable (cron) | every 5 min (`3-59/5 * * * *`) | `updateMany` over rows already past `expiresAt`; a second pass matches nothing | 3 retries; global lock, 60 s TTL | Ended mutes/bans keep reading as "in force" to staff until the next pass |
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
- **Failure impact:** low/short — `/bazaar`, `/price` serve last snapshot tagged `STALE`.

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

### 2.5 `profile-snapshot`
- **Trigger / frequency:** repeatable (tracked members every ~6–12 h, spread across the window) + on-demand backfill.
- **Inputs:** tracked `MinecraftAccount`/`SelectedSkyblockProfile`, Hypixel profile (+museum) via the client.
- **Outputs:** `ProfileSnapshot` rows (append-only time-series) in Postgres; warms profile cache.
- **Idempotency:** upsert keyed by `(uuid, profileId, captureDate)` so a re-run for the same window doesn't duplicate.
- **Retry:** per-member requeue with backoff; rate-budget-aware low-priority queue so it never beats live commands to a token.
- **Logging:** members processed, skipped (API disabled/rate), snapshots written.
- **Failure impact:** progression (`/progress`, `/whatnext`) and milestone detection lag; no user-facing error.
- **Event-tracking exception (progression events / leaderboards):** during a running progression event, an **opt-in cohort** (a subset of the ~125-member guild — never all of them) is snapshotted at a **sub-hourly** cadence (e.g. every 5–15 min, configurable per event) so live leaderboards stay fresh. Specifics:
  - **Scope-limited by design.** The high-frequency cadence applies **only** to the event's registered participant cohort for the event's active window; everyone else stays on the normal ~6–12 h schedule. This keeps the extra Hypixel spend bounded (cohort size × interval), not fleet-wide.
  - **Separate lane:** runs as a distinct repeatable job (`profile-snapshot:event:{eventId}`) with its own lock and a **higher priority** than bulk snapshots, but still under the reserved worker rate fraction so it can't starve live commands.
  - **Idempotency:** upsert key gains a fine-grained component (`captureAt`/`seq`) so multiple same-day captures don't collide with the daily upsert; leaderboard reads use the latest snapshot per member.
  - **Auto start/stop:** the cadence is enabled when the event enters its tracking window and **torn down** (job removed) when the event ends or is cancelled, so we never leave a sub-hourly loop running after the event — tied to `event-transition` (§2.8).
  - **Rate-budget guardrail:** if the cohort × interval would exceed the worker rate fraction, the job widens the interval (and logs it) rather than eating into live-command budget; leaderboard freshness degrades gracefully instead of throttling users.

### 2.6 `milestone-detect`
- **Trigger / frequency:** event-driven immediately after a snapshot (per member).
- **Inputs:** newest `ProfileSnapshot` vs prior; threshold rules.
- **Outputs:** `Milestone` rows; publishes announce event for the Bridge bot.
- **Idempotency:** `Milestone` unique constraint on `(account, type, threshold)` + `announced` flag prevents duplicate detection/announcement.
- **Retry:** backoff; dedup on unique so replay is safe.
- **Failure impact:** a milestone announcement is missed or late — never double-announced.

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

### 2.9b `punishment-expiry`
- **Trigger / frequency:** cron, every five minutes (`3-59/5 * * * *`), **timely** lane.
- **Inputs:** `ModerationAction` rows that are `active`, of type `MUTE` or `BAN`, and whose `expiresAt` is in the past.
- **Outputs:** those rows cleared to `active: false`.
- **What it does not do:** it does not lift anything. The enforcement itself expires on Discord's own clock (a timeout ends when it ends) and on the Redis mirror's TTL; this job clears the *record*, so that what staff read matches what is actually being enforced. That is also why it lives in workers rather than the Admin bot — unlike `safety-sweep`, it never needs the gateway.
- **Scope:** only `MUTE` and `BAN`. A `KICK` row stays flagged active forever because nothing lifts one, and clearing it would rewrite history to say somebody did.
- **Idempotency:** the `WHERE` clause excludes everything it has already written, so a re-run is a no-op.
- **Retry:** backoff, 3 attempts; a global lock stops two workers sweeping at once.
- **Failure impact:** the `/audit in_force` list and the panel's "In force now" card over-report for up to one cadence — staff may believe a member is still muted after the mute ended.
- **Timely, not bulk:** what it clears is what staff read to decide whether somebody is *already* being punished, and five minutes of "still muted" after a mute ended is a wrong answer to a question people act on.

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

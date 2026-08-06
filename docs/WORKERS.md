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
| `analytics-ingest` | Continuous (stream consumer) | continuous | Dedup by event id; consumer-group offset | Reclaim pending; replay | Analytics ingestion backlog |
| `analytics-rollup` | Repeatable (hourly/daily/weekly) | hourly / ~00:15 local / weekly | Rebuildable per `(guildId,metric,period)` | Backoff; recompute partition | Charts stale for a period |
| `config-cache-invalidation` | Event (on write) + reconcile cron | on config change / 5–10 min | Version-stamped keys; last-writer-wins | Backoff; reconcile pass | Bots read stale config until reconcile |
| `guild-roster-sync` | Repeatable | 5–15 min | Diff-based reconcile to DB | Backoff; per-guild lock | Roster/rank drift until next run |

*(guild-roster-sync included as the membership counterpart to the required set.)*

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
- **Outputs:** reminder pings via the Bridge bot; updates `reminderState`.
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

### 2.10 `analytics-ingest` + `analytics-rollup`
- **Trigger / frequency:** ingest = continuous stream consumer; rollups = hourly / daily (~00:15 guild-local, staggered) / weekly.
- **Inputs:** `buf:analytics` Redis Stream (ingest); `AnalyticsEvent` raw facts (rollup).
- **Outputs:** `AnalyticsEvent` (raw), then `MetricHourly/Daily/Weekly` aggregates.
- **Idempotency:** ingest dedups by event id + consumer-group offsets; rollups are **rebuildable per `(guildId, metric, period)`** — delete partition + re-run reconstructs from raw.
- **Retry:** ingest reclaims pending stream entries; rollups recompute the whole period (never incremental-partial).
- **Failure impact:** analytics/charts lag by a period; no impact on live operation. (See `ANALYTICS.md`.)

### 2.11 `config-cache-invalidation`
- **Trigger / frequency:** event-driven on any config/permission/wordlist write; plus a reconcile cron every 5–10 min as a safety net.
- **Inputs:** changed `GuildConfig`/`BridgePermission`/`WordlistEntry` (with version stamp).
- **Outputs:** invalidated/refreshed `cfg:*`/`perm:*`/`wordlist:*` keys; publishes `chan:config:{guildId}` so bots reload.
- **Idempotency:** keys are **version-stamped**; a stale invalidation for an older version is ignored (last-writer-wins).
- **Retry:** backoff; the periodic reconcile pass repairs any missed invalidation (self-healing).
- **Failure impact:** bots may read stale config for up to the reconcile interval — bounded, not indefinite.

---

## 3. Scheduling & Coordination

- **Two trigger styles:** *repeatable cron* (bazaar, ah, snapshots, rollups, scans, roster) and *delayed/event-driven* (reminders, event transitions, milestone detect, pricing recompute, cache invalidation). Event-driven jobs are enqueued by the action that necessitates them; cron jobs self-schedule.
- **Staggering:** periodic jobs fire on **off-minutes** (never :00/:30) and daily jobs use guild-local boundaries, avoiding thundering-herd on both our DB and the Hypixel API.
- **Priority lanes:** live-serving refreshes (bazaar, pricing) run at higher queue priority than bulk/backfill (snapshots, scans) so user-facing freshness wins contention.
- **Reserved rate budget:** Hypixel-touching jobs share `rl:hypixel` with a capped worker fraction; live commands always out-prioritize workers for a token.
- **Scaling:** workers scale horizontally by queue depth; locks + idempotency make multiple replicas safe. Singleton-per-scope jobs (roster per guild) lock by scope.

---

## 4. Failure, Idempotency & Recovery Model

- **Everything is idempotent by construction:** overwrites (bazaar/resources/pricing), shadow-swap (ah), upsert-by-key (snapshots), unique-guard (milestones), sent-flags (reminders), valid-transition guards (events), rebuildable partitions (rollups), version-stamped keys (cache). A retried or duplicated run never corrupts state.
- **Transient vs permanent:** transient (5xx/timeout/`RATE_LIMITED`) → backoff+jitter, capped attempts; permanent (bad input/4xx auth) → **dead-letter queue** + staff alert, no blind retry.
- **Degrade, don't fail:** a missed refresh serves last-known-good tagged `STALE`; consumers show "as of Xm ago" rather than erroring.
- **Self-healing:** reconcile passes (cache invalidation, analytics counters, roster diff) repair drift from missed events without manual intervention.
- **Observability:** `WorkerJobLog` + BullMQ live state feed the panel Health page (queue depth, failed/**stale jobs**, last run/duration, failure rate); operators can requeue/force-run from there.
- **Blast-radius:** a crash in one processor doesn't stop others; jobs are isolated per-queue, and poison messages dead-letter rather than loop.

---

## 5. Summary

- **BullMQ-on-Redis workers** own all periodic/global/paginated work; bots and panel stay on the fast path.
- **Each job defines trigger, frequency, inputs, outputs, idempotency, retry, logging, and failure impact** (job table §1 + specs §2).
- **The AH sweep never runs in a handler** — shadow-build + atomic promote keeps live commands cache-only.
- **Idempotency is structural** (overwrite / shadow-swap / upsert / unique-guard / sent-flag / valid-transition / rebuildable / version-stamped), so retries and multi-replica scaling are safe.
- **Failure degrades to `STALE`, not outage**, with self-healing reconcile passes and full Health-page observability.

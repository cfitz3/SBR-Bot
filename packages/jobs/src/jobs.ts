/**
 * Concrete job definitions (thin). The actual fetch/rollup work is injected so
 * these stay decoupled from the hypixel/redis/db wiring; the scheduler passes
 * each definition to the JobRunner.
 */
import type { JobDefinition } from "./runner.js";

/** bazaar-refresh: fetch quick-status and warm the price cache. Returns item count. */
export function defineBazaarRefreshJob(refresh: () => Promise<number>): JobDefinition<number> {
  return {
    name: "bazaar-refresh",
    queue: "pricing",
    lockKey: "lock:job:bazaar",
    lockTtlMs: 90_000,
    maxRetries: 2,
    handler: refresh,
  };
}

/**
 * ah-sweep: paginate the auction house and index lowest BIN per item.
 *
 * Long lock and no retries: a sweep takes minutes, and a second attempt on
 * failure would double the request cost for data the next scheduled run
 * refreshes anyway. Returns the number of items indexed.
 */
export function defineAuctionSweepJob(sweep: () => Promise<number>): JobDefinition<number> {
  return {
    name: "ah-sweep",
    queue: "pricing",
    lockKey: "lock:job:ah-sweep",
    lockTtlMs: 10 * 60_000,
    maxRetries: 0,
    handler: sweep,
  };
}

/**
 * safety-expiry: lift lockdowns and anti-raid postures whose `expiresAt` has
 * passed. This is what makes a time-boxed posture actually time-boxed — the
 * stored record deliberately outlives its expiry so the unlock knows which
 * channels to reopen, and nothing reopens them until this job runs.
 *
 * Retries generously and holds a short lock: leaving a server locked because
 * one sweep hit a transient Discord error is the failure worth avoiding.
 * Returns the number of postures lifted.
 */
export function defineSafetyExpiryJob(sweep: () => Promise<number>): JobDefinition<number> {
  return {
    name: "safety-expiry",
    queue: "safety",
    lockKey: "lock:job:safety-expiry",
    lockTtlMs: 60_000,
    maxRetries: 3,
    handler: sweep,
  };
}

/** analytics-rollup: aggregate the day's raw events into metric rows. Returns row count. */
export function defineAnalyticsRollupJob(rollup: () => Promise<number>): JobDefinition<number> {
  return {
    name: "analytics-rollup",
    queue: "analytics",
    lockKey: "lock:job:rollup:daily",
    lockTtlMs: 120_000,
    maxRetries: 1,
    handler: rollup,
  };
}

/**
 * xp-aggregate: weight a day's activity counters into ledger entries and
 * rebuild every balance from the ledger.
 *
 * Retries once and holds a long lock. Both follow from the job being
 * idempotent by construction — derived awards carry a dedupe key and the
 * repository upserts on it, so a retry converges on the same ledger rather than
 * double-crediting. The lock matters more than the retry does: two overlapping
 * runs would each rebuild balances from a ledger the other is still writing,
 * and the loser's totals would win.
 *
 * Returns the number of ledger rows written across every guild.
 */
export function defineXpAggregateJob(aggregate: () => Promise<number>): JobDefinition<number> {
  return {
    name: "xp-aggregate",
    queue: "progression",
    lockKey: "lock:job:xp-aggregate",
    lockTtlMs: 10 * 60_000,
    maxRetries: 1,
    handler: aggregate,
  };
}

/**
 * ah-ended-ingest: fold completed sales into per-item statistics.
 *
 * No retries. The endpoint is a rolling 60-minute window, so a retry two minutes
 * later re-reads almost the same sales — the cost is real and the new
 * information is nearly nil. The next scheduled run covers the gap.
 */
export function defineEndedAuctionJob(ingest: () => Promise<number>): JobDefinition<number> {
  return {
    name: "ah-ended-ingest",
    queue: "pricing",
    lockKey: "lock:job:ah-ended",
    lockTtlMs: 120_000,
    maxRetries: 0,
    handler: ingest,
  };
}

/** resources-refresh: reload slow-moving reference data (skills, collections, election). */
export function defineResourcesRefreshJob(refresh: () => Promise<number>): JobDefinition<number> {
  return {
    name: "resources-refresh",
    queue: "pricing",
    lockKey: "lock:job:resources",
    lockTtlMs: 120_000,
    maxRetries: 2,
    handler: refresh,
  };
}

/**
 * profile-snapshot: capture the time series behind `/progress` and the charts.
 *
 * The long lock reflects a batch of paced Hypixel calls; retries stay low
 * because the next run picks up exactly the accounts this one missed — the
 * oldest-first ordering makes the job self-healing without retry logic.
 */
export function defineProfileSnapshotJob(snapshot: () => Promise<number>): JobDefinition<number> {
  return {
    name: "profile-snapshot",
    queue: "progression",
    lockKey: "lock:job:snapshot",
    lockTtlMs: 15 * 60_000,
    maxRetries: 1,
    handler: snapshot,
  };
}

/** milestone-detect: turn consecutive snapshots into announceable achievements. */
export function defineMilestoneDetectJob(detect: () => Promise<number>): JobDefinition<number> {
  return {
    name: "milestone-detect",
    queue: "progression",
    lockKey: "lock:job:milestones",
    lockTtlMs: 5 * 60_000,
    maxRetries: 2,
    handler: detect,
  };
}

/**
 * event-transition: move events through SCHEDULED → LIVE → COMPLETED.
 *
 * Short lock, generous retries: it is cheap, purely database-local, and an event
 * showing the wrong status is visible to everyone in `/events`.
 */
export function defineEventTransitionJob(sweep: () => Promise<number>): JobDefinition<number> {
  return {
    name: "event-transition",
    queue: "community",
    lockKey: "lock:job:event-transition",
    lockTtlMs: 60_000,
    maxRetries: 3,
    handler: sweep,
  };
}

/**
 * reminder-dispatch: ping attendees ahead of an event.
 *
 * Retries are safe because `reminderState` is only marked after a successful
 * send, and a reminder past its grace window is dropped rather than delivered
 * late.
 */
export function defineReminderDispatchJob(sweep: () => Promise<number>): JobDefinition<number> {
  return {
    name: "reminder-dispatch",
    queue: "community",
    lockKey: "lock:job:reminders",
    lockTtlMs: 120_000,
    maxRetries: 3,
    handler: sweep,
  };
}

/**
 * event-tracking: poll the participants of a live event and score them.
 *
 * `progression` rather than `community` because what it actually spends is the
 * Hypixel budget, and that queue is where the fleet's other profile fetches
 * queue up behind each other. One retry: the next pass is minutes away, and a
 * failed poll costs a data point rather than a score.
 */
export function defineEventTrackingJob(track: () => Promise<number>): JobDefinition<number> {
  return {
    name: "event-tracking",
    queue: "progression",
    lockKey: "lock:job:event-tracking",
    lockTtlMs: 10 * 60_000,
    maxRetries: 1,
    handler: track,
  };
}

/**
 * event-board: redraw the tracker board of every live event.
 *
 * `community`, not `progression`: every unit of work here is a Discord edit
 * over the bridge's loopback API, and none of it touches the Hypixel budget the
 * progression queue exists to pace.
 */
export function defineEventBoardJob(publish: () => Promise<number>): JobDefinition<number> {
  return {
    name: "event-board",
    queue: "community",
    lockKey: "lock:job:event-board",
    lockTtlMs: 5 * 60_000,
    maxRetries: 1,
    handler: publish,
  };
}

/** guild-roster-sync: reconcile the Hypixel guild roster against ours. */
export function defineRosterSyncJob(sync: () => Promise<number>): JobDefinition<number> {
  return {
    name: "guild-roster-sync",
    queue: "progression",
    lockKey: "lock:job:roster",
    lockTtlMs: 5 * 60_000,
    maxRetries: 2,
    handler: sync,
  };
}

/**
 * guild-scan: refresh the in-game roster cache and the GEXP series.
 *
 * A long lock because it is one Hypixel call plus a bounded batch of Mojang
 * lookups per guild, and a single retry because the cache is a 6-hour rolling
 * window — a run that fails has hours before anything downstream notices, and
 * the next run recomputes the same state from scratch.
 */
export function defineGuildScanJob(scan: () => Promise<number>): JobDefinition<number> {
  return {
    name: "guild-scan",
    queue: "progression",
    lockKey: "lock:job:guild-scan",
    lockTtlMs: 10 * 60_000,
    maxRetries: 1,
    handler: scan,
  };
}

/**
 * discord-member-sync: mirror each server's Discord roster into our tables.
 *
 * Short lock and two retries: the work is one HTTP call to the admin bot plus a
 * batched upsert per guild, so a failed run is cheap to repeat, and the two
 * hours until the next scheduled one is a long time for the member page to be
 * showing a roster that predates a raid or a purge.
 */
export function defineDiscordMemberSyncJob(sync: () => Promise<number>): JobDefinition<number> {
  return {
    name: "discord-member-sync",
    queue: "progression",
    lockKey: "lock:job:discord-member-sync",
    lockTtlMs: 3 * 60_000,
    maxRetries: 2,
    handler: sync,
  };
}

/**
 * punishment-expiry: clear the `active` flag on mutes and bans whose duration
 * has run out.
 *
 * Enforcement itself needs nothing from this job — a Discord timeout lifts on
 * Discord's clock and the Redis mirror on its TTL. What expires without help is
 * the *record*: the audit tables would otherwise keep listing a member as muted
 * long after the mute stopped, which is what staff read when deciding whether
 * somebody is already being punished. Runs in the workers process rather than
 * the admin bot precisely because it needs no gateway.
 *
 * Idempotent, so retries are free. Returns the number of rows cleared.
 */
export function definePunishmentExpiryJob(sweep: () => Promise<number>): JobDefinition<number> {
  return {
    name: "punishment-expiry",
    queue: "safety",
    lockKey: "lock:job:punishment-expiry",
    lockTtlMs: 60_000,
    maxRetries: 3,
    handler: sweep,
  };
}

/**
 * ticket-sweep: warn quiet tickets and close the ones nobody came back to.
 *
 * Runs here rather than on a timer inside the bridge bot for the same reason
 * every other recurring job does: the lock, the retry policy and the run log
 * live in this process, and a bot that sweeps on its own `setInterval` sweeps
 * twice the moment a second replica starts.
 *
 * Two retries, because each ticket is decided independently and re-running the
 * pass simply re-examines whatever the failed attempt did not reach.
 */
export function defineTicketSweepJob(sweep: () => Promise<number>): JobDefinition<number> {
  return {
    name: "ticket-sweep",
    queue: "community",
    lockKey: "lock:job:ticket-sweep",
    lockTtlMs: 5 * 60_000,
    maxRetries: 2,
    handler: sweep,
  };
}

/** inactivity-scan: flag members who look inactive. Advisory only, never a kick. */
export function defineInactivityScanJob(scan: () => Promise<number>): JobDefinition<number> {
  return {
    name: "inactivity-scan",
    queue: "progression",
    lockKey: "lock:job:inactivity",
    lockTtlMs: 5 * 60_000,
    maxRetries: 2,
    handler: scan,
  };
}

/**
 * analytics-ingest: drain the Redis event buffer into Postgres.
 *
 * The most retry-tolerant job here: persist-then-ack means a retry can at worst
 * duplicate a batch, and rollups are recomputed from scratch anyway.
 */
export function defineAnalyticsIngestJob(ingest: () => Promise<number>): JobDefinition<number> {
  return {
    name: "analytics-ingest",
    queue: "analytics",
    lockKey: "lock:job:analytics-ingest",
    lockTtlMs: 120_000,
    maxRetries: 3,
    handler: ingest,
  };
}

/** config-cache-invalidation: backstop eviction for guilds whose config changed. */
export function defineConfigInvalidationJob(sweep: () => Promise<number>): JobDefinition<number> {
  return {
    name: "config-cache-invalidation",
    queue: "safety",
    lockKey: "lock:job:config-invalidate",
    lockTtlMs: 60_000,
    maxRetries: 2,
    handler: sweep,
  };
}

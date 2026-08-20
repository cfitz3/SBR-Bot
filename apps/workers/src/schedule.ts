/**
 * The repeatable-job schedule. Kept out of `main.ts` so it can be asserted
 * against the job registry in a test — a cadence for a job that does not exist
 * (or a job with no cadence) is silent in production and obvious here.
 */

/**
 * Priority lanes (WORKERS.md §3). BullMQ treats *lower* as more urgent, so a
 * live-serving refresh outranks a bulk backfill when both are waiting.
 */
export const LANE = {
  /** Freshness users see directly in a command reply. */
  live: 1,
  /** Time-sensitive but not price data — event state, reminders, stream drain. */
  timely: 3,
  /** Bulk and reference work; may wait behind anything above. */
  bulk: 6,
} as const;

export interface ScheduleEntry {
  readonly name: string;
  readonly repeat: { every: number } | { pattern: string };
  readonly priority: number;
  /** Run once at boot as well, for jobs whose output is served cold. */
  readonly warm?: boolean;
}

/**
 * Cadences follow WORKERS.md §1–§3. Two rules shape every cron below:
 *
 * - **Off-minute.** Nothing fires on :00 or :30. Those are where every cron on
 *   every host in the world lands, and a thundering herd hurts our database and
 *   our Hypixel budget at exactly the same instant.
 * - **Cost-proportional spacing.** A bazaar refresh is one upstream call; a full
 *   AH sweep is hundreds and a snapshot pass is one per tracked member. The
 *   expensive ones are deliberately far apart, because the entire reason they
 *   run here is to keep that cost off the command path.
 */
export const SCHEDULE: readonly ScheduleEntry[] = [
  // ── live lane: what a command reply is reading ──
  { name: "heartbeat", repeat: { every: 5_000 }, priority: LANE.live, warm: true },
  { name: "bazaar-refresh", repeat: { every: 120_000 }, priority: LANE.live, warm: true },
  { name: "ah-sweep", repeat: { every: 300_000 }, priority: LANE.live, warm: true },
  // Ended auctions are a rolling 60-minute window upstream, so a 90s cadence
  // re-reads mostly-seen data — dedup by auction id makes that free, and the
  // overlap is what stops a slow run from punching a hole in the sale history.
  { name: "ah-ended-ingest", repeat: { every: 90_000 }, priority: LANE.live, warm: true },

  // ── timely lane: state that users are waiting on, but not prices ──
  // Off-minute /3: 1,4,7,…,58 — never :00 or :30.
  { name: "event-transition", repeat: { pattern: "1-59/3 * * * *" }, priority: LANE.timely },
  // Off-minute /5: 2,7,12,…,57.
  { name: "reminder-dispatch", repeat: { pattern: "2-59/5 * * * *" }, priority: LANE.timely },
  // The stream drain is continuous in spirit; 15s is close enough that the
  // buffer never grows, without a permanently blocked consumer.
  { name: "analytics-ingest", repeat: { every: 15_000 }, priority: LANE.timely },
  // Off-minute /5: 3,8,13,…,58. In the timely lane rather than bulk because
  // what it clears is what staff read to decide whether somebody is already
  // being punished — five minutes of "still muted" after a mute ended is a
  // wrong answer to a question people act on.
  { name: "punishment-expiry", repeat: { pattern: "3-59/5 * * * *" }, priority: LANE.timely },
  // Off-minute /7: 4,11,18,…,53. The reconcile safety net for config writes
  // that already publish their own invalidation.
  { name: "config-cache-invalidation", repeat: { pattern: "4-59/7 * * * *" }, priority: LANE.timely },

  // Off-minute /6: 5,11,17,…,53. Timely rather than bulk because both of its
  // outcomes are things a member sees: a warning that arrives late is a ticket
  // closed with no notice, and a close that arrives late is a channel sitting
  // open past the window the guild configured.
  { name: "ticket-sweep", repeat: { pattern: "5-59/6 * * * *" }, priority: LANE.timely },
  // Half-hourly, off the half hour: the boards are only as fresh as the
  // tracker that feeds them, and it polls every thirty minutes by default.
  { name: "event-board", repeat: { pattern: "13,43 * * * *" }, priority: LANE.timely },

  // ── bulk lane: everything that can wait for a token ──
  // Snapshots run twice an hour and take the oldest-captured slice each time,
  // which spreads ~125 members across the documented 6–12h window on its own.
  { name: "profile-snapshot", repeat: { pattern: "7,37 * * * *" }, priority: LANE.bulk },
  // Off-minute /10: 8,18,28,…,58. Bulk because what it actually spends is the
  // Hypixel budget, and ten minutes is fine for a job whose real cadence is the
  // per-event poll interval — the tick only decides how promptly an event whose
  // interval has elapsed gets picked up.
  { name: "event-tracking", repeat: { pattern: "8-59/10 * * * *" }, priority: LANE.bulk },
  // Five minutes behind the snapshot pass, so it compares against rows that
  // exist rather than racing the writer.
  { name: "milestone-detect", repeat: { pattern: "12,42 * * * *" }, priority: LANE.bulk },
  // Daily, in the quiet hour, and mostly a no-op: it exists so a definition
  // added today reflects the members who already satisfy it. `milestone-detect`
  // only reports crossings, so without this a new threshold would stay empty
  // for everyone already past it — forever, not just until they next play.
  { name: "milestone-backfill", repeat: { pattern: "41 4 * * *" }, priority: LANE.bulk },
  { name: "guild-roster-sync", repeat: { pattern: "9,39 * * * *" }, priority: LANE.bulk },
  // Auto-roles. Every fifteen minutes is the promptness floor for somebody who
  // just linked their account; the pass itself is a no-op for any guild whose
  // dirty set is empty, which is most guilds most of the time. Offset from the
  // roster jobs above, whose writes are what usually make members dirty.
  { name: "role-sync", repeat: { pattern: "11-59/15 * * * *" }, priority: LANE.bulk },
  // The in-game roster cache, on the 6-hour cadence its TTL is written against —
  // offset from midnight so a scan lands shortly *before* the cache goes stale
  // rather than at the same instant as every other daily job on the box.
  { name: "guild-scan", repeat: { pattern: "26 1,7,13,19 * * *" }, priority: LANE.bulk },
  // The Discord roster, on the 2-hour cadence the member page is written
  // against. Odd hours and :19 keep it away from the guild scan above and from
  // the roster sync's :09/:39 — three jobs that all walk every guild.
  { name: "discord-member-sync", repeat: { pattern: "19 1,3,5,7,9,11,13,15,17,19,21,23 * * *" }, priority: LANE.bulk },
  { name: "analytics-rollup", repeat: { pattern: "13 * * * *" }, priority: LANE.bulk },
  // Every three hours rather than nightly: a member who asks for their standing
  // should not be told about the person they were yesterday. Not more often than
  // that, because each run rebuilds every balance by reading a guild's whole
  // ledger — cheap at guild scale, but it grows with time, and there is no
  // member-visible difference between "an hour stale" and "three hours stale".
  // 48 past the hour keeps it clear of the roster and snapshot passes.
  { name: "xp-aggregate", repeat: { pattern: "48 */3 * * *" }, priority: LANE.bulk },
  // Daily, at hours nobody is playing and nothing else is scheduled.
  { name: "resources-refresh", repeat: { pattern: "17 4 * * *" }, priority: LANE.bulk },
  { name: "inactivity-scan", repeat: { pattern: "23 5 * * *" }, priority: LANE.bulk },
];

/**
 * The subset of a BullMQ queue that reconciliation needs. Narrowed to a port so
 * the reconcile logic can be asserted against a fake — the alternative is a live
 * Redis in the test, which is how this drift went unnoticed in the first place.
 */
export interface RepeatableQueue {
  getRepeatableJobs(): Promise<Array<{ key: string; name: string; pattern?: string | null; every?: string | null }>>;
  removeRepeatableByKey(key: string): Promise<boolean>;
  add(
    name: string,
    data: Record<string, never>,
    opts: { repeat: { every: number } | { pattern: string }; jobId: string; priority: number },
  ): Promise<unknown>;
}

/** Identity of a repeatable for comparison: its name plus its cadence. */
export function repeatSignature(
  name: string,
  repeat: { every: number } | { pattern: string },
): string {
  return "pattern" in repeat ? `${name}:cron:${repeat.pattern}` : `${name}:every:${repeat.every}`;
}

/**
 * Make the registered repeatables match SCHEDULE exactly.
 *
 * `queue.add({repeat})` only ever adds. BullMQ derives the repeat key from the
 * job's name and options, so editing a cadence — or adding a `priority`, which
 * is what happened here — mints a *new* repeatable and leaves the old one
 * running. Both then fire, silently: each is a legitimate registered job,
 * nothing warns, and the only symptom is a job running more often than its file
 * says. A stale five-second `bazaar-refresh` survived that way and was hitting
 * Hypixel 24x more often than this schedule specifies.
 *
 * Removing first and re-adding is the direction that actually converges: it also
 * clears jobs dropped from the schedule entirely, which no amount of adding will.
 *
 * Every existing repeatable is cleared, not just the ones that look wrong. The
 * first attempt at this kept entries whose name and cadence already matched, and
 * still left a duplicate behind: BullMQ's repeat key covers more than those two
 * fields (jobId, timezone, end date), so an entry registered before this function
 * started passing `jobId` hashed differently while comparing as identical, and
 * `bazaar-refresh` ended up registered twice at the same cadence — firing twice
 * per period with nothing in the logs to say so. Matching on a reconstruction of
 * someone else's key is a guess; clearing unconditionally is not. The schedule
 * below is small and fully declared in this file, so there is nothing to
 * preserve, and re-adding immediately means the gap is a few milliseconds.
 */
export async function reconcileSchedule(
  queue: RepeatableQueue,
  log: { info(msg: string, fields?: Record<string, unknown>): void; warn(msg: string, fields?: Record<string, unknown>): void },
  schedule: readonly ScheduleEntry[] = SCHEDULE,
): Promise<{ scheduled: number; removed: number }> {
  const wanted = new Set(schedule.map((e) => repeatSignature(e.name, e.repeat)));

  let removed = 0;
  for (const job of await queue.getRepeatableJobs()) {
    await queue.removeRepeatableByKey(job.key);
    removed += 1;
    // Worth a warning only when the entry has no counterpart in the file at all
    // — that is drift an operator should know about. Clearing an entry we are
    // about to re-add one line later is bookkeeping, not news.
    const cadence = job.pattern ? { pattern: job.pattern } : { every: Number(job.every ?? 0) };
    if (!wanted.has(repeatSignature(job.name, cadence))) {
      log.warn("removed stale repeatable", { name: job.name, pattern: job.pattern, every: job.every });
    }
  }

  for (const entry of schedule) {
    await queue.add(entry.name, {}, { repeat: entry.repeat, jobId: entry.name, priority: entry.priority });
  }

  log.info("schedule reconciled", { scheduled: schedule.length, removed });
  return { scheduled: schedule.length, removed };
}

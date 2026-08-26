/**
 * `event-tracking` — turning a scheduled event into a scored competition.
 *
 * The measurement is a difference, not a reading: a member's score is what they
 * gained *during* the event, so the first pass after it goes LIVE records a
 * baseline and every pass after that records the distance from it. That is the
 * whole idea, and it is why the baseline is written once and never touched
 * again — recapturing it would silently reset everyone's score to zero.
 *
 * **Two rows per participant per event, and only two.** A baseline and a final,
 * both keyed `(account, event, source)` so the database refuses a third. Earlier
 * versions of this job appended a row every ten minutes, which is the stat
 * history the Hypixel Developer API Policy prohibits (docs/HYPIXEL_COMPLIANCE.md
 * §1). The intermediate readings are gone; the final is overwritten in place on
 * each pass, so whichever pass runs last before the event completes *is* the
 * final without anything having to know it was the last one.
 *
 * Polling is deliberately narrow. Only LIVE events with metrics are polled, and
 * within them only the members who said they were coming, because the Hypixel
 * budget is shared with every other job in the fleet and an event nobody
 * RSVP'd to must not cost the guild its refreshes. `refreshProfiles` does the
 * fetching — the same function the bulk cadence uses — so there is one
 * profile-read path rather than two that drift, and one per-player claim.
 */
import {
  refreshProfiles,
  type ProfileReading,
  type SnapshotMetrics,
  type SnapshotWrite,
  type TrackedAccount,
} from "./progression.js";

/**
 * The floor under any event's configured poll interval.
 *
 * A guild may set a shorter one in the panel; it is clamped here rather than
 * rejected there, so a value stored before this floor existed cannot poll under
 * it. One hour is the per-player cap the policy sets, and an event's cohort is
 * made of players like any other read.
 */
export const EVENT_POLL_FLOOR_MINUTES = 60;

export const EVENT_METRICS = [
  "skyblockLevel",
  "networth",
  "skillAverage",
  "catacombsLevel",
  "slayerXp",
  "senitherWeight",
] as const;

export type EventMetric = (typeof EVENT_METRICS)[number];

export function isEventMetric(value: string): value is EventMetric {
  return (EVENT_METRICS as readonly string[]).includes(value);
}

export interface TrackableEvent {
  readonly id: string;
  readonly guildId: string;
  /** Metric keys. Anything unrecognised is ignored rather than failing the event. */
  readonly trackedMetrics: readonly string[];
  readonly pollIntervalMinutes: number;
}

/** A participant, already resolved to the Minecraft account behind the RSVP. */
export interface EventParticipant extends TrackedAccount {
  readonly discordId: string;
}

export interface EventScoreWrite {
  readonly eventId: string;
  readonly discordId: string;
  readonly uuid: string;
  readonly metric: EventMetric;
  readonly value: number;
}

export interface EventTrackingDeps {
  /** LIVE events that track at least one metric. */
  listLiveTracked(): Promise<readonly TrackableEvent[]>;
  /**
   * Participants who RSVP'd GOING *and* have a linked account.
   *
   * The unlinked are absent rather than represented as zero: a member with no
   * account has no baseline, and a zero would put them at the bottom of a
   * leaderboard they never entered. The panel shows them as an unlinked warning
   * list, which is the honest place for that fact.
   */
  listParticipants(eventId: string): Promise<readonly EventParticipant[]>;
  capture(account: TrackedAccount): Promise<{ profileId: string; metrics: SnapshotMetrics } | null>;
  /** The same current-reading upsert the bulk refresh uses. */
  write(reading: ProfileReading): Promise<void>;
  /**
   * Records where a participant started. Write-once: a second call for the same
   * participant and event is a no-op, not an overwrite. The unique constraint on
   * `(account, event, source)` is what actually guarantees that, so a racing
   * second worker cannot move somebody's starting line either.
   */
  writeBaseline(snapshot: SnapshotWrite): Promise<void>;
  /**
   * Records where a participant currently stands, overwriting the previous
   * answer. When the event completes, whatever this last held is the final.
   */
  writeFinal(snapshot: SnapshotWrite): Promise<void>;
  /** Records the reading. Baselines are set on first write and never after. */
  upsertScore(write: EventScoreWrite): Promise<void>;
  /** Reported rather than thrown: one bad event must not end the pass. */
  onError(scope: string, error: unknown): void;
  /**
   * Take exclusive hold of one event's poll, returning a release or `null` when
   * somebody else already holds it.
   *
   * The job's own lock is not enough on its own. It is global to the job and
   * carries a ten-minute TTL, and a pass over several live events with dozens
   * of participants each can outlive that — at which point the next tick starts
   * while the previous one is still working, and two passes score the same
   * roster at once. This narrows the mutual exclusion to the event, which is
   * the unit that actually conflicts, and the TTL is sized to the event's own
   * interval so a worker that dies mid-pass frees the event rather than
   * stranding it.
   *
   * Optional: a caller with no Redis (tests, a single-process embedding) polls
   * unclaimed, which is the behaviour this job had before the claim existed.
   */
  claimPoll?(eventId: string, ttlSeconds: number): Promise<(() => Promise<void>) | null>;
  now?: () => Date;
}

/**
 * Poll every live tracked event. Returns how many score rows were written.
 *
 * The per-event poll interval is enforced by `refreshProfiles`' own "read
 * recently" filter rather than by a separate clock, so a participant in two
 * events at once is fetched once and scored twice — which is the point of
 * routing both through the same read.
 */
export async function trackEvents(deps: EventTrackingDeps): Promise<number> {
  let written = 0;

  let events: readonly TrackableEvent[];
  try {
    events = await deps.listLiveTracked();
  } catch (error) {
    deps.onError("event list", error);
    return 0;
  }

  for (const event of events) {
    const metrics = event.trackedMetrics.filter(isEventMetric);
    if (metrics.length === 0) continue;

    const intervalMinutes = Math.max(EVENT_POLL_FLOOR_MINUTES, event.pollIntervalMinutes);
    // Claimed before the participant read, so a duplicate pass costs one Redis
    // round trip rather than a database query and a fan-out of writes.
    const release = deps.claimPoll ? await deps.claimPoll(event.id, intervalMinutes * 60) : async () => {};
    if (release === null) continue;

    try {
      const participants = await deps.listParticipants(event.id);
      if (participants.length === 0) continue;
      const byAccount = new Map(participants.map((p) => [p.minecraftAccountId, p]));

      const boundary = (reading: ProfileReading, source: SnapshotWrite["source"]): SnapshotWrite => ({
        ...reading,
        source,
        eventId: event.id,
        savedBy: null,
        label: null,
      });

      await refreshProfiles({
        listTracked: async () => participants,
        capture: (account) => deps.capture(account),
        write: (reading) => deps.write(reading),
        async onReading(reading) {
          const participant = byAccount.get(reading.minecraftAccountId);
          if (participant === undefined) return;

          // Baseline first, so a participant read for the first time on the
          // pass that also turns out to be the last still has a starting line.
          await deps.writeBaseline(boundary(reading, "EVENT_BASELINE"));
          await deps.writeFinal(boundary(reading, "EVENT_FINAL"));

          for (const metric of metrics) {
            const value = reading[metric];
            // A null reading is a profile that did not report the figure, not a
            // zero. Skipping it leaves the last good score standing rather than
            // dropping the member to the bottom of the board for one bad fetch.
            if (value === null) continue;
            await deps.upsertScore({
              eventId: event.id,
              discordId: participant.discordId,
              uuid: participant.uuid,
              metric,
              value,
            });
            written += 1;
          }
        },
        // Everyone who RSVP'd is in scope. The cohort is bounded by the event's
        // own guest list, so there is no batch to spread across runs.
        batchSize: participants.length,
        minIntervalMs: intervalMinutes * 60_000,
        // One participant's score rows failing must not cost the rest of the
        // roster their pass. The next tick picks them back up; the baseline is
        // write-once, so nothing is lost by having missed a turn.
        onAccountError: (account, error) => deps.onError(`event ${event.id} account ${account.uuid}`, error),
        ...(deps.now === undefined ? {} : { now: deps.now }),
      });
    } catch (error) {
      deps.onError(`event ${event.id}`, error);
    } finally {
      await release().catch((error) => deps.onError(`event ${event.id} release`, error));
    }
  }

  return written;
}

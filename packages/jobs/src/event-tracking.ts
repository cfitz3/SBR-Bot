/**
 * `event-tracking` — turning a scheduled event into a scored competition.
 *
 * The measurement is a difference, not a reading: a member's score is what they
 * gained *during* the event, so the first poll after it goes LIVE records a
 * baseline and every poll after that records the distance from it. That is the
 * whole idea, and it is why the baseline is written once and never touched
 * again — recapturing it would silently reset everyone's score to zero.
 *
 * Polling is deliberately narrow. Only LIVE events with metrics are polled, and
 * within them only the members who said they were coming, because the Hypixel
 * budget is shared with every other job in the fleet and an event nobody
 * RSVP'd to must not cost the guild its snapshots. `snapshotProfiles` does the
 * fetching — the same function the bulk cadence uses, with `EVENT_TRACKED` as
 * its source — so there is one profile-capture path rather than two that drift.
 */
import { snapshotProfiles, type SnapshotMetrics, type SnapshotWrite, type TrackedAccount } from "./progression.js";

/**
 * What an event can be scored on.
 *
 * These are exactly the fields a snapshot records, and deliberately not a
 * superset: a metric offered in the panel that no capture writes would leave a
 * leaderboard permanently empty with nothing to point at as the cause.
 */
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
  writeSnapshot(snapshot: SnapshotWrite): Promise<void>;
  /** Records the reading. Baselines are set on first write and never after. */
  upsertScore(write: EventScoreWrite): Promise<void>;
  /** Reported rather than thrown: one bad event must not end the pass. */
  onError(scope: string, error: unknown): void;
  now?: () => Date;
}

/**
 * Poll every live tracked event. Returns how many score rows were written.
 *
 * The per-event poll interval is enforced by `snapshotProfiles`' own
 * "captured recently" filter rather than by a separate clock, so a participant
 * in two events at once is fetched once and scored twice — which is the point
 * of routing both through the same capture.
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

    try {
      const participants = await deps.listParticipants(event.id);
      if (participants.length === 0) continue;
      const byAccount = new Map(participants.map((p) => [p.minecraftAccountId, p]));

      await snapshotProfiles({
        listTracked: async () => participants,
        capture: (account) => deps.capture(account),
        write: (snapshot) => deps.writeSnapshot(snapshot),
        async onSnapshot(snapshot) {
          const participant = byAccount.get(snapshot.minecraftAccountId);
          if (participant === undefined) return;
          for (const metric of metrics) {
            const value = snapshot[metric];
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
        minIntervalMs: Math.max(1, event.pollIntervalMinutes) * 60_000,
        source: "EVENT_TRACKED",
        eventId: event.id,
        ...(deps.now === undefined ? {} : { now: deps.now }),
      });
    } catch (error) {
      deps.onError(`event ${event.id}`, error);
    }
  }

  return written;
}

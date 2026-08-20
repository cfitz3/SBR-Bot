/**
 * The milestone announcer.
 *
 * The workers detect and record; this posts. The handover is the `announced`
 * flag on the row rather than an event, so a bot that is down during a
 * detection run finds the backlog waiting when it comes back — which a pub/sub
 * message would not survive. Each pass is at-least-once: the flag is flipped
 * *after* the message lands, so a crash mid-post repeats an announcement rather
 * than losing it.
 *
 * The one-pass function takes its Discord side as a callback so it can be
 * tested without a gateway; `startMilestoneAnnouncer` is the thin scheduler
 * around it.
 */
import { renderMilestoneEmbed } from "@sbr/commands-bridge";
import type { Logger } from "@sbr/observability";
import type { EmbedView, MilestoneAnnouncerPort, PendingMilestoneDTO } from "@sbr/shared-types";

/** How many rows one pass will drain. Bounds a cold start after an outage. */
export const MILESTONE_ANNOUNCE_BATCH = 25;
/** How often the sweep runs. Detection is half-hourly; this need not be tighter. */
export const MILESTONE_ANNOUNCE_INTERVAL_MS = 5 * 60_000;

export interface MilestoneAnnouncerDeps {
  readonly milestones: MilestoneAnnouncerPort;
  /** The guild's `milestones` channel binding, or null when none is set. */
  getChannel(guildId: string): Promise<string | null>;
  /** Post one announcement. `false` means it did not land and should be retried. */
  post(channelId: string, embed: EmbedView, mentionDiscordId: string | null): Promise<boolean>;
  readonly log: Logger;
}

/**
 * How many times one pass will re-ask for work after excluding a guild it
 * cannot deliver to. Bounds the pass at a handful of queries on a fleet where
 * several guilds are unconfigured at once.
 */
const MAX_FETCHES = 4;

/**
 * Drain up to `limit` pending announcements. Returns how many were posted.
 *
 * A guild with no `milestones` channel keeps its rows unannounced. They are the
 * guild's achievements — throwing them away to keep a queue tidy would mean the
 * day somebody finally binds a channel, the backlog it was waiting for is gone.
 * The Health page reports the count (`WEB_PANEL.md §3.11`), so the fix is
 * visible rather than buried in a log line.
 *
 * Head-of-line blocking is avoided by asking again without that guild rather
 * than by consuming its rows: the queue is read oldest-first across the fleet,
 * so an unconfigured guild would otherwise sit at the head of it forever.
 */
export async function announceMilestonesOnce(
  deps: MilestoneAnnouncerDeps,
  limit: number = MILESTONE_ANNOUNCE_BATCH,
): Promise<number> {
  // One channel lookup per guild, not per milestone: a batch is usually one
  // guild's worth, and the binding cannot change mid-pass.
  const channels = new Map<string, string | null>();
  const undeliverable = new Set<string>();
  const posted: string[] = [];
  let waiting = 0;

  for (let fetch = 0; fetch < MAX_FETCHES && posted.length < limit; fetch += 1) {
    const pending = await deps.milestones.listPending(limit - posted.length, [...undeliverable]);
    if (pending.length === 0) break;

    const before = undeliverable.size;
    const round: string[] = [];
    for (const milestone of pending) {
      if (!channels.has(milestone.guildId)) {
        channels.set(milestone.guildId, await deps.getChannel(milestone.guildId).catch(() => null));
      }
      const channelId = channels.get(milestone.guildId) ?? null;
      if (channelId === null) {
        undeliverable.add(milestone.guildId);
        waiting += 1;
        continue;
      }

      const ok = await deps
        .post(channelId, renderMilestoneEmbed(milestone), milestone.discordId)
        .catch(() => false);
      // A failed post stays pending. The next pass retries it, which is the right
      // behaviour for a transient outage and a visible one for a lasting
      // permissions problem.
      if (ok) round.push(milestone.id);
      else deps.log.warn("milestone announcement did not land", { id: milestone.id, channelId });
    }

    // Flushed per round, not at the end: the next query has to stop returning
    // what this round already posted, and a crash here loses nothing.
    if (round.length > 0) {
      await deps.milestones.markAnnounced(round);
      posted.push(...round);
    }

    // Nothing new was excluded, so asking again would return the same rows.
    if (undeliverable.size === before) break;
  }

  if (waiting > 0) {
    deps.log.info("milestones waiting on a channel", {
      seen: waiting,
      guilds: [...undeliverable],
    });
  }

  return posted.length;
}

export interface AnnouncerHandle {
  stop(): void;
}

/**
 * Run the sweep on an interval. The first pass is scheduled rather than
 * immediate: a bot that just started is still resolving its guild cache, and a
 * failed channel fetch would cost the backlog a retry cycle for nothing.
 */
export function startMilestoneAnnouncer(
  deps: MilestoneAnnouncerDeps,
  intervalMs: number = MILESTONE_ANNOUNCE_INTERVAL_MS,
): AnnouncerHandle {
  let running = false;
  const timer = setInterval(() => {
    // A slow pass must not overlap the next one — two sweeps in flight would
    // read the same unannounced rows and post them twice.
    if (running) return;
    running = true;
    void announceMilestonesOnce(deps)
      .then((count) => {
        if (count > 0) deps.log.info("milestones announced", { count });
      })
      .catch((error: unknown) => {
        deps.log.error("milestone sweep failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  // The sweep is background work; it must never be the reason the process
  // stays alive.
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/** Exported for the test's convenience — the shape a fake queue must satisfy. */
export type { PendingMilestoneDTO };

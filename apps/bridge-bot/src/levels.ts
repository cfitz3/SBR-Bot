/**
 * The level-up announcer.
 *
 * Same handover as milestones: the workers rebuild balances on their schedule
 * and record every climb they see, and this posts what is waiting. The
 * `announced` flag rather than an event, so a bot that was down for the nightly
 * rebuild still finds the backlog when it returns.
 *
 * The one difference from `milestones.ts` is the opt-out. A level-up is a ping
 * aimed at one person, and some people do not want it; a row belonging to
 * somebody who has opted out is marked announced without being posted, because
 * the alternative is a queue that grows forever with messages nobody will ever
 * receive.
 */
import { renderLevelUpEmbed } from "@sbr/commands-bridge";
import type { Logger } from "@sbr/observability";
import type { EmbedView, LevelUpAnnouncerPort, PendingLevelUpDTO } from "@sbr/shared-types";

/** How many rows one pass will drain. Bounds a cold start after an outage. */
export const LEVEL_ANNOUNCE_BATCH = 25;
/** Rebuilds are nightly; a five-minute sweep is already far tighter than the source. */
export const LEVEL_ANNOUNCE_INTERVAL_MS = 5 * 60_000;

export interface LevelAnnouncerDeps {
  readonly levels: LevelUpAnnouncerPort;
  /** The guild's `levels` channel binding, or null when none is set. */
  getChannel(guildId: string): Promise<string | null>;
  /** The Discord ids in this guild who have asked not to be announced. */
  mutedIds(guildId: string): Promise<ReadonlySet<string>>;
  /** Post one announcement. `false` means it did not land and should be retried. */
  post(channelId: string, embed: EmbedView, mentionDiscordId: string): Promise<boolean>;
  readonly log: Logger;
}

/** Bounds one pass on a fleet where several guilds are unconfigured at once. */
const MAX_FETCHES = 4;

/**
 * Drain up to `limit` pending level-ups. Returns how many were posted.
 *
 * A guild with no `levels` channel keeps its rows: this feature is opt-in by
 * channel, and an operator who binds one later should not have to explain why
 * the first week of it is missing. Head-of-line blocking is avoided the same
 * way milestones avoid it — by asking again without that guild rather than by
 * consuming its rows.
 */
export async function announceLevelUpsOnce(
  deps: LevelAnnouncerDeps,
  limit: number = LEVEL_ANNOUNCE_BATCH,
): Promise<number> {
  const channels = new Map<string, string | null>();
  const muted = new Map<string, ReadonlySet<string>>();
  const undeliverable = new Set<string>();
  const posted: string[] = [];
  let waiting = 0;
  let skipped = 0;

  for (let fetch = 0; fetch < MAX_FETCHES && posted.length < limit; fetch += 1) {
    const pending = await deps.levels.listPending(limit - posted.length, [...undeliverable]);
    if (pending.length === 0) break;

    const before = undeliverable.size;
    const round: string[] = [];
    for (const levelUp of pending) {
      if (!channels.has(levelUp.guildId)) {
        channels.set(levelUp.guildId, await deps.getChannel(levelUp.guildId).catch(() => null));
        muted.set(levelUp.guildId, await deps.mutedIds(levelUp.guildId).catch(() => new Set<string>()));
      }
      const channelId = channels.get(levelUp.guildId) ?? null;
      if (channelId === null) {
        undeliverable.add(levelUp.guildId);
        waiting += 1;
        continue;
      }

      // Cleared, not posted. The XP and the level are still theirs; only the
      // announcement was declined.
      if (muted.get(levelUp.guildId)?.has(levelUp.discordId) === true) {
        round.push(levelUp.id);
        skipped += 1;
        continue;
      }

      const ok = await deps
        .post(channelId, renderLevelUpEmbed(levelUp), levelUp.discordId)
        .catch(() => false);
      if (ok) round.push(levelUp.id);
      else deps.log.warn("level-up announcement did not land", { id: levelUp.id, channelId });
    }

    if (round.length > 0) {
      await deps.levels.markAnnounced(round);
      // Only the ones that were actually sent count towards the limit; a batch
      // of opt-outs must not end a pass that has done no work.
      posted.push(...round);
    }

    if (undeliverable.size === before) break;
  }

  if (waiting > 0) {
    deps.log.info("level-ups waiting on a channel", { seen: waiting, guilds: [...undeliverable] });
  }
  if (skipped > 0) deps.log.info("level-ups skipped by opt-out", { count: skipped });

  return posted.length - skipped;
}

export interface LevelAnnouncerHandle {
  stop(): void;
}

/** Run the sweep on an interval. Scheduled first pass, for the same reason as milestones. */
export function startLevelAnnouncer(
  deps: LevelAnnouncerDeps,
  intervalMs: number = LEVEL_ANNOUNCE_INTERVAL_MS,
): LevelAnnouncerHandle {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void announceLevelUpsOnce(deps)
      .then((count) => {
        if (count > 0) deps.log.info("level-ups announced", { count });
      })
      .catch((error: unknown) => {
        deps.log.error("level-up sweep failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/** Exported for the test's convenience — the shape a fake queue must satisfy. */
export type { PendingLevelUpDTO };
